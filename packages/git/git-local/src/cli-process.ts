/** 本机 `git` 子进程的启动、环境与失败归一。 @module coding-git-local/cli-process */

import { spawn } from 'node:child_process'
import { GitOperationError } from 'coding-git'
import { remoteWorkspacePath } from 'coding-subprocess'

/** 单次命令连同 stderr 的输出上限。 */
export const OUTPUT_LIMIT = 4 * 1024 * 1024
/** 单次命令的超时；克隆使用更宽的独立预算。 */
export const COMMAND_TIMEOUT = 60_000

/** 一次 `git` 调用的结果；非零退出码由调用方决定是否算失败。 */
export interface GitOutput {
  stdout: string
  stderr: string
  code: number
}

/** 一次 `git` 调用的附加选项。 */
export interface GitRunOptions {
  askpass?: string
  socket?: string
  /** 允许宿主配置的凭据助手（credential.helper）参与认证；默认禁用。 */
  helper?: boolean
  /** 本次命令连同 stderr 的独立输出上限；历史读取使用更紧的预算。 */
  outputLimit?: number
  /** 本次命令的超时覆盖；克隆使用更宽的预算。 */
  timeout?: number
}

/**
 * 子进程环境。终端提示、SSH 交互提示与宿主凭据助手默认全部禁用，凭据只能来自
 * 本次注入的 askpass；只有 helper 为真时才保留宿主配置的助手链。
 * @param options - 本次调用的 askpass 与助手开关。
 * @returns 该子进程的完整环境变量。
 */
export function gitEnv(options: GitRunOptions): NodeJS.ProcessEnv {
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

/**
 * 在给定目录运行一次 `git`。
 * @param cwd - 命令工作目录。
 * @param signal - 调用方取消信号。
 * @param args - 命令及其参数。
 * @param options - 环境、输出上限与超时。
 * @returns 命令的完整输出与退出码；启动失败与超时以 {@link GitOperationError} 拒绝。
 */
export function runGit(cwd: string, signal: AbortSignal, args: string[], options: GitRunOptions = {}): Promise<GitOutput> {
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
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeout ?? COMMAND_TIMEOUT)
    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.outputLimit ?? OUTPUT_LIMIT)) {
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

/**
 * 把一次失败命令归一为错误。
 * @param result - 失败的调用结果。
 * @param fallback - 无法识别冲突时使用的失败码。
 * @returns 带冲突识别的错误。
 */
export function failure(result: GitOutput, fallback: GitOperationError['code'] = 'GIT_FAILED'): GitOperationError {
  const diagnostic = `${result.stderr}\n${result.stdout}`
  const conflict = /conflict|not possible to fast-forward|divergent|would be overwritten|unmerged|non-fast-forward/i.test(diagnostic)
  return new GitOperationError(conflict ? 'GIT_CONFLICT' : fallback, 'Git command failed')
}

/**
 * 运行一次必须成功的命令。
 * @param cwd - 命令工作目录。
 * @param signal - 调用方取消信号。
 * @param args - 命令及其参数。
 * @param code - 失败时的覆盖码。
 * @returns 命令的标准输出。
 */
export async function checked(cwd: string, signal: AbortSignal, args: string[], code?: GitOperationError['code']): Promise<string> {
  const result = await runGit(cwd, signal, args)
  if (result.code !== 0) throw failure(result, code)
  return result.stdout
}

/**
 * 确认该目录是可操作的本地工作树；远端 marker 目录从不调用本机 Git。
 * @param cwd - 待检查目录。
 * @param signal - 调用方取消信号。
 * @returns 是工作树时为 true，不是仓库时为 false。
 * @throws {GitOperationError} 目录属于远端工作区或无法检查。
 */
export async function guard(cwd: string, signal: AbortSignal): Promise<boolean> {
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

/**
 * 读取当前分支短名。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @returns 分支短名；游离 HEAD 为 null。
 */
export async function branchName(cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await runGit(cwd, signal, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (result.code === 1) return null
  if (result.code !== 0) throw failure(result)
  return result.stdout.trim()
}

/**
 * 读取当前分支的上游远端及其两个 URL。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @returns 上游名与 fetch／push URL。
 */
export async function upstream(cwd: string, signal: AbortSignal): Promise<{ name: string; fetchUrl: string; pushUrl: string }> {
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
