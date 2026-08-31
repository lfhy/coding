/**
 * Vocabulary for the subprocess Service Definition: fully-specified spawn requests with
 * Node-shaped per-stream stdio modes, bounded collected output with spill
 * recovery, raw piped streams, and tree-scoped termination. Command
 * defaulting, shell semantics, protocol framing, and presentation belong to
 * consumers such as the bash executor seam.
 * @module dsh-subprocess/types
 */

import type { Readable, Writable } from 'node:stream'
import type { RemoteWorkspaceTarget } from './remote-workspace.ts'

/** Namespace prefix reserved for DeepSeek Harness-managed child environment facts. */
export const DSH_ENV_PREFIX = 'DSH_' as const

/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`

/** Trusted DeepSeek Harness variables for one child-process execution. */
export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }

/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
export interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}

/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect

/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
export interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}

/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
export interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /**
   * 已验证 Remote-SSH 工作区的执行身份。存在时 `cwd` 是该身份的远端路径，
   * Provider 在启动前复核 marker，随后在远端而非 Node Host 上运行 `argv`。
   * 普通本地调用省略此字段；以本地 marker 路径作为 cwd 的调用可由 Provider
   * 自行派生相同身份。
   */
  remoteTarget?: RemoteWorkspaceTarget | undefined
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Positive finite grace period in milliseconds, no greater than
   * `MAX_TIMER_DELAY_MS`, for the {@link SubprocessHandle.terminate} escalation
   * and for draining still-open collected pipes after the process exits (an
   * inherited descriptor held by a surviving descendant cannot hold the
   * outcome open indefinitely).
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the process tree when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Explicit environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`), with no namespace validation. A
   * string is a deliberate caller opt-in, so a forwarded credential-shaped
   * entry or current `DSH_*` fact survives the scrub; `undefined` is a
   * tombstone that removes an ordinary ambient entry from the child.
   */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
export interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}

/** One incremental {@link SubprocessOutputReader.readFrom} read. */
export interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}

/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
export interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}

/** Offset-based readers for the streams spawned in collect mode. */
export interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}

/**
 * 一个以自身进程树为根的活动子进程。退出后仍可读取收集输出；管道流归调用方所有。
 *
 * 终止始终以进程树为范围：POSIX 提供方可向 detached 进程组发信号（进程组已
 * 消失时回退到直接子进程）；Windows 提供方使用原生的受管进程树机制。此接口
 * 不把 Windows 控制动作承诺为 POSIX 信号、进程组或固定的强杀时序。
 */
export interface SubprocessHandle {
  /** Process id (tree root); -1 when the spawn itself failed. */
  readonly pid: number
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** 在进程关闭时以退出事实 resolve；若 spawn 无法完成，或活动执行世界的传输在退出前失败则 reject。 */
  readonly done: Promise<SubprocessOutcome>
  /**
   * 启动将进程树带至停止状态的 SIGTERM → `graceMs` → SIGKILL 清理流程；
   * 这是该 seam 唯一的终止动词。提供方以平台原生的受管树生命周期实现它，
   * Windows 不承诺 POSIX 信号或固定的强杀时序。操作幂等，进程树消失后为空
   * 操作（pid 可能被复用），spec 的 abort 信号也会触发它。
   */
  terminate(): void
  /**
   * Wait until the process tree has exited — the tree, not just the direct
   * child, so a still-running helper is observable before teardown returns.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, `false` when the signal aborted first.
   * @throws 当活动执行世界的传输在证明进程树退出前失败时。
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * Signals supported by the terminal-process primitive. Kept member-identical
 * to `TerminalSignal` in `@deepseek-ai/dsh-terminal` without a cross-seam dependency;
 * change both together.
 */
export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** A fully specified terminal-process spawn. */
export interface SubprocessTerminalSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. */
  argv: readonly string[]
  /** Working directory in this subprocess provider's execution world. */
  cwd: string
  /**
   * 已验证 Remote-SSH 工作区的执行身份。存在时 `cwd` 是远端工作目录；Provider
   * 在分配 PTY 前复核 marker。普通本地终端省略此字段。
   */
  remoteTarget?: RemoteWorkspaceTarget | undefined
  /** Explicit environment layered after the provider's ambient scrub. */
  env?: Record<string, string> | undefined
  /** Initial terminal row count. */
  rows: number
  /** Initial terminal column count. */
  cols: number
  /** TERM-to-KILL cleanup grace for the complete terminal session. */
  graceMs: number
  /** Cancellation of terminal allocation; a published handle owns its later lifetime. */
  signal?: AbortSignal | undefined
}

/** 一个终端当前的前台控制身份；POSIX 为进程组，Windows 可为提供方定义的兼容身份。 */
export interface SubprocessTerminalForeground {
  /** 终端驱动发布的前台控制身份；POSIX 为进程组 id，Windows 可为兼容 id。 */
  processGroupId: number
  /** 提供方能否证明该控制身份当前正在等待终端输入。 */
  inputWaiting: boolean
}

/**
 * 一个活动终端进程及其由操作系统管理的会话。终端分配、前台控制身份的检查和
 * 控制、以及会话树清理由同一项深层子进程原语承担，因为普通管道 stdio 无法在
 * 没有执行基底特定进程控制的情况下重建它们。
 */
export interface SubprocessTerminalHandle {
  /** Top-level terminal process id. */
  readonly pid: number
  /** UTF-8 terminal output bytes in delivery order; ends after queued output when the terminal exits. */
  readonly output: Readable
  /** Resolves when the top-level process exits; rejects only for a live transport failure. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Write text to the terminal input.
   * @param data - text to deliver without implicit newline conversion.
   */
  write(data: string): Promise<void>
  /**
   * 检查当前前台控制身份。
   * @returns 该身份及其输入等待事实；无法解析时返回 undefined。
   */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
  /**
   * 向当前前台控制身份请求终端控制动作。
   * @param signal - 允许的终端信号名；Windows 提供方可拒绝不具备的 POSIX 语义。
   * @returns 实际接收该动作的控制身份。
   */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number>
  /**
   * Idempotently terminate every terminal-session member the provider can still observe and await quiescence.
   * After settlement, no write, inspection, or signal call remains in flight.
   * Providers document substrate-specific observability limits.
   */
  terminate(): Promise<void>
}
