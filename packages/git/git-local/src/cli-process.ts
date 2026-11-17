/** `git` 命令的启动、环境与失败归一：本机工作区走子进程，远端工作区走 subprocess seam。
 * @module coding-git-local/cli-process */

import { spawn } from 'node:child_process'
import { GitOperationError } from 'coding-git'
import type { SubprocessOutcome, SubprocessOutputReader, SubprocessRuntime } from 'coding-subprocess'

/** 单次命令连同 stderr 的输出上限。 */
export const OUTPUT_LIMIT = 4 * 1024 * 1024
/** 单次命令的超时；克隆使用更宽的独立预算。 */
export const COMMAND_TIMEOUT = 60_000
/** 远端命令的 stderr 收集上限：只用于失败分类，不必与 stdout 一样宽。 */
export const REMOTE_STDERR_LIMIT = 512 * 1024
/** 远端命令终止时的升级宽限期；远端进程树停稳前结束会留下孤儿。 */
export const REMOTE_GRACE_MS = 3_000

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
 * 一次 Git 调用的执行世界。本机工作区直接起子进程；远端 marker 工作区把同一条
 * `git` 命令交给 `ctx.subprocess` 在远端主机上运行，认证材料也只能来自远端主机。
 */
export interface GitExecutor {
  /** 目标是否是远端 SSH 工作区；决定凭据来源与工作树位置。 */
  readonly remote: boolean
  /**
   * 在工作区的 `cwd` 里运行一次 git。
   * @param cwd - 仓库工作目录（远端工作区是该会话的 marker 占位路径）。
   * @param signal - 调用方取消信号。
   * @param args - `git` 的参数（不含 `git --no-pager` 前缀）。
   * @param options - 环境、输出上限与超时。
   * @returns 完整输出与退出码。
   */
  run(cwd: string, signal: AbortSignal, args: string[], options?: GitRunOptions): Promise<GitOutput>
}

/** 本机执行器：与子进程语义一致，命名让调用点显式表达「本机」。 */
export const LOCAL_GIT: GitExecutor = { remote: false, run: runGit }

/**
 * 远端执行器：经 subprocess seam 在 SSH 工作区里运行 `git`，本地不执行任何命令。
 * @param subprocess - 已挂载的 subprocess seam。
 * @returns 面向远端工作区的执行器。
 */
export function remoteGit(subprocess: SubprocessRuntime): GitExecutor {
  return {
    remote: true,
    run: (cwd, signal, args, options = {}) => runGitRemote(subprocess, cwd, signal, args, options),
  }
}

/**
 * 远端命令环境：只带固定变量，绝不转发宿主进程环境。宿主凭据助手与 askpass 在远端
 * 没有意义（脚本在宿主上），因此认证完全交给远端主机自己的 git 配置与凭据助手；
 * 交互提示一律关闭，避免命令在没有任何人可以回答的终端里等待。
 * @param options - 本次调用的助手开关。
 * @returns 该远端命令的完整环境变量。
 */
export function remoteGitEnv(options: GitRunOptions): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = options.helper === true ? [] : [['credential.helper', '']]
  config.push(['core.askPass', ''])
  const env: NodeJS.ProcessEnv = {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_CONFIG_COUNT: String(config.length),
  }
  config.forEach(([key, value], index) => {
    env['GIT_CONFIG_KEY_' + String(index)] = key
    env['GIT_CONFIG_VALUE_' + String(index)] = value
  })
  return env
}

/**
 * 读取一份收集输出；`lossy` 说明整段输出超过本次上限，调用方按失败处理（与本地
 * 实现的「输出超过上限」同类），不返回被截断的文本冒充完整结果。
 * @param reader - 请求过的 collected 读取器。
 * @returns 保留的文本与是否被截断。
 */
function readCollected(reader: SubprocessOutputReader | undefined): { text: string; truncated: boolean } {
  if (reader === undefined) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy }
}

/**
 * 在远端执行世界中运行一次 git：输出按本次上限收集，超时或取消由 subprocess seam
 * 终止整棵远端进程树（远端无法证明停稳时以失败结束，绝不退回本机执行）。
 * @param subprocess - 已挂载的 subprocess seam。
 * @param cwd - 远端工作区的 marker 占位路径；seam 由它派生远端执行身份。
 * @param signal - 调用方取消信号。
 * @param args - `git` 的参数（不含 `git --no-pager` 前缀）。
 * @param options - 环境、输出上限与超时。
 * @returns 完整输出与退出码。
 */
async function runGitRemote(
  subprocess: SubprocessRuntime,
  cwd: string,
  signal: AbortSignal,
  args: string[],
  options: GitRunOptions,
): Promise<GitOutput> {
  signal.throwIfAborted()
  const stdoutLimit = options.outputLimit ?? OUTPUT_LIMIT
  const handle = subprocess.spawn({
    argv: ['git', '--no-pager', ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: stdoutLimit },
      stderr: { maxBytes: Math.min(stdoutLimit, REMOTE_STDERR_LIMIT) },
    },
    graceMs: REMOTE_GRACE_MS,
    signal,
    env: remoteGitEnv(options),
  })
  // 截止时间归调用方：到期先终止远端进程树，`undefined` 结算表示这次命令超时。
  const outcome = await new Promise<SubprocessOutcome | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.terminate()
      resolve(undefined)
    }, options.timeout ?? COMMAND_TIMEOUT)
    handle.done.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  }).catch(() => {
    signal.throwIfAborted()
    throw new GitOperationError('GIT_FAILED', 'Git command could not run on the remote host')
  })
  if (signal.aborted) throw new Error('Git command was cancelled')
  if (outcome === undefined) throw new GitOperationError('GIT_FAILED', 'Git command timed out or was terminated')
  const stdout = readCollected(handle.collected.stdout)
  const stderr = readCollected(handle.collected.stderr)
  if (stdout.truncated) throw new GitOperationError('GIT_FAILED', 'Git output exceeded the size limit')
  if (outcome.exitCode === 127 && /not found/i.test(stderr.text)) {
    throw new GitOperationError('GIT_UNAVAILABLE', 'Git is not installed on the remote host')
  }
  return { stdout: stdout.text, stderr: stderr.text, code: outcome.exitCode ?? 1 }
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
 * @param exec - 本次调用的执行世界。
 * @param cwd - 命令工作目录。
 * @param signal - 调用方取消信号。
 * @param args - 命令及其参数。
 * @param code - 失败时的覆盖码。
 * @returns 命令的标准输出。
 */
export async function checked(
  exec: GitExecutor,
  cwd: string,
  signal: AbortSignal,
  args: string[],
  code?: GitOperationError['code'],
): Promise<string> {
  const result = await exec.run(cwd, signal, args)
  if (result.code !== 0) throw failure(result, code)
  return result.stdout
}

/**
 * 确认该目录在该执行世界里是可操作的工作树。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 待检查目录。
 * @param signal - 调用方取消信号。
 * @returns 是工作树时为 true，不是仓库时为 false。
 */
export async function guard(exec: GitExecutor, cwd: string, signal: AbortSignal): Promise<boolean> {
  const result = await exec.run(cwd, signal, ['rev-parse', '--is-inside-work-tree'])
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return false
    throw failure(result)
  }
  if (result.stdout.trim() !== 'true') throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git working tree')
  return true
}

/**
 * 读取当前分支短名。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @returns 分支短名；游离 HEAD 为 null。
 */
export async function branchName(exec: GitExecutor, cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await exec.run(cwd, signal, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (result.code === 1) return null
  if (result.code !== 0) throw failure(result)
  return result.stdout.trim()
}

/**
 * 读取当前分支的上游远端及其两个 URL。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @returns 上游名与 fetch／push URL。
 */
export async function upstream(
  exec: GitExecutor,
  cwd: string,
  signal: AbortSignal,
): Promise<{ name: string; fetchUrl: string; pushUrl: string }> {
  const result = await exec.run(cwd, signal, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (result.code !== 0) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'No upstream is configured')
  const name = result.stdout.trim()
  const slash = name.indexOf('/')
  if (slash < 1 || slash === name.length - 1) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream has no remote branch')
  const remote = name.slice(0, slash)
  const url = await checked(exec, cwd, signal, ['remote', 'get-url', remote], 'GIT_REMOTE_UNAVAILABLE')
  if (!url.trim()) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream remote has no URL')
  const pushUrl = await checked(exec, cwd, signal, ['remote', 'get-url', '--push', remote], 'GIT_REMOTE_UNAVAILABLE')
  if (!pushUrl.trim()) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream remote has no push URL')
  return { name, fetchUrl: url.trim(), pushUrl: pushUrl.trim() }
}
