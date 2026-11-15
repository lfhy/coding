/** 远端命令的认证编排：宿主助手、本机凭据存储与调用方显式凭据的固定优先级。 @module coding-git-local/credentials */

import { createServer } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeGitCredential, encodeGitCredential, gitCredentialRef, gitRemoteIdentity, GitOperationError,
} from 'coding-git'
import type { GitCredentials, GitCredentialStore, GitRemoteOptions } from 'coding-git'
import type { CredentialRef } from 'coding-credentials'
import { runGit } from './cli-process.ts'
import type { GitOutput, GitRunOptions } from './cli-process.ts'

/** 可在本次命令上注入的认证材料。 */
export interface RemoteAttempt {
  runOptions: GitRunOptions
  credentials: GitCredentials | undefined
}

/** “记住凭据”的落点：在触碰远端之前认领，远端操作成功之后才写入。 */
interface RememberTarget {
  ref: CredentialRef
  host: string
}

/**
 * 读取该 URL 的可认证身份；需要凭据的操作不接受内嵌用户信息。
 * @param url - 远端 URL。
 * @returns 主机与展示名。
 * @throws {GitOperationError} 远端不是可认证的 HTTPS 地址。
 */
export function requireRemoteIdentity(url: string): { host: string; display: string } {
  const identity = gitRemoteIdentity(url)
  if (identity === undefined) {
    throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git credentials require an HTTPS remote without embedded user information')
  }
  return identity
}

/**
 * 识别认证被拒的输出。
 * @param result - 失败的调用结果。
 * @param credentials - 本次尝试携带的凭据。
 * @param remote - 远端展示名。
 * @returns 认证类失败，或 undefined。
 */
export function authenticationFailure(
  result: GitOutput, credentials: GitCredentials | undefined, remote: string,
): GitOperationError | undefined {
  const output = `${result.stderr}\n${result.stdout}`
  const denied = /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied/i
  const httpDenied = /requested URL returned error: 40[13]|Invalid username or password/i
  if (!denied.test(output) && !httpDenied.test(output)) return undefined
  return new GitOperationError(credentials === undefined ? 'GIT_AUTH_REQUIRED' : 'GIT_AUTH_FAILED',
    credentials === undefined ? 'Git credentials required' : 'Git authentication failed', remote)
}

/**
 * 认领一次“记住这组凭据”。存储缺失、被只读来源遮蔽或远端不是 HTTPS 时，在触碰
 * 远端之前失败：远端已经改变、用户却以为凭据已保存，是更坏的结局。
 * @param url - 本次操作实际使用的远端 URL。
 * @param options - 调用方凭据与本机存储。
 * @returns 成功后要写入的落点；本次不要求记住时为 undefined。
 */
export async function claimRemember(url: string, options: GitRemoteOptions): Promise<RememberTarget | undefined> {
  if (options.credentials?.remember !== true) return undefined
  const { host } = requireRemoteIdentity(url)
  const ref = gitCredentialRef(host)
  if (options.store === undefined || !await options.store.writable(ref)) {
    throw new GitOperationError('GIT_CREDENTIALS_UNAVAILABLE', 'Git credentials cannot be remembered: this deployment has no writable credential store')
  }
  return { ref, host }
}

/**
 * 远端操作成功后写入凭据；写入失败只记录诊断，不改变已经完成的远端结果。
 * @param target - {@link claimRemember} 返回的落点。
 * @param options - 本次凭据与本机存储。
 */
export async function commitRemember(target: RememberTarget | undefined, options: GitRemoteOptions): Promise<void> {
  const credentials = options.credentials
  if (target === undefined || credentials === undefined || options.store === undefined) return
  try {
    await options.store.write(target.ref, encodeGitCredential(target.host, credentials))
  } catch (error: unknown) {
    options.warn?.(`Git credentials for ${target.host} were not saved: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 读取该主机已保存的凭据；读不到、解析不了或值不属于该主机时按未保存处理，并给出诊断。
 * @param ref - 主机对应的凭据引用。
 * @param host - 期望的远端主机。
 * @param options - 本次本机存储与诊断出口。
 * @returns 已保存的凭据，或 undefined。
 */
export async function storedCredential(
  ref: CredentialRef, host: string, options: GitRemoteOptions,
): Promise<GitCredentials | undefined> {
  const store: GitCredentialStore | undefined = options.store
  if (store === undefined) return undefined
  let value: string | undefined
  try {
    value = await store.read(ref)
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

/**
 * 临时套接字向 askpass 子进程逐项提供凭据；脚本和环境不包含机密。
 * @param credentials - 本次要提供的凭据。
 * @param signal - 调用方取消信号。
 * @param operation - 使用注入的 askpass 执行的动作。
 * @returns 动作的返回值。
 */
export async function withAskpass<T>(
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

/**
 * 按固定优先级认证一次远端命令：宿主的凭据助手、本机已保存的凭据，最后才是调用方
 * 显式提供的凭据。显式凭据一旦提供就独占本次认证，因为它来自上一轮前两级都失败的
 * 弹窗；非 HTTPS 远端既不使用助手，也不读写凭据存储。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param args - 一次 git 远端命令及其参数。
 * @param url - 该命令实际使用的远端 URL（push 用 push URL，pull 用 fetch URL）。
 * @param options - 本次的凭据来源与本机存储。
 * @param base - 本次命令的附加运行选项（输出上限、超时）；克隆使用更宽的预算。
 */
export async function remoteCommand(
  cwd: string, signal: AbortSignal, args: string[], url: string, options: GitRemoteOptions, base: GitRunOptions = {},
): Promise<void> {
  const identity = gitRemoteIdentity(url)
  if (options.credentials !== undefined && identity === undefined) requireRemoteIdentity(url)
  const attempt = async (runOptions: GitRunOptions, credentials: GitCredentials | undefined): Promise<GitOperationError | undefined> => {
    const result = await runGit(cwd, signal, args, { ...base, ...runOptions })
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
