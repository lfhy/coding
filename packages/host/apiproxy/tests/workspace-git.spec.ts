import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { gitCredentialRef, parseGitHistory, parseGitHistoryRefs, workspaceGitBranches, workspaceGitCheckout, workspaceGitHistory, workspaceGitPull, workspaceGitPush, workspaceGitStatus } from '../src/workspace-git.ts'
import type { GitCredentialStore } from '../src/workspace-git.ts'

const roots: string[] = []
const signal = new AbortController().signal
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-git-test-'))
  roots.push(root)
  return root
}
function repo() {
  const root = temp()
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.org')
  git(root, 'config', 'user.name', 'Git Test')
  writeFileSync(join(root, 'tracked.txt'), 'first\n')
  git(root, 'add', 'tracked.txt')
  git(root, 'commit', '-qm', 'initial')
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  for (const remote of remotes.splice(0)) remote.close()
})

/** 一组 Basic 凭据对应的请求头值。 */
function basic(credentials: string): string {
  return 'Basic ' + Buffer.from(credentials).toString('base64')
}

/** pkt-line 编码，智能 HTTP 的广告以它开头。 */
function pktLine(payload: string): Buffer {
  const length = Buffer.byteLength(payload) + 4
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), Buffer.from(payload)])
}

/**
 * 用一份空的全局配置运行用例：开发机上配置的凭据助手（keychain、store 等）不得参与
 * 判定，只有用例自己写进仓库的助手生效。
 */
async function withIsolatedGitConfig<T>(run: () => Promise<T>): Promise<T> {
  const empty = join(temp(), 'gitconfig')
  writeFileSync(empty, '')
  const previous = { nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL }
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = empty
  try {
    return await run()
  } finally {
    if (previous.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previous.nosystem
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous.global
  }
}

/** 记录读写的本机凭据存储替身；值、可写性与两个失败开关都由用例控制。 */
function memoryStore(initial?: string) {
  const reads: CredentialRef[] = []
  const writes: Array<{ ref: CredentialRef; value: string }> = []
  let value = initial
  let writable = true
  let readError: unknown
  let writeError: unknown
  const store: GitCredentialStore = {
    read: async (ref) => {
      reads.push(ref)
      if (readError !== undefined) throw readError
      return value
    },
    writable: async () => writable,
    write: async (ref, next) => {
      if (writeError !== undefined) throw writeError
      writes.push({ ref, value: next })
    },
  }
  return {
    store, reads, writes,
    setValue(next: string | undefined) { value = next },
    setWritable(next: boolean) { writable = next },
    rejectReads(reason: unknown) { readError = reason },
    rejectWrites(reason: unknown) { writeError = reason },
  }
}

/** 本机存储里一组凭据的编码形式，与 workspace-git 写入的格式一致。 */
function storedValue(host: string, username: string, password: string): string {
  return JSON.stringify({ host, username, password })
}

/** 智能远端的失败模式：整体不可用、只在认证通过后失败，或正常工作。 */
type RemoteFailure = 'none' | 'always' | 'authenticated'

interface SmartRemote {
  /** 不含用户信息的 HTTPS URL，作为仓库的 remote。 */
  url: string
  /** URL.host，即凭据引用的来源与错误细节里的 remote 域名。 */
  host: string
  /** 每次请求携带的 Authorization 头；未认证的请求为 undefined。 */
  authorizations: Array<string | undefined>
  close: () => void
}

const remotes: SmartRemote[] = []

/**
 * 只接受一组 Basic 凭据的智能 HTTP 远端，用 git 自己的 upload-pack／receive-pack 服务
 * 真实仓库：认证通过后 pull 与 push 会真正完成，而不只是判定认证结果。
 */
async function smartRemote(repository: string, accepted = 'alice:private-token', failure: RemoteFailure = 'none'): Promise<SmartRemote> {
  const key = join(repository, 'server.key')
  const certificate = join(repository, 'server.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', certificate, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const authorizations: Array<string | undefined> = []
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    authorizations.push(request.headers.authorization)
    if (failure === 'always') {
      response.writeHead(500)
      response.end('remote unavailable')
      return
    }
    if (request.headers.authorization !== basic(accepted)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' })
      response.end('authorization required')
      return
    }
    if (failure === 'authenticated') {
      response.writeHead(500)
      response.end('remote unavailable')
      return
    }
    const url = new URL(request.url ?? '/', 'https://remote.invalid')
    const pushing = url.searchParams.get('service') === 'git-receive-pack' || url.pathname.endsWith('/git-receive-pack')
    const service = pushing ? 'receive-pack' : 'upload-pack'
    if (url.pathname.endsWith('/info/refs')) {
      const advertisement = execFileSync('git', [service, '--stateless-rpc', '--advertise-refs', repository])
      response.writeHead(200, { 'content-type': 'application/x-git-' + service + '-advertisement' })
      response.end(Buffer.concat([pktLine('# service=git-' + service + '\n'), Buffer.from('0000'), advertisement]))
      return
    }
    response.writeHead(200, { 'content-type': 'application/x-git-' + service + '-result' })
    const child = spawn('git', [service, '--stateless-rpc', repository])
    child.on('error', () => { response.end() })
    request.pipe(child.stdin)
    child.stdout.pipe(response)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing HTTPS address')
  const host = '127.0.0.1:' + String(address.port)
  return {
    url: 'https://' + host + '/private.git',
    host,
    authorizations,
    close: () => { server.close() },
  }
}

/** 建一个以智能远端为上游的仓库；种子推送用带用户信息的 URL，仓库配置里保留干净 URL。 */
async function upstreamRepo(accepted = 'alice:private-token', failure: RemoteFailure = 'none') {
  const root = repo()
  const bare = temp()
  git(bare, 'init', '--bare', '-q')
  const remote = await smartRemote(bare, accepted, failure)
  remotes.push(remote)
  const branch = git(root, 'branch', '--show-current')
  git(root, 'config', 'http.sslVerify', 'false')
  git(root, 'remote', 'add', 'origin', remote.url)
  git(root, 'config', 'branch.' + branch + '.remote', 'origin')
  git(root, 'config', 'branch.' + branch + '.merge', 'refs/heads/' + branch)
  // 种子推送直接对本机裸库执行：同步 git 会阻塞测试进程的事件循环，不能经由本进程内的 HTTPS 服务。
  git(root, 'push', '-q', bare, branch + ':refs/heads/' + branch)
  git(root, 'update-ref', 'refs/remotes/origin/' + branch, 'HEAD')
  return { root, remote, branch, host: remote.host, ref: gitCredentialRef(remote.host) }
}

describe('standalone workspace Git', () => {
  it('returns null outside a repository and rejects write operations', async () => {
    const root = temp()
    expect(await workspaceGitStatus(root, signal)).toBeNull()
    expect(await workspaceGitBranches(root, signal)).toBeNull()
    await expect(workspaceGitCheckout(root, signal, 'main')).rejects.toMatchObject({ code: 'GIT_NO_REPOSITORY' })
    await expect(workspaceGitPush(root, signal)).rejects.toMatchObject({ code: 'GIT_NO_REPOSITORY' })
    await expect(workspaceGitPull(root, signal)).rejects.toMatchObject({ code: 'GIT_NO_REPOSITORY' })
  })

  it('returns a complete status for a newly initialized repository before its first commit', async () => {
    const root = temp()
    git(root, 'init', '-q')
    writeFileSync(join(root, 'first.txt'), 'one\ntwo\n')
    git(root, 'add', 'first.txt')
    writeFileSync(join(root, 'first.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(root, 'new.txt'), 'fresh\n')
    const status = await workspaceGitStatus(root, signal)
    expect(status).toMatchObject({ additions: 4, deletions: 0 })
    expect(status?.files).toEqual(expect.arrayContaining([
      { path: 'first.txt', status: 'AM', additions: 3, deletions: 0 },
      { path: 'new.txt', status: '??', additions: 1, deletions: 0 },
    ]))
  })

  it('reports tracked edits and untracked lines without counting ignored files', async () => {
    const root = repo()
    writeFileSync(join(root, '.gitignore'), 'secret.txt\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-qm', 'ignore')
    writeFileSync(join(root, 'tracked.txt'), 'first\nsecond\n')
    writeFileSync(join(root, 'new.txt'), 'one\ntwo\n')
    writeFileSync(join(root, 'secret.txt'), 'secret\n')
    const status = await workspaceGitStatus(root, signal)
    expect(status).toMatchObject({ ahead: 0, behind: 0, additions: 3, deletions: 0 })
    expect(status?.files).toEqual(expect.arrayContaining([
      { path: 'tracked.txt', status: ' M', additions: 1, deletions: 0 },
      { path: 'new.txt', status: '??', additions: 2, deletions: 0 },
    ]))
    expect(status?.files.some(file => file.path === 'secret.txt')).toBe(false)
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toContain('new.txt')
  })

  it('resolves untracked files from the repository root for nested session cwd', async () => {
    const root = repo()
    const nested = join(root, 'nested')
    mkdirSync(nested)
    writeFileSync(join(root, 'outside.txt'), 'outside\n')
    writeFileSync(join(nested, 'inside.txt'), 'inside\n')
    const status = await workspaceGitStatus(nested, signal)
    expect(status?.files).toEqual(expect.arrayContaining([
      { path: 'outside.txt', status: '??', additions: 1, deletions: 0 },
      { path: 'nested/inside.txt', status: '??', additions: 1, deletions: 0 },
    ]))
  })

  it('attributes rename numstat to the destination with subsequent changed files', async () => {
    const root = repo()
    git(root, 'mv', 'tracked.txt', 'renamed.txt')
    writeFileSync(join(root, 'renamed.txt'), 'first\nsecond\n')
    writeFileSync(join(root, 'after.txt'), 'after\n')
    git(root, 'add', 'after.txt')
    const status = await workspaceGitStatus(root, signal)
    expect(status?.files).toEqual(expect.arrayContaining([
      { path: 'renamed.txt', status: 'RM', additions: 2, deletions: 0 },
      { path: 'after.txt', status: 'A ', additions: 1, deletions: 0 },
    ]))
  })

  it('lists local branches and switches only when the working tree is clean', async () => {
    const root = repo()
    const original = git(root, 'branch', '--show-current')
    git(root, 'branch', 'feature')
    git(root, 'branch', 'other/nested')
    git(root, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD')
    expect(git(root, 'branch', '-r')).toContain('origin/remote-only')
    expect(await workspaceGitBranches(root, signal)).toEqual({
      branches: ['feature', 'other/nested', original].sort((a, b) => a.localeCompare(b)), current: original,
    })
    await expect(workspaceGitCheckout(root, signal, 'missing')).rejects.toMatchObject({ code: 'GIT_BRANCH_NOT_FOUND' })
    writeFileSync(join(root, 'new.txt'), 'untracked\n')
    await expect(workspaceGitCheckout(root, signal, 'feature')).rejects.toMatchObject({ code: 'GIT_CONFLICT' })
    expect(git(root, 'branch', '--show-current')).toBe(original)
    rmSync(join(root, 'new.txt'))
    expect(await workspaceGitCheckout(root, signal, 'feature')).toMatchObject({ branch: 'feature', files: [] })
    expect(await workspaceGitBranches(root, signal)).toMatchObject({ current: 'feature' })
    git(root, 'checkout', '--detach', '-q')
    expect(await workspaceGitBranches(root, signal)).toMatchObject({ current: null })
    expect(await workspaceGitCheckout(root, signal, original)).toMatchObject({ branch: original })
  })

  it('does not overwrite ignored files when switching to a branch that tracks their path', async () => {
    const root = repo()
    const original = git(root, 'branch', '--show-current')
    git(root, 'switch', '-qc', 'feature')
    writeFileSync(join(root, 'private.txt'), 'branch content\n')
    git(root, 'add', 'private.txt')
    git(root, 'commit', '-qm', 'add private file')
    git(root, 'switch', '-q', original)
    writeFileSync(join(root, '.gitignore'), 'private.txt\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-qm', 'ignore private file')
    writeFileSync(join(root, 'private.txt'), 'local secret\n')
    expect((await workspaceGitStatus(root, signal))?.files).toEqual([])
    await expect(workspaceGitCheckout(root, signal, 'feature')).rejects.toMatchObject({ code: 'GIT_CONFLICT' })
    expect(readFileSync(join(root, 'private.txt'), 'utf8')).toBe('local secret\n')
    expect(git(root, 'branch', '--show-current')).toBe(original)
  })

  it('requires an upstream before staging; explicitly pushes non-ignored changes', async () => {
    const root = repo()
    writeFileSync(join(root, 'new.txt'), 'new\n')
    await expect(workspaceGitPush(root, signal)).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
    expect(git(root, 'ls-files', 'new.txt')).toBe('')
    const remote = temp()
    git(remote, 'init', '--bare', '-q')
    git(root, 'remote', 'add', 'origin', remote)
    const branch = git(root, 'branch', '--show-current')
    git(root, 'push', '-qu', 'origin', branch)
    writeFileSync(join(root, '.gitignore'), 'secret.txt\n')
    writeFileSync(join(root, 'secret.txt'), 'not committed\n')
    const result = await workspaceGitPush(root, signal)
    expect(result).toMatchObject({ branch, commitCreated: true, commit: git(root, 'rev-parse', 'HEAD') })
    expect(git(root, 'log', '-1', '--format=%s')).toMatch(/^Add 2 workspace files \(\+\d+\/-\d+\)$/u)
    expect(git(root, 'ls-files', 'secret.txt')).toBe('')
    expect(git(root, 'ls-files', 'new.txt')).toBe('new.txt')
    expect((await workspaceGitPush(root, signal)).commitCreated).toBe(false)
  })

  it('fast-forwards and refuses divergent histories without creating a merge commit', async () => {
    const root = repo()
    const remote = temp()
    git(remote, 'init', '--bare', '-q')
    git(root, 'remote', 'add', 'origin', remote)
    const branch = git(root, 'branch', '--show-current')
    git(root, 'push', '-qu', 'origin', branch)
    const peer = temp()
    git(peer, 'clone', '-q', remote, '.')
    git(peer, 'config', 'user.email', 'test@example.org')
    git(peer, 'config', 'user.name', 'Git Test')
    writeFileSync(join(peer, 'tracked.txt'), 'peer\n')
    git(peer, 'commit', '-qam', 'peer')
    git(peer, 'push', '-q')
    expect(await workspaceGitPull(root, signal)).toEqual({ branch, commitCreated: false })
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('peer\n')
    writeFileSync(join(root, 'local.txt'), 'local\n')
    git(root, 'add', 'local.txt')
    git(root, 'commit', '-qm', 'local')
    writeFileSync(join(peer, 'tracked.txt'), 'peer two\n')
    git(peer, 'commit', '-qam', 'peer two')
    git(peer, 'push', '-q')
    await expect(workspaceGitPull(root, signal)).rejects.toMatchObject({ code: 'GIT_CONFLICT' })
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('local')
  })

  it('challenges for HTTPS credentials before staging and retries without exposing secrets', async () => {
    const { root, remote, branch } = await upstreamRepo()
    writeFileSync(join(root, 'pending.txt'), 'uncommitted\n')
    // 空存储只提供“没有已保存凭据”这一事实，不会自行认证。
    await expect(workspaceGitPush(root, signal, { store: memoryStore().store })).rejects.toMatchObject({
      code: 'GIT_AUTH_REQUIRED', remote: 'https://' + remote.host,
    })
    expect(git(root, 'status', '--porcelain')).toBe('?? pending.txt')
    // 完全没有凭据存储时同样只报告需要认证。
    await expect(workspaceGitPull(root, signal)).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
    await expect(workspaceGitPull(root, signal, { credentials: { username: 'alice', password: 'wrong' } }))
      .rejects.toMatchObject({ code: 'GIT_AUTH_FAILED' })
    // 正确的显式凭据只出现在一次性 askpass 子进程里，随后远端操作真正完成。
    await expect(workspaceGitPull(root, signal, { credentials: { username: 'alice', password: 'private-token' } }))
      .resolves.toEqual({ branch, commitCreated: false })
  })

  it('prefers the host credential helper and leaves stored credentials untouched', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, remote, branch, host } = await upstreamRepo()
      git(root, 'config', 'credential.helper', '!f() { echo username=alice; echo password=private-token; }; f')
      const memory = memoryStore(storedValue(host, 'alice', 'stale-token'))
      await expect(workspaceGitPull(root, signal, { store: memory.store }))
        .resolves.toEqual({ branch, commitCreated: false })
      expect(memory.reads).toEqual([])
      expect(remote.authorizations).toContain(basic('alice:private-token'))
    })
  })

  it('falls back to stored credentials when the helper has none', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, remote, branch, host, ref } = await upstreamRepo()
      const memory = memoryStore(storedValue(host, 'alice', 'private-token'))
      await expect(workspaceGitPull(root, signal, { store: memory.store }))
        .resolves.toEqual({ branch, commitCreated: false })
      expect(memory.reads).toEqual([ref])
      expect(remote.authorizations).toContain(basic('alice:private-token'))
    })
  })

  it('asks the user and names the stored reference when its credentials are rejected', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, host, ref } = await upstreamRepo()
      const memory = memoryStore(storedValue(host, 'alice', 'stale-token'))
      await expect(workspaceGitPull(root, signal, { store: memory.store })).rejects.toMatchObject({
        code: 'GIT_AUTH_REQUIRED', remote: 'https://' + host, credentialRef: ref,
      })
      expect(memory.reads).toEqual([ref])
    })
  })

  it('saves remembered credentials only after success and reuses them next time', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, remote, branch, host, ref } = await upstreamRepo()
      const memory = memoryStore()
      await expect(workspaceGitPull(root, signal, {
        credentials: { username: 'alice', password: 'private-token', remember: true },
        store: memory.store,
      })).resolves.toEqual({ branch, commitCreated: false })
      expect(memory.writes).toEqual([{ ref, value: storedValue(host, 'alice', 'private-token') }])
      // 下一轮既没有助手也没有显式凭据：只有已保存的凭据能通过认证。
      const reused = memoryStore(memory.writes[0]?.value)
      const before = remote.authorizations.length
      await expect(workspaceGitPull(root, signal, { store: reused.store }))
        .resolves.toEqual({ branch, commitCreated: false })
      expect(reused.reads).toEqual([ref])
      // 匿名首试会留下一次未认证请求，凭据生效的那次必须带上已保存的凭据。
      const after = remote.authorizations.slice(before)
      expect(after).toContain(basic('alice:private-token'))
    })
  })

  it('refuses to remember credentials without a writable store, before touching the remote', async () => {
    const { root, remote } = await upstreamRepo()
    const before = remote.authorizations.length
    await expect(workspaceGitPush(root, signal, {
      credentials: { username: 'alice', password: 'private-token', remember: true },
    })).rejects.toMatchObject({ code: 'GIT_CREDENTIALS_UNAVAILABLE' })
    expect(remote.authorizations.length).toBe(before)
    expect(git(root, 'status', '--porcelain')).toBe('')
    const memory = memoryStore()
    memory.setWritable(false)
    await expect(workspaceGitPull(root, signal, {
      credentials: { username: 'alice', password: 'private-token', remember: true }, store: memory.store,
    })).rejects.toMatchObject({ code: 'GIT_CREDENTIALS_UNAVAILABLE' })
    expect(memory.writes).toEqual([])
  })

  it('keeps a completed pull when the credential write fails', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, branch, host } = await upstreamRepo()
      const memory = memoryStore()
      const warnings: string[] = []
      const options = {
        credentials: { username: 'alice', password: 'private-token', remember: true },
        store: memory.store,
      }
      const warn = (message: string): void => { warnings.push(message) }
      memory.rejectWrites(new Error('disk is full'))
      await expect(workspaceGitPull(root, signal, { ...options, warn }))
        .resolves.toEqual({ branch, commitCreated: false })
      expect(warnings).toEqual(['Git credentials for ' + host + ' were not saved: disk is full'])
      // 存储抛出非 Error 值时同样只记录诊断。
      memory.rejectWrites('quota exceeded')
      await expect(workspaceGitPull(root, signal, { ...options, warn }))
        .resolves.toEqual({ branch, commitCreated: false })
      expect(warnings).toEqual([
        'Git credentials for ' + host + ' were not saved: disk is full',
        'Git credentials for ' + host + ' were not saved: quota exceeded',
      ])
      // 没有诊断出口时同样不改变已经完成的拉取。
      await expect(workspaceGitPull(root, signal, options)).resolves.toEqual({ branch, commitCreated: false })
    })
  })

  it('ignores stored values that are not credentials for this remote', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, host, ref } = await upstreamRepo()
      const memory = memoryStore()
      const warnings: string[] = []
      const ignored = 'Git credentials stored for ' + host + ' were ignored: ' + ref + ' does not hold credentials for this remote'
      for (const value of [
        'not json',
        'null',
        '12',
        JSON.stringify({ host: 'other.example', username: 'alice', password: 'private-token' }),
        JSON.stringify({ host, username: 'alice' }),
      ]) {
        memory.setValue(value)
        warnings.length = 0
        await expect(workspaceGitPull(root, signal, {
          store: memory.store, warn: (message: string) => { warnings.push(message) },
        })).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
        expect(warnings).toEqual([ignored])
        // 没有诊断出口时结果相同。
        await expect(workspaceGitPull(root, signal, { store: memory.store }))
          .rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
      }
    })
  })

  it('reports a remote failure that is not about credentials', async () => {
    // 远端整体不可用：显式凭据与匿名尝试都直接失败，不会提示重新输入凭据。
    const broken = await upstreamRepo('alice:private-token', 'always')
    await expect(workspaceGitPull(broken.root, signal, { credentials: { username: 'alice', password: 'private-token' } }))
      .rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(workspaceGitPull(broken.root, signal)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    // 认证通过后远端才失败：已保存的凭据同样不能把它变成认证提示。
    const failing = await upstreamRepo('alice:private-token', 'authenticated')
    const memory = memoryStore(storedValue(failing.host, 'alice', 'private-token'))
    await expect(workspaceGitPull(failing.root, signal, { store: memory.store }))
      .rejects.toMatchObject({ code: 'GIT_FAILED' })
  })

  it('treats an unreadable store as no stored credentials', async () => {
    await withIsolatedGitConfig(async () => {
      const { root, host, ref } = await upstreamRepo()
      const memory = memoryStore()
      const warnings: string[] = []
      const warn = (message: string): void => { warnings.push(message) }
      memory.rejectReads(new Error('credentials document is unreadable'))
      await expect(workspaceGitPull(root, signal, { store: memory.store, warn }))
        .rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
      expect(warnings).toEqual([
        'Git credentials stored for ' + host + ' could not be read (' + ref + '): credentials document is unreadable',
      ])
      // 存储抛出非 Error 值时同样只记录诊断。
      memory.rejectReads('document is gone')
      await expect(workspaceGitPull(root, signal, { store: memory.store, warn }))
        .rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
      expect(warnings).toHaveLength(2)
      // 没有诊断出口时结果相同。
      await expect(workspaceGitPull(root, signal, { store: memory.store }))
        .rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' })
    })
  })

  it('never offers credential retry or credential storage to HTTP or SSH remotes', async () => {
    const root = repo()
    const branch = git(root, 'branch', '--show-current')
    git(root, 'remote', 'add', 'origin', 'http://localhost:1/private.git')
    git(root, 'config', 'branch.' + branch + '.remote', 'origin')
    git(root, 'config', 'branch.' + branch + '.merge', 'refs/heads/' + branch)
    git(root, 'update-ref', 'refs/remotes/origin/' + branch, 'HEAD')
    const credentials = { username: 'alice', password: 'secret' }
    await expect(workspaceGitPush(root, signal, { credentials })).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
    git(root, 'remote', 'set-url', 'origin', 'https://alice:embedded-secret@localhost:1/private.git')
    await expect(workspaceGitPull(root, signal, { credentials })).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
    git(root, 'remote', 'set-url', 'origin', 'git@example.org:repo.git')
    await expect(workspaceGitPull(root, signal, { credentials })).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
    // 记住凭据只对 HTTPS 远端有意义：其它协议在触碰远端之前就拒绝。
    await expect(workspaceGitPull(root, signal, { credentials: { ...credentials, remember: true } }))
      .rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
  })

  it('reads a bounded commit DAG across local branches, merge parents, and decorated tags', async () => {
    const root = repo()
    const base = git(root, 'rev-parse', 'HEAD')
    const branch = git(root, 'branch', '--show-current')
    git(root, 'switch', '-qc', 'feature')
    writeFileSync(join(root, 'feature.txt'), 'feature\n')
    git(root, 'add', 'feature.txt')
    git(root, 'commit', '-qm', 'feature work')
    const feature = git(root, 'rev-parse', 'HEAD')
    git(root, 'tag', '-a', 'release,v1', '-m', 'annotated tag')
    git(root, 'switch', '-q', branch)
    writeFileSync(join(root, 'main.txt'), 'main\n')
    git(root, 'add', 'main.txt')
    git(root, 'commit', '-qm', 'main work')
    const main = git(root, 'rev-parse', 'HEAD')
    git(root, 'merge', '--no-ff', '--no-edit', '-q', 'feature')
    const merge = git(root, 'rev-parse', 'HEAD')
    git(root, 'branch', 'unused', base)
    git(root, 'update-ref', 'refs/remotes/origin/tracking', feature)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    const history = await workspaceGitHistory(nested, signal)
    expect(history).toMatchObject({ current: branch, branches: ['feature', branch, 'unused'].sort((a, b) => a.localeCompare(b)), truncated: false })
    expect(history?.commits.map(commit => commit.id).sort()).toEqual([merge, main, feature, base].sort())
    const commitById = new Map(history?.commits.map(commit => [commit.id, commit]))
    expect(commitById.get(merge)).toMatchObject({ parents: [main, feature], subject: "Merge branch 'feature'" })
    expect(commitById.get(main)).toMatchObject({ parents: [base], subject: 'main work', refs: [] })
    expect(commitById.get(feature)).toMatchObject({ parents: [base], subject: 'feature work', refs: ['feature', 'origin/tracking', 'tag: release,v1'] })
    expect(commitById.get(merge)?.refs).toEqual([branch])
    expect(commitById.get(base)?.refs).toEqual(['unused'])
    expect(history?.commits.every(commit => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/u.test(commit.authoredAt))).toBe(true)
    expect((await workspaceGitHistory(root, signal, { count: 2 }))?.commits).toHaveLength(2)
    expect((await workspaceGitHistory(root, signal, { count: 2 }))?.truncated).toBe(true)
    expect((await workspaceGitHistory(root, signal, { from: feature }))?.commits.map(commit => commit.id)).toEqual([feature, base])
  })

  it('returns empty commits for an unborn local repo and null outside a repository', async () => {
    const empty = temp()
    git(empty, 'init', '-q')
    const history = await workspaceGitHistory(empty, signal)
    expect(history).toEqual({ commits: [], truncated: false, current: git(empty, 'symbolic-ref', '--short', 'HEAD'), branches: [] })
    expect(await workspaceGitHistory(temp(), signal)).toBeNull()
  })

  it('rejects unsafe revisions and count directly before Git interprets them', async () => {
    const root = repo()
    const head = git(root, 'rev-parse', 'HEAD')
    const status = git(root, 'status', '--porcelain')
    for (const from of ['--all', '-1', 'HEAD', `${head}..HEAD`, `${head}\n--all`, 'a'.repeat(39) + 'z']) {
      await expect(workspaceGitHistory(root, signal, { from })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    }
    for (const count of [0, -1, 301, 1.2, Number.NaN, Infinity]) {
      await expect(workspaceGitHistory(root, signal, { count })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    }
    await expect(workspaceGitHistory(root, signal, { from: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(git(root, 'status', '--porcelain')).toBe(status)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect((await workspaceGitHistory(root, signal, { count: 1 }))?.commits).toHaveLength(1)
    expect((await workspaceGitHistory(root, signal, { count: 300 }))?.truncated).toBe(false)
  })

  it('rejects malformed and oversized history or ref records without partial data', () => {
    const id = 'a'.repeat(40)
    const date = '2025-02-03T04:05:06+00:00'
    const line = [id, '', 'subject', 'Author', date].join('\0') + '\0'
    expect(parseGitHistory(line)).toEqual([{ id, parents: [], subject: 'subject', author: 'Author', authoredAt: date, refs: [] }])
    for (const raw of [line.slice(0, -1), `wrong${line.slice(5)}`, [id, 'bad', 'subject', 'Author', date].join('\0') + '\0',
      [id, '', 'subject', 'Author', 'yesterday'].join('\0') + '\0', [id, '', 'a'.repeat(4097), 'Author', date].join('\0') + '\0',
      'x'.repeat(2 * 1024 * 1024 + 1), line + 'garbage']) {
      expect(() => parseGitHistory(raw)).toThrow()
    }
    expect(parseGitHistory('')).toEqual([])
    expect(parseGitHistoryRefs('')).toEqual({ refs: new Map(), branches: [] })
    expect(parseGitHistoryRefs(`refs/heads/feat,1\0${id}\0\0\nrefs/tags/v1\0${'b'.repeat(40)}\0${id}\0\n`))
      .toEqual({ refs: new Map([[id, ['feat,1', 'tag: v1']]]), branches: ['feat,1'] })
    for (const raw of [`refs/heads/feature\0${id}\0`, 'refs/heads/feature\0invalid\0\0\n',
      'x'.repeat(256 * 1024 + 1), `refs/other/branch\0${id}\0\0\n`]) {
      expect(() => parseGitHistoryRefs(raw)).toThrow()
    }
  })

  it('rejects a remote marker before reading a colocated local Git repository', async () => {
    const root = repo()
    writeFileSync(join(root, '.coding-remote-workspace.json'), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    await expect(workspaceGitHistory(root, signal)).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
  })

  it('honors cancellation before launching Git history', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(workspaceGitHistory(repo(), abort.signal)).rejects.toBeDefined()
  })

  it('honors cancellation before launching Git', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(workspaceGitStatus(repo(), abort.signal)).rejects.toBeDefined()
  })
})
