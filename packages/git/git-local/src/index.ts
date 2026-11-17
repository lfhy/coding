/**
 * 本机 Git 提供方：有 `git` 可执行文件时驱动它，没有时用内置的纯 JavaScript
 * 实现完成克隆。两种机制共享同一套凭据优先级与失败词汇，因此创建面板只需要
 * 一个 `ctx.git` 服务。
 * @module coding-git-local
 */

import { Git, GitOperationError, GIT_OPERATIONS } from 'coding-git'
import type {
  GitBranches, GitCapability, GitCloneInput, GitCloneResult, GitHistory, GitHistoryQuery,
  GitOperationResult, GitRemoteOptions, GitStatus,
} from 'coding-git'
import { remoteWorkspacePath } from 'coding-subprocess'
import { LOCAL_GIT, remoteGit, runGit } from './cli-process.ts'
import type { GitExecutor } from './cli-process.ts'
import { cliBranches, cliCheckout, cliHistory, cliPull, cliPush, cliStatus } from './cli-repository.ts'
import { cloneWithCli, cloneWithJs } from './clone.ts'

/** 能力探测的命令预算：只回答“有没有可执行文件”，不等待网络或仓库。 */
const PROBE_TIMEOUT = 5_000

/** Cordis 插件名。 */
export const name = 'git-local'

/**
 * 本机 Git 服务。`git` 可执行文件在首次使用时探测并缓存结果；探测不到时克隆仍
 * 可用（内置实现），其余仓库操作以 `GIT_UNAVAILABLE` 明确失败。
 */
export default class GitLocal extends Git {
  private probe: Promise<boolean> | undefined

  /** 本机是否有可执行的 `git`；结果在服务生命周期内缓存。 */
  private cliAvailable(): Promise<boolean> {
    this.probe ??= runGit(process.cwd(), new AbortController().signal, ['--version'], { timeout: PROBE_TIMEOUT })
      .then(result => result.code === 0)
      .catch(() => false)
    return this.probe
  }

  async capability(): Promise<GitCapability> {
    return await this.cliAvailable()
      ? { mechanism: 'cli', operations: GIT_OPERATIONS }
      : { mechanism: 'js', operations: ['clone'] }
  }

  /**
   * 该仓库工作区的执行世界：会话工作区带 marker 时用 subprocess seam 在远端主机上
   * 运行 git，其他路径沿用本机子进程。远端能力缺失或 marker 不可读时明确失败，绝不
   * 把远端仓库当成宿主目录来读。
   * @param cwd - 会话记录里的工作目录。
   * @param signal - 调用方取消信号。
   * @returns 本次调用使用的执行器。
   */
  private async executor(cwd: string, signal: AbortSignal): Promise<GitExecutor> {
    let remote: Awaited<ReturnType<typeof remoteWorkspacePath>>
    try {
      remote = await remoteWorkspacePath('.', cwd, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof GitOperationError) throw error
      throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot verify whether the workspace is a remote workspace')
    }
    if (remote === undefined) return LOCAL_GIT
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git in remote workspaces needs the subprocess capability')
    }
    return remoteGit(subprocess)
  }

  private async requireCli(): Promise<void> {
    if (await this.cliAvailable()) return
    throw new GitOperationError('GIT_UNAVAILABLE', 'Git is not installed; only cloning is available through the built-in implementation')
  }

  async status(cwd: string, signal: AbortSignal): Promise<GitStatus | null> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliStatus(exec, cwd, signal)
  }

  async branches(cwd: string, signal: AbortSignal): Promise<GitBranches | null> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliBranches(exec, cwd, signal)
  }

  async history(cwd: string, signal: AbortSignal, query: GitHistoryQuery): Promise<GitHistory | null> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliHistory(exec, cwd, signal, query)
  }

  async checkout(cwd: string, signal: AbortSignal, branch: string): Promise<GitStatus> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliCheckout(exec, cwd, signal, branch)
  }

  async push(cwd: string, signal: AbortSignal, options: GitRemoteOptions = {}): Promise<GitOperationResult> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliPush(exec, cwd, signal, options)
  }

  async pull(cwd: string, signal: AbortSignal, options: GitRemoteOptions = {}): Promise<GitOperationResult> {
    const exec = await this.executor(cwd, signal)
    if (!exec.remote) await this.requireCli()
    return cliPull(exec, cwd, signal, options)
  }

  async clone(input: GitCloneInput, signal: AbortSignal, options: GitRemoteOptions = {}): Promise<GitCloneResult> {
    if (await this.cliAvailable()) return cloneWithCli(input, signal, () => Promise.resolve(true), options)
    return cloneWithJs(input, signal, options)
  }
}
