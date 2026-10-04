import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitCredentials } from './api/workspace.ts'
import { remoteWorkspacePath } from '@deepseek-ai/dsh-subprocess'

/** 工作区 Git 的文件变更及相对上游的提交差距。 */
export interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: Array<{ path: string; status: string; additions: number; deletions: number }>
}

/** 当前仓库的本地分支列表与 HEAD 所指分支；游离 HEAD 的 current 为 null。 */
export interface GitBranches {
  branches: string[]
  current: string | null
}

/** 写操作的提交结果；pull 不创建提交。 */
export interface GitOperationResult {
  branch: string | null
  commitCreated: boolean
  commit?: string
}

/** 可供调用方区别环境、仓库、上游和冲突的失败。 */
export class GitOperationError extends Error {
  constructor(
    public readonly code: 'GIT_UNAVAILABLE' | 'GIT_NO_REPOSITORY' | 'GIT_REMOTE_UNAVAILABLE' | 'GIT_CONFLICT' | 'GIT_FAILED' | 'GIT_BRANCH_NOT_FOUND' | 'GIT_AUTH_REQUIRED' | 'GIT_AUTH_FAILED',
    message: string,
    public readonly remote?: string,
  ) {
    super(message)
    this.name = 'GitOperationError'
  }
}

const OUTPUT_LIMIT = 4 * 1024 * 1024
const COMMAND_TIMEOUT = 60_000

type GitOutput = { stdout: string; stderr: string; code: number }
type GitRunOptions = { askpass?: string; socket?: string }

function runGit(cwd: string, signal: AbortSignal, args: string[], options: GitRunOptions = {}): Promise<GitOutput> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd, signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: options.askpass ?? '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: options.askpass ?? '',
        ...(options.socket === undefined ? {} : { DSH_GIT_ASKPASS_SOCKET: options.socket }),
      },
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let overflow = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, COMMAND_TIMEOUT)
    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > OUTPUT_LIMIT) {
        overflow = true
        child.kill()
      } else {
        target.push(chunk)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => { append(output, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { append(errors, chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      if (signal.aborted) reject(new Error('Git command was cancelled'))
      else reject(new GitOperationError('code' in error && error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED', 'Git command could not start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (signal.aborted) reject(new Error('Git command was cancelled'))
      else if (overflow) reject(new GitOperationError('GIT_FAILED', 'Git output exceeded the size limit'))
      else if (timedOut || code === null) reject(new GitOperationError('GIT_FAILED', 'Git command timed out or was terminated'))
      else resolve({ stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), code })
    })
  })
}

function failure(result: GitOutput, fallback: GitOperationError['code'] = 'GIT_FAILED'): GitOperationError {
  const message = 'Git command failed'
  const diagnostic = `${result.stderr}\n${result.stdout}`
  const conflict = /conflict|not possible to fast-forward|divergent|would be overwritten|unmerged|non-fast-forward/i.test(diagnostic)
  return new GitOperationError(conflict ? 'GIT_CONFLICT' : fallback, message)
}

function httpsRemote(url: string): { display: string } | undefined {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return undefined
    return { display: `https://${parsed.host}` }
  } catch { return undefined }
}

function requireHttpsCredentials(url: string): string {
  const remote = httpsRemote(url)
  if (remote === undefined) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git credentials require an HTTPS remote without embedded user information')
  return remote.display
}

function authenticationFailure(result: GitOutput, credentials: GitCredentials | undefined, remote: string): GitOperationError | undefined {
  const output = `${result.stderr}\n${result.stdout}`
  const denied = /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied/i
  const httpDenied = /requested URL returned error: 40[13]|Invalid username or password/i
  if (!denied.test(output) && !httpDenied.test(output)) return undefined
  return new GitOperationError(credentials === undefined ? 'GIT_AUTH_REQUIRED' : 'GIT_AUTH_FAILED',
    credentials === undefined ? 'Git credentials required' : 'Git authentication failed', remote)
}

/** 临时套接字向 askpass 子进程逐项提供凭据；脚本和环境不包含机密。 */
async function withAskpass<T>(
  credentials: GitCredentials, signal: AbortSignal, operation: (options: GitRunOptions) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-'))
  const socket = join(directory, 'askpass.sock')
  const script = join(directory, 'askpass.cjs')
  const server = createServer((connection) => {
    let prompt = ''
    connection.setEncoding('utf8')
    connection.on('data', (chunk: string) => {
      prompt += chunk
      if (prompt.length > 1024) { connection.destroy(); return }
      if (!prompt.includes('\n')) return
      connection.end(`${/username/i.test(prompt) ? credentials.username : credentials.password}\n`)
    })
  })
  try {
    await writeFile(script, `#!${process.execPath}\nconst net = require('node:net');\nconst c = net.connect(process.env.DSH_GIT_ASKPASS_SOCKET);\nc.on('connect', () => c.write(process.argv[2] + '\\n'));\nc.pipe(process.stdout);\nc.on('error', () => process.exit(1));\n`, { mode: 0o700 })
    await chmod(script, 0o700)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => { server.off('error', reject); resolve() })
    })
    return await operation({ askpass: script, socket })
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function checked(cwd: string, signal: AbortSignal, args: string[], code?: GitOperationError['code']): Promise<string> {
  const result = await runGit(cwd, signal, args)
  if (result.code !== 0) throw failure(result, code)
  return result.stdout
}

async function remoteCommand(cwd: string, signal: AbortSignal, args: string[], url: string, credentials?: GitCredentials): Promise<void> {
  const https = httpsRemote(url)
  if (credentials !== undefined && https === undefined) requireHttpsCredentials(url)
  const remote = https?.display ?? 'Git remote'
  const invoke = async (options: GitRunOptions) => {
    const result = await runGit(cwd, signal, args, options)
    if (result.code === 0) return
    throw (https === undefined ? undefined : authenticationFailure(result, credentials, remote))
      ?? (/conflict|not possible to fast-forward|divergent|would be overwritten|non-fast-forward/i.test(result.stderr)
        ? new GitOperationError('GIT_CONFLICT', 'Git remote history or working tree conflicts')
        : new GitOperationError('GIT_FAILED', 'Git remote operation failed'))
  }
  if (credentials === undefined) await invoke({})
  else await withAskpass(credentials, signal, invoke)
}

async function guard(cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    if (await remoteWorkspacePath('.', cwd, signal) !== undefined) {
      throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git operations are unavailable in remote workspaces')
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof GitOperationError) throw error
    throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot verify whether the workspace is remote')
  }
  const result = await runGit(cwd, signal, ['rev-parse', '--is-inside-work-tree'])
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return false
    throw failure(result)
  }
  if (result.stdout.trim() !== 'true') throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git working tree')
  return true
}

async function branchName(cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await runGit(cwd, signal, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (result.code === 1) return null
  if (result.code !== 0) throw failure(result)
  return result.stdout.trim()
}

async function upstream(cwd: string, signal: AbortSignal): Promise<{ name: string; fetchUrl: string; pushUrl: string }> {
  const result = await runGit(cwd, signal, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (result.code !== 0) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'No upstream is configured')
  const name = result.stdout.trim()
  const slash = name.indexOf('/')
  if (slash < 1 || slash === name.length - 1) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream has no remote branch')
  const remote = name.slice(0, slash)
  const url = await checked(cwd, signal, ['remote', 'get-url', remote], 'GIT_REMOTE_UNAVAILABLE')
  if (!url.trim()) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream remote has no URL')
  const pushUrl = await checked(cwd, signal, ['remote', 'get-url', '--push', remote], 'GIT_REMOTE_UNAVAILABLE')
  if (!pushUrl.trim()) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream remote has no push URL')
  return { name, fetchUrl: url.trim(), pushUrl: pushUrl.trim() }
}

async function untrackedLines(path: string, signal: AbortSignal): Promise<number> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 1024 * 1024) return 0
  let lines = 0
  let last = 0
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    const data = chunk as Buffer
    if (data.includes(0)) return 0
    bytes += data.length
    for (const byte of data) if (byte === 10) lines++
    if (data.length > 0) last = data.at(-1) ?? 0
  }
  return lines + (bytes > 0 && last !== 10 ? 1 : 0)
}

/** 返回本地仓库的文件及行数；非仓库返回 null，远程 marker 从不调用本机 Git。 */
export async function workspaceGitStatus(cwd: string, signal: AbortSignal): Promise<GitStatus | null> {
  if (!await guard(cwd, signal)) return null
  const branch = await branchName(cwd, signal)
  const raw = await checked(cwd, signal, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const root = (await checked(cwd, signal, ['rev-parse', '--show-toplevel'])).trim()
  const entries = raw.split('\0')
  const files: GitStatus['files'] = []
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i]
    if (entry === undefined) throw new GitOperationError('GIT_FAILED', 'Incomplete Git status output')
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) i++ // porcelain -z 的重命名项额外包含旧路径
    files.push({ path, status, additions: 0, deletions: 0 })
  }
  const head = await runGit(cwd, signal, ['rev-parse', '--verify', 'HEAD'])
  const diffArgs = head.code === 0 ? ['diff', 'HEAD', '--numstat', '-z'] : ['diff', '--cached', '--numstat', '-z']
  const stats = await checked(cwd, signal, diffArgs)
  const unstaged = head.code === 0 ? '' : await checked(cwd, signal, ['diff', '--numstat', '-z'])
  const parts = [stats, unstaged].filter(Boolean).join('').split('\0')
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (let i = 0; i < parts.length - 1; i++) {
    const row = parts[i]
    if (row === undefined) throw new GitOperationError('GIT_FAILED', 'Incomplete Git numstat output')
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(row)
    if (!match) throw new GitOperationError('GIT_FAILED', 'Unexpected Git numstat output')
    const oldPath = match[3] === '' ? parts[i + 1] : undefined
    const path = match[3] === '' ? parts[i + 2] : match[3]
    if (path === undefined || (match[3] === '' && (!oldPath || !path))) {
      throw new GitOperationError('GIT_FAILED', 'Incomplete Git rename numstat output')
    }
    if (match[3] === '') i += 2
    const previous = counts.get(path)
    counts.set(path, {
      additions: (previous?.additions ?? 0) + (Number(match[1]) || 0),
      deletions: (previous?.deletions ?? 0) + (Number(match[2]) || 0),
    })
  }
  for (const file of files) {
    const count = counts.get(file.path)
    if (count !== undefined) Object.assign(file, count)
    else if (file.status === '??') {
      try { file.additions = await untrackedLines(join(root, file.path), signal) }
      catch { signal.throwIfAborted(); throw new GitOperationError('GIT_FAILED', `Cannot count untracked file ${file.path}`) }
    }
  }
  let ahead = 0
  let behind = 0
  const tracking = await runGit(cwd, signal, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (tracking.code === 0) {
    const distance = await checked(cwd, signal, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const match = /^(\d+)\s+(\d+)/u.exec(distance)
    if (!match) throw new GitOperationError('GIT_FAILED', 'Unexpected Git ahead/behind output')
    ahead = Number(match[1]); behind = Number(match[2])
  }
  return {
    branch, ahead, behind, files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

/** 返回全部本地分支；非仓库返回 null，远程 marker 从不调用本机 Git。 */
export async function workspaceGitBranches(cwd: string, signal: AbortSignal): Promise<GitBranches | null> {
  if (!await guard(cwd, signal)) return null
  const raw = await checked(cwd, signal, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return {
    branches: raw.split('\n').filter(Boolean).sort((a, b) => a.localeCompare(b)),
    current: await branchName(cwd, signal),
  }
}

/** 仅切换已有本地分支；切换前拒绝脏工作树，并返回切换后的最新状态。 */
export async function workspaceGitCheckout(cwd: string, signal: AbortSignal, branch: string): Promise<GitStatus> {
  const available = await workspaceGitBranches(cwd, signal)
  if (available === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  if (!available.branches.includes(branch)) throw new GitOperationError('GIT_BRANCH_NOT_FOUND', `Local Git branch not found: ${branch}`)
  const status = await workspaceGitStatus(cwd, signal)
  if (status === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  if (status.branch === branch) return status
  if (status.files.length > 0) throw new GitOperationError('GIT_CONFLICT', 'Cannot switch branches with uncommitted changes')
  await checked(cwd, signal, ['switch', '--no-overwrite-ignore', '--', branch])
  const result = await workspaceGitStatus(cwd, signal)
  if (result === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  return result
}

function commitMessage(status: GitStatus): string {
  const files = status.files
  if (files.length === 0) return 'Update workspace changes'
  const action = files.every(file => file.status === '??' || file.status.startsWith('A')) ? 'Add'
    : files.every(file => file.status.includes('D')) ? 'Remove'
      : files.every(file => file.status.includes('R')) ? 'Rename' : 'Update'
  if (files.length === 1) {
    const path = files[0]?.path.replace(/[\r\n\t]/gu, ' ').trim() ?? ''
    return `${action} ${path.slice(0, 60) || 'workspace file'}`
  }
  const directories = new Set(files.map(file => file.path.split('/')[0]))
  const scope = directories.size === 1 && files[0]?.path.includes('/') ? `${files[0].path.split('/')[0]} files` : 'workspace files'
  return `${action} ${String(files.length)} ${scope} (+${String(status.additions)}/-${String(status.deletions)})`
}

/** 显式推送会暂存所有非忽略文件并自动提交；无上游时不修改工作树。 */
export async function workspaceGitPush(cwd: string, signal: AbortSignal, credentials?: GitCredentials): Promise<GitOperationResult> {
  if (!await guard(cwd, signal)) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  const branch = await branchName(cwd, signal)
  if (branch === null) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot push a detached HEAD')
  const upstreamName = await upstream(cwd, signal)
  const slash = upstreamName.name.indexOf('/')
  if (slash < 1 || slash === upstreamName.name.length - 1) {
    throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream has no remote branch')
  }
  const remote = upstreamName.name.slice(0, slash)
  const remoteBranch = upstreamName.name.slice(slash + 1)
  // 认证预检必须先于暂存和提交；只有实际 push 才改变远端状态。
  await remoteCommand(cwd, signal, ['ls-remote', '--exit-code', remote, `refs/heads/${remoteBranch}`], upstreamName.pushUrl, credentials)
  const pending = await workspaceGitStatus(cwd, signal)
  await checked(cwd, signal, ['add', '--all', '--', ':/'])
  const staged = await runGit(cwd, signal, ['diff', '--cached', '--quiet'])
  if (staged.code !== 0 && staged.code !== 1) throw failure(staged)
  const commitCreated = staged.code === 1
  const summary = commitCreated ? commitMessage(pending ?? {
    branch, ahead: 0, behind: 0, additions: 0, deletions: 0, files: [],
  }) : undefined
  if (summary !== undefined) await checked(cwd, signal, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', summary])
  const commit = commitCreated ? (await checked(cwd, signal, ['rev-parse', 'HEAD'])).trim() : undefined
  await remoteCommand(cwd, signal, ['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', remote, `HEAD:refs/heads/${remoteBranch}`], upstreamName.pushUrl, credentials)
  return { branch, commitCreated, ...(commit === undefined ? {} : { commit }) }
}

/** 只接受快进拉取；分叉或脏文件阻挡快进时明确报告冲突，不进行 rebase 或合并提交。 */
export async function workspaceGitPull(cwd: string, signal: AbortSignal, credentials?: GitCredentials): Promise<GitOperationResult> {
  if (!await guard(cwd, signal)) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  const branch = await branchName(cwd, signal)
  if (branch === null) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot pull a detached HEAD')
  const tracking = await upstream(cwd, signal)
  await remoteCommand(cwd, signal, ['-c', 'core.hooksPath=/dev/null', '-c', 'pull.ff=only', 'pull', '--ff-only'], tracking.fetchUrl, credentials)
  return { branch, commitCreated: false }
}
