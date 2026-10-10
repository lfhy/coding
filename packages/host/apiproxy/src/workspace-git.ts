import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
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
    public readonly code: 'GIT_UNAVAILABLE' | 'GIT_NO_REPOSITORY' | 'GIT_REMOTE_UNAVAILABLE' | 'GIT_CONFLICT' | 'GIT_FAILED' | 'GIT_BRANCH_NOT_FOUND' | 'GIT_AUTH_REQUIRED' | 'GIT_AUTH_FAILED' | 'GIT_CREDENTIALS_UNAVAILABLE',
    message: string,
    public readonly remote?: string,
    /** 本次认证尝试过、但被拒绝的本机凭据引用；调用方据此提示并清除它。 */
    public readonly credentialRef?: CredentialRef,
  ) {
    super(message)
    this.name = 'GitOperationError'
  }
}

/**
 * 一次远端操作的认证输入。凭据来源按固定优先级解析：宿主凭据助手、本机凭据存储，
 * 最后才是调用方显式提供的凭据。
 */
export interface GitRemoteOptions {
  /**
   * 调用方本次显式提供的凭据（认证弹窗的答案）。一旦提供就独占本次认证：它来自上一轮
   * 前两级都失败的往返，用户重输的凭据不该再被它们覆盖。
   */
  credentials?: GitCredentials
  /** 本机 Git 凭据存储；未提供时只尝试宿主的凭据助手。 */
  store?: GitCredentialStore
  /** 非致命诊断（已存凭据读不出、写回失败）；记录后仍按当前可用来源继续。 */
  warn?: (message: string) => void
}

/**
 * 本机 Git 凭据存储。值对该接口是不透明字符串——编解码归本模块，存储只按引用读写，
 * 所以实现方（凭据 seam）不需要理解 Git 的凭据结构。
 */
export interface GitCredentialStore {
  /** 读取引用当前的值；未配置时返回 undefined。 */
  read(ref: CredentialRef): Promise<string | undefined>
  /** 该引用现在是否可写；凭据服务缺失或被只读来源遮蔽时为 false。 */
  writable(ref: CredentialRef): Promise<boolean>
  /** 写入值；拒绝表示这组凭据没有保存成功。 */
  write(ref: CredentialRef, value: string): Promise<void>
}

/**
 * HTTPS 远端主机在凭据存储中的引用名。只由主机名派生，绝不包含凭据值，所以界面可以
 * 把它当作“哪一组凭据”的标识回传。
 * @param host - URL.host（含非默认端口）。
 * @returns 形如 GIT_CREDENTIAL_GITHUB_COM 的凭据引用。
 */
export function gitCredentialRef(host: string): CredentialRef {
  return credentialRef(`GIT_CREDENTIAL_${host.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`)
}

/** 凭据文档里的值连主机名一起保存：归一化到同一引用时要复核，否则一组凭据会被交给另一个主机。 */
function encodeGitCredential(host: string, credentials: GitCredentials): string {
  return JSON.stringify({ host, username: credentials.username, password: credentials.password })
}

/** 解析本模块写入的值；结构不符或主机名不一致时返回 undefined。 */
function decodeGitCredential(host: string, value: string): GitCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { host: storedHost, username, password } = parsed as Record<string, unknown>
  if (storedHost !== host || typeof username !== 'string' || username === ''
    || typeof password !== 'string' || password === '') return undefined
  return { username, password }
}

const OUTPUT_LIMIT = 4 * 1024 * 1024
const COMMAND_TIMEOUT = 60_000

type GitOutput = { stdout: string; stderr: string; code: number }
type GitRunOptions = {
  askpass?: string
  socket?: string
  /** 允许宿主配置的凭据助手（credential.helper）参与认证；默认禁用。 */
  helper?: boolean
}

/**
 * 子进程环境。终端提示、SSH 交互提示与宿主的凭据助手默认全部禁用，凭据只能来自本次
 * 注入的 askpass；只有 helper 为真时才保留宿主配置的助手链。
 * @param options - 本次调用的 askpass 与助手开关。
 * @returns 该子进程的完整环境变量。
 */
function gitEnv(options: GitRunOptions): NodeJS.ProcessEnv {
  // credential.helper 置空会清空整条助手链，所以禁用必须是显式清空而不是省略。
  const config: Array<[string, string]> = options.helper === true ? [] : [['credential.helper', '']]
  config.push(['core.askPass', options.askpass ?? ''])
  const env: NodeJS.ProcessEnv = {
    // 失败分类读的是 git 的诊断文本；固定 C locale 才能让同一故障在任何宿主语言下同类。
    ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: options.askpass ?? '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_CONFIG_COUNT: String(config.length),
    ...(options.socket === undefined ? {} : { DSH_GIT_ASKPASS_SOCKET: options.socket }),
  }
  config.forEach(([key, value], index) => {
    env['GIT_CONFIG_KEY_' + String(index)] = key
    env['GIT_CONFIG_VALUE_' + String(index)] = value
  })
  return env
}

function runGit(cwd: string, signal: AbortSignal, args: string[], options: GitRunOptions = {}): Promise<GitOutput> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd, signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(options),
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

/** HTTPS 远端的可认证身份：host 用作凭据引用，display 用于展示和诊断。 */
interface RemoteIdentity {
  host: string
  display: string
}

function remoteIdentity(url: string): RemoteIdentity | undefined {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return undefined
    return { host: parsed.host, display: `https://${parsed.host}` }
  } catch { return undefined }
}

function requireRemoteIdentity(url: string): RemoteIdentity {
  const identity = remoteIdentity(url)
  if (identity === undefined) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git credentials require an HTTPS remote without embedded user information')
  return identity
}

function authenticationFailure(result: GitOutput, credentials: GitCredentials | undefined, remote: string): GitOperationError | undefined {
  const output = `${result.stderr}\n${result.stdout}`
  const denied = /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied/i
  const httpDenied = /requested URL returned error: 40[13]|Invalid username or password/i
  if (!denied.test(output) && !httpDenied.test(output)) return undefined
  return new GitOperationError(credentials === undefined ? 'GIT_AUTH_REQUIRED' : 'GIT_AUTH_FAILED',
    credentials === undefined ? 'Git credentials required' : 'Git authentication failed', remote)
}

/** “记住凭据”的落点：在触碰远端之前认领，远端操作成功之后才写入。 */
interface RememberTarget {
  ref: CredentialRef
  host: string
}

/**
 * 认领一次“记住这组凭据”。存储缺失、被只读来源遮蔽或远端不是 HTTPS 时，在暂存、提交
 * 或推送之前失败：远端已经改变、用户却以为凭据已保存，是更坏的结局。
 * @param url - 本次操作实际使用的远端 URL。
 * @param options - 调用方凭据与本机存储。
 * @returns 成功后要写入的落点；本次不要求记住时为 undefined。
 */
async function claimRemember(url: string, options: GitRemoteOptions): Promise<RememberTarget | undefined> {
  if (options.credentials?.remember !== true) return undefined
  const { host } = requireRemoteIdentity(url)
  const ref = gitCredentialRef(host)
  if (options.store === undefined || !await options.store.writable(ref)) {
    throw new GitOperationError('GIT_CREDENTIALS_UNAVAILABLE', 'Git credentials cannot be remembered: this deployment has no writable credential store')
  }
  return { ref, host }
}

/** 远端操作成功后写入凭据；写入失败只记录诊断，不改变已经完成的远端结果。 */
async function commitRemember(target: RememberTarget | undefined, options: GitRemoteOptions): Promise<void> {
  const credentials = options.credentials
  if (target === undefined || credentials === undefined || options.store === undefined) return
  try {
    await options.store.write(target.ref, encodeGitCredential(target.host, credentials))
  } catch (error: unknown) {
    options.warn?.(`Git credentials for ${target.host} were not saved: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读取该主机已保存的凭据；读不到、解析不了或值不属于该主机时按未保存处理，并给出诊断。 */
async function storedCredential(ref: CredentialRef, host: string, options: GitRemoteOptions): Promise<GitCredentials | undefined> {
  if (options.store === undefined) return undefined
  let value: string | undefined
  try {
    value = await options.store.read(ref)
  } catch (error: unknown) {
    options.warn?.(`Git credentials stored for ${host} could not be read (${ref}): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (value === undefined) return undefined
  const credentials = decodeGitCredential(host, value)
  if (credentials === undefined) {
    options.warn?.(`Git credentials stored for ${host} were ignored: ${ref} does not hold credentials for this remote`)
  }
  return credentials
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

/**
 * 按固定优先级认证一次远端命令：宿主的凭据助手、本机已保存的凭据，最后才是调用方显式
 * 提供的凭据。显式凭据一旦提供就独占本次认证，因为它来自上一轮前两级都失败的弹窗；
 * 非 HTTPS 远端既不使用助手，也不读写凭据存储。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param args - 一次 git 远端命令及其参数。
 * @param url - 该命令实际使用的远端 URL（push 用 push URL，pull 用 fetch URL）。
 * @param options - 本次的凭据来源与本机存储。
 */
async function remoteCommand(
  cwd: string, signal: AbortSignal, args: string[], url: string, options: GitRemoteOptions,
): Promise<void> {
  const identity = remoteIdentity(url)
  if (options.credentials !== undefined && identity === undefined) requireRemoteIdentity(url)
  const attempt = async (runOptions: GitRunOptions, credentials: GitCredentials | undefined): Promise<GitOperationError | undefined> => {
    const result = await runGit(cwd, signal, args, runOptions)
    if (result.code === 0) return undefined
    if (identity !== undefined) {
      const refused = authenticationFailure(result, credentials, identity.display)
      if (refused !== undefined) return refused
    }
    return /conflict|not possible to fast-forward|divergent|would be overwritten|non-fast-forward/i.test(result.stderr)
      ? new GitOperationError('GIT_CONFLICT', 'Git remote history or working tree conflicts')
      : new GitOperationError('GIT_FAILED', 'Git remote operation failed')
  }
  const explicit = options.credentials
  if (explicit !== undefined) {
    const refused = await withAskpass(explicit, signal, runOptions => attempt(runOptions, explicit))
    if (refused !== undefined) throw refused
    return
  }
  // 第一次尝试保留宿主的凭据助手：命令只在服务器主动要求认证时才向它索取凭据。
  const anonymous = await attempt({ helper: identity !== undefined }, undefined)
  if (anonymous === undefined) return
  if (identity === undefined || anonymous.code !== 'GIT_AUTH_REQUIRED') throw anonymous
  const ref = gitCredentialRef(identity.host)
  const saved = await storedCredential(ref, identity.host, options)
  if (saved === undefined) throw new GitOperationError('GIT_AUTH_REQUIRED', 'Git credentials required', identity.display)
  const refused = await withAskpass(saved, signal, runOptions => attempt(runOptions, saved))
  if (refused === undefined) return
  // 带凭据的尝试把凭据被拒报告为 GIT_AUTH_FAILED；其它失败照原样上抛，不误报成认证问题。
  if (refused.code !== 'GIT_AUTH_FAILED') throw refused
  // 已保存的凭据被拒：仍按“需要认证”请求用户输入，并带上引用名，让界面能清除它。
  throw new GitOperationError('GIT_AUTH_REQUIRED', 'Git credentials required', identity.display, ref)
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

/**
 * 显式推送会暂存所有非忽略文件并自动提交；无上游时不修改工作树。凭据按 GitRemoteOptions
 * 的优先级解析，remember 只在推送成功后写入本机存储。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param options - 本次凭据、本机存储与诊断出口。
 * @returns 推送结果；无 staged 差异时不创建提交。
 */
export async function workspaceGitPush(cwd: string, signal: AbortSignal, options: GitRemoteOptions = {}): Promise<GitOperationResult> {
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
  // 记住凭据在触碰远端之前认领；认证预检必须先于暂存和提交，只有实际 push 才改变远端状态。
  const remember = await claimRemember(upstreamName.pushUrl, options)
  await remoteCommand(cwd, signal, ['ls-remote', '--exit-code', remote, `refs/heads/${remoteBranch}`], upstreamName.pushUrl, options)
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
  await remoteCommand(cwd, signal, ['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', remote, `HEAD:refs/heads/${remoteBranch}`], upstreamName.pushUrl, options)
  await commitRemember(remember, options)
  return { branch, commitCreated, ...(commit === undefined ? {} : { commit }) }
}

/**
 * 只接受快进拉取；分叉或脏文件阻挡快进时明确报告冲突，不进行 rebase 或合并提交。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param options - 本次凭据、本机存储与诊断出口。
 * @returns 拉取后的分支；pull 不创建提交。
 */
export async function workspaceGitPull(cwd: string, signal: AbortSignal, options: GitRemoteOptions = {}): Promise<GitOperationResult> {
  if (!await guard(cwd, signal)) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  const branch = await branchName(cwd, signal)
  if (branch === null) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot pull a detached HEAD')
  const tracking = await upstream(cwd, signal)
  const remember = await claimRemember(tracking.fetchUrl, options)
  await remoteCommand(cwd, signal, ['-c', 'core.hooksPath=/dev/null', '-c', 'pull.ff=only', 'pull', '--ff-only'], tracking.fetchUrl, options)
  await commitRemember(remember, options)
  return { branch, commitCreated: false }
}
