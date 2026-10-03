import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceGitBranches, workspaceGitCheckout, workspaceGitPull, workspaceGitPush, workspaceGitStatus } from '../src/workspace-git.ts'

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
})

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

  it('honors cancellation before launching Git', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(workspaceGitStatus(repo(), abort.signal)).rejects.toBeDefined()
  })
})
