/**
 * Service Definition for the `ctx.shell` capability seam, covering foreground commands and background process
 * handles. Job ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-jobs`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from './types.ts'

/**
 * Settings namespace of this capability, owned here rather than by either
 * executor family because it names the capability, not an implementation: a
 * host composes exactly one provider of `ctx.shell` (the win32 layer swaps the
 * POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate
 * service registration), so the providers share one namespace without ever
 * registering it twice, and a settings document carried between platforms
 * keeps resolving on both.
 */
export const SHELL_SETTINGS_NAMESPACE = settingsNamespace('shell')

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * Shell 执行抽象服务。子类作为插件注册到 `ctx.shell`；同一上下文重复注册会失败。
 *
 * 实现必须遵守以下语义：
 * - {@link run} 仅在基础设施失败时 reject；非零退出、超时与取消终止均以
 *   {@link ShellRunResult} resolve。
 * - {@link start} 立即返回，后台进程不应用执行器超时。`done` 在底层结算后
 *   resolve 且不 reject；provider 无法报告退出结果时状态为 `failed`。
 *   中性提示随未读 stderr 一起交付；`kill()` 只发出终止请求，不立即宣称进程已停止。
 * - {@link ShellProcess.readOutput} 消费式增量读取；丢失未读输出时报告
 *   `lossy` 和可用的 spill 文件。
 * - 持有进程的 subprocess 服务释放时终止并等待运行中的后台进程。
 *   仅重载执行器不停止它们。
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link run}/{@link start}.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Run a command in the foreground; resolves when it finishes.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; nonzero exits, timeout kills, and abort kills
   *   resolve with a descriptive result rather than reject.
   */
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>

  /**
   * Start a background process and return its handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the live process handle (reads, kill, quiescence promise).
   */
  abstract start(spec: ShellExecSpec): ShellProcess
}

export default ShellExecutor
