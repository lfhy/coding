import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneWithCli, cloneWithJs } from '../src/clone.ts'

const roots: string[] = []
const signal = new AbortController().signal
/** 克隆用例包含多次真实 Git 子进程，全量并发时可能超过默认的五秒。 */
const CLONE_TIMEOUT_MS = 20_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-clone-test-'))
  roots.push(root)
  return root
}

/** 一个带一次提交的源仓库，供本机路径克隆使用。 */
function sourceRepo(): string {
  const root = temp()
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q')
  writeFileSync(join(root, 'tracked.txt'), 'first\n')
  git(root, 'add', 'tracked.txt')
  git(root, '-c', 'user.email=test@example.org', '-c', 'user.name=Git Test', 'commit', '-qm', 'initial')
  return root
}

const cliAvailable = async (): Promise<boolean> => true

/** 关掉的智能 HTTP 服务，用例结束时统一回收。 */
const servers: Array<() => Promise<void>> = []

/**
 * 用 `git http-backend` 起一个真实的智能 HTTP 远端，让内置实现走完整协议而不是被替身
 * 敷衍。项目根下的 `repo.git` 是裸仓库，PATH_INFO 直接交给 CGI。
 */
async function smartHttp(projectRoot: string): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
        REMOTE_USER: '',
      },
    })
    request.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let sent = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (sent) { response.write(chunk); return }
      head = Buffer.concat([head, chunk])
      const split = head.indexOf('\r\n\r\n')
      if (split < 0) return
      for (const line of head.subarray(0, split).toString('utf8').split('\r\n')) {
        const at = line.indexOf(':')
        if (at <= 0) continue
        const name = line.slice(0, at)
        const value = line.slice(at + 1).trim()
        if (name.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]) || 200
        else response.setHeader(name, value)
      }
      sent = true
      const rest = head.subarray(split + 4)
      if (rest.length > 0) response.write(rest)
    })
    child.stdout.on('end', () => { response.end() })
    child.on('error', () => { response.destroy() })
    // 只有响应被提前中断才终止 CGI：GET 的空请求体会立刻触发请求侧的 close。
    response.on('close', () => { if (!response.writableEnded) child.kill() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}/repo.git`
}

afterEach(async () => {
  for (const close of servers.splice(0)) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cloneWithCli', () => {
  it('clones into a new directory and persists the requested commit identity', async () => {
    const source = sourceRepo()
    const target = join(temp(), 'nested', 'copy')
    const result = await cloneWithCli(
      { url: source, path: target, identity: { name: 'Clone User', email: 'clone@example.org' } },
      signal, cliAvailable, {},
    )
    expect(result).toEqual({ path: target, branch: 'main', mechanism: 'cli' })
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('first\n')
    expect(git(target, 'config', 'user.name')).toBe('Clone User')
    expect(git(target, 'config', 'user.email')).toBe('clone@example.org')
  })

  it('checks out the requested ref when one is given', async () => {
    const source = sourceRepo()
    git(source, 'checkout', '-qb', 'feature')
    writeFileSync(join(source, 'feature.txt'), 'feature\n')
    git(source, 'add', 'feature.txt')
    git(source, '-c', 'user.email=test@example.org', '-c', 'user.name=Git Test', 'commit', '-qm', 'feature')
    const target = join(temp(), 'ref-copy')
    const result = await cloneWithCli({ url: source, path: target, ref: 'feature' }, signal, cliAvailable, {})
    expect(result.branch).toBe('feature')
  })

  it('refuses a destination that already holds files and leaves it untouched', async () => {
    const source = sourceRepo()
    const target = temp()
    writeFileSync(join(target, 'existing.txt'), 'keep me\n')
    await expect(cloneWithCli({ url: source, path: target }, signal, cliAvailable, {}))
      .rejects.toMatchObject({ code: 'GIT_TARGET_EXISTS' })
    expect(readFileSync(join(target, 'existing.txt'), 'utf8')).toBe('keep me\n')
  })

  it('removes the directory it created when the remote cannot be cloned', async () => {
    const parent = temp()
    const target = join(parent, 'broken')
    await expect(cloneWithCli({ url: join(parent, 'missing-remote'), path: target }, signal, cliAvailable, {}))
      .rejects.toBeDefined()
    expect(() => readFileSync(join(target, 'tracked.txt'))).toThrow()
  })
})

describe('cloneWithJs', () => {
  it('clones over smart HTTP without a git executable and reports the built-in mechanism', async () => {
    const projectRoot = temp()
    git(projectRoot, 'clone', '-q', '--bare', sourceRepo(), join(projectRoot, 'repo.git'))
    const url = await smartHttp(projectRoot)
    const target = join(temp(), 'js-copy')
    const result = await cloneWithJs({ url, path: target }, signal, {})
    expect(result.mechanism).toBe('js')
    expect(result.branch).toBe('main')
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('first\n')
  }, CLONE_TIMEOUT_MS)

  it('writes the requested commit identity into the cloned repository', async () => {
    const projectRoot = temp()
    git(projectRoot, 'clone', '-q', '--bare', sourceRepo(), join(projectRoot, 'repo.git'))
    const url = await smartHttp(projectRoot)
    const target = join(temp(), 'js-identity')
    await cloneWithJs({ url, path: target, identity: { name: 'Clone User', email: 'clone@example.org' } }, signal, {})
    expect(git(target, 'config', 'user.name')).toBe('Clone User')
  }, CLONE_TIMEOUT_MS)

  it('rejects a local filesystem path, which the built-in implementation cannot read', async () => {
    const target = join(temp(), 'local-path')
    await expect(cloneWithJs({ url: sourceRepo(), path: target }, signal, {}))
      .rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
  })

  it('refuses a proxy instead of silently ignoring it', async () => {
    const target = join(temp(), 'proxied')
    await expect(cloneWithJs({ url: 'https://example.com/repo.git', path: target, proxy: 'http://127.0.0.1:7890' }, signal, {}))
      .rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
  })

  it('reports a rejected destination before reaching the remote', async () => {
    const occupied = temp()
    writeFileSync(join(occupied, 'existing.txt'), 'x')
    await expect(cloneWithJs({ url: 'https://example.com/repo.git', path: occupied }, signal, {}))
      .rejects.toMatchObject({ code: 'GIT_TARGET_EXISTS' })
  })
})

describe('clone target preparation', () => {
  it('accepts an empty directory that already exists', async () => {
    const target = join(temp(), 'empty-target')
    mkdirSync(target)
    const result = await cloneWithCli({ url: sourceRepo(), path: target }, signal, cliAvailable, {})
    expect(result.path).toBe(target)
  })

  it('rejects a target that exists as a file', async () => {
    const target = join(temp(), 'a-file')
    writeFileSync(target, 'x')
    await expect(cloneWithCli({ url: sourceRepo(), path: target }, signal, cliAvailable, {}))
      .rejects.toMatchObject({ code: 'GIT_TARGET_EXISTS' })
  })

  it('keeps a renamed empty directory usable as the destination', async () => {
    const root = temp()
    const staged = join(root, 'staged')
    mkdirSync(staged)
    renameSync(staged, join(root, 'moved'))
    const result = await cloneWithCli({ url: sourceRepo(), path: join(root, 'moved') }, signal, cliAvailable, {})
    expect(result.path).toBe(join(root, 'moved'))
  })
})
