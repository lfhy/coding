/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified managed process trees with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { DSH_ENV_PREFIX } from './types.ts'
import type { RemoteWorkspaceTarget } from './remote-workspace.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export {
  REMOTE_BRIDGE_TOKEN_ENV,
  REMOTE_BRIDGE_URL_ENV,
  REMOTE_WORKSPACE_MARKER,
  RemoteWorkspaceError,
  callRemoteWorkspaceBridge,
  isRemoteAbsolutePath,
  isRemotePathWithin,
  parseRemoteWorkspaceTargetKey,
  readRemoteWorkspaceMarker,
  remoteWorkspaceLocalPath,
  remoteWorkspacePath,
  remoteWorkspacePathSync,
  remoteWorkspaceTargetKey,
  verifyRemoteWorkspaceTarget,
} from './remote-workspace.ts'
export type {
  RemoteWorkspace,
  RemoteWorkspaceErrorCode,
  RemoteWorkspacePath,
  RemoteWorkspaceTarget,
} from './remote-workspace.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The ambient parent environment minus credential-shaped names and minus all
 * `DSH_*` names — the canonical base every harness child starts from. `PATH`,
 * `HOME`, locale, and proxy variables survive, so child CLIs run normally;
 * harness identity never leaks implicitly (a deliberately forwarded
 * credential or current `DSH_*` fact goes through the spec's explicit `env`,
 * which merges after this scrub). Both scrubs match case-insensitively:
 * Windows environment names are case-insensitive, so a parent `dsh_*` entry
 * would otherwise survive and read back as `$env:DSH_*` in the child;
 * deliberate lowercase `dsh_*` names on POSIX are implausible. Exported as a plain function so spawners
 * that cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  return env
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * Abstract subprocess service. Subclass, implement {@link spawn}, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Executable paths belong to one execution world shared with the mounted
 *   filesystem provider.
 * - {@link spawn} 会立即返回活动句柄；`done` 在进程关闭时以退出事实 resolve；
 *   若 spawn 无法完成或活动执行世界的传输在退出前失败则 reject。
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.terminate}（及 spec 的 abort 信号）启动以进程树为范围的 TERM→宽限→KILL 清理。
 *   它是唯一的终止动词。POSIX 提供方可使用 detached 进程组；Windows 提供方使用原生的受管树机制。
 *   此接口不承诺 Windows 的 POSIX 信号、进程组或固定的强杀时序。
 *   {@link SubprocessHandle.waitForExit} 观察整棵进程树的存活状态。
 *   若活动执行世界的传输在证明退出前失败，该 promise 会 reject，不能伪造停稳。
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 * - {@link spawnTerminal} 负责终端分配、文本传输、前台控制身份与终端特定控制。
 *   它还提供一项须等待的完整会话停稳操作。
 *   POSIX 前台身份为进程组，Windows 可使用提供方定义的兼容身份。
 *   就绪状态与持久 shell 策略仍归 PTY 消费方所有。
 *   顶层进程退出后，其输出流会在已排队的终端输出之后结束。
 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Resolve one configured executable in this provider's execution world.
   * Absolute paths are verified; bare names use the provider's scrubbed PATH
   * plus explicit environment overrides. Relative paths containing separators
   * are rejected: the resolution base is undefined, so providers fail loud
   * instead of guessing.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts remote or local lookup.
   * @param remoteTarget - 可选的已验证 Remote-SSH 执行身份。
   * @returns a canonical executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    remoteTarget?: RemoteWorkspaceTarget,
  ): Promise<string>

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

  /**
   * 分配真实控制终端并启动一个由提供方管理的进程会话。这是唯一的非 pipe
   * 进程原语：实现负责终端字节 I/O、前台控制身份、终端特定控制动作及完整
   * 会话树清理。
   * @param spec - 完全指定的 argv、cwd、环境、尺寸、宽限期与分配取消。
   * @returns 分配成功后的活动终端句柄。
   */
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessRuntime
