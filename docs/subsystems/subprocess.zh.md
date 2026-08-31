# 子进程

[English](subprocess.md) | 中文

子进程 seam 分为 Service Definition（[dsh-subprocess](../../packages/subprocess/subprocess)，`ctx.subprocess`）与 Service Provider（[dsh-subprocess-local](../../packages/subprocess/subprocess-local)）；它的 Consumer 是其他能力 seam 与进程外后端：[bash 执行器家族](shell.md)使用收集模式的批量输出，LSP 使用原始协议管道，PTY 后端使用终端原语，ACP（Agent Client Protocol）subagent 后端则使用通过管道传输的 ndjson，并让 stderr 采用 inherit。该 seam 拥有受管的 `DSH_*` 环境命名空间、共享的凭据清除（`scrubbedParentEnv`）与 `CollectedOutput` 形状；[dsh-shell](../../packages/shell/shell) 重导出这套词汇，使 bash 消费方保持单一导入入口。

源码：[`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts)、[`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts) 与 [`packages/subprocess/subprocess/src/remote-workspace.ts`](../../packages/subprocess/subprocess/src/remote-workspace.ts)

## 可执行文件查找

一个提供方的 spawn 工作目录、可执行文件路径、普通进程与终端会话，和挂载的文件系统提供方处于同一路径与进程命名空间。`resolveExecutable(command, env?, signal?, remoteTarget?)` 验证绝对可执行文件路径，或通过提供方清理后的 `PATH` 加有意覆盖来解析裸名称。调用方已有已验证的 Remote-SSH target 时，会在查找和 `SubprocessSpawnSpec` 中传入它；提供方会在选择该 target 前重新验证 marker 身份，不会把本地 marker 别名当作进程目录。远程根目录只是请求解析时的执行坐标和路径约束，不是 OS 沙箱；它不能防御目标侧并发替换已检查的符号链接或祖先目录。

```ts type-equiv
/** 已验证 marker 的当前身份；connectionId 不是凭据。 */
interface RemoteWorkspace {
  /** marker 目录的真实本地路径，用于防止伪造 targetKey 跨工作区。 */
  markerRoot: string
  /** marker 声明且由目录选择流程规范化的远端绝对目录。 */
  remoteRoot: string
  /** 多个 SSH 连接共用一个本地 bridge 时的路由 id。 */
  connectionId: string
  /** 与 marker 文件同轮发布的单调 generation。 */
  markerGeneration: number
}
```

```ts type-equiv
/** 已验证的无凭据远端执行身份；可编码为 FsTargetKey。 */
interface RemoteWorkspaceTarget extends RemoteWorkspace {
  /** 已解析并受 remoteRoot 限制的远端路径。 */
  remotePath: string
}
```

## 受管环境命名空间与捕获的输出

`DSH_*` 变量是归 Harness 所有的子进程事实；实现会在合并调用方显式 `env` 之前丢弃环境中已有的 `DSH_*` 名称，因此当前事实只会以有意提供的字符串条目形式到达，而显式的 `undefined` tombstone 会删除普通环境中已有的值。每条被收集的流都通过 `CollectedOutput` 报告自身的截断与 spill 恢复状态。

```ts type-equiv
/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
/** Trusted DeepSeek Harness variables for one child-process execution. */
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

```ts type-equiv
/** One captured stream: the (possibly truncated) text plus recovery info. */
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## Node 风格的 stdio 处置方式（disposition）

每条流的处置方式都显式给出，由各消费方自行选择：原始管道用于协议分帧（LSP JSON-RPC、ACP ndjson），inherit 用于直通的诊断输出，收集模式用于有界的批量输出；其中 spill 文件是可选的，因此诊断尾部（语言服务器的 stderr）可以只在内存中缓冲，不留下任何文件。

```ts type-equiv
/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
```

```ts type-equiv
/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}
```

```ts type-equiv
/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
```

```ts type-equiv
/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```

## 完全显式的 spawn spec

该 seam 不应用任何默认值：每项处置方式、限制与目录都在 spec 上显式给出，因此由调用方自己的配置决定它们，而不是由某个隐藏的子进程服务默认值决定。`argv` 绝不经过 shell 解释。

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-shell`
 * request/spec split is the owning template).
 */
interface SubprocessSpawnSpec {
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
```

## 句柄：流、读取器与以进程树为范围的终止

spawn 会立即返回一个活动句柄。收集模式的读取器接受全流字节偏移量且从不消费，因此独立的读取器不会抢走彼此的增量；管道化的流归调用方所有。终止以进程树为范围：POSIX 提供方可使用 detached 进程组，Windows 提供方则使用原生的受管树生命周期。`terminate()`（唯一的终止动词）启动该 seam 的 TERM→宽限→KILL 清理流程，`waitForExit()` 观察整棵进程树。这足以让消费方构建自己的分级清理流程；ACP 后端的 `disposeAcpChild` 会先关闭 stdin，让子进程收到 EOF，是仓库内的参考实现。各提供方会记录平台控制语义与时序。活动执行世界的传输在证明退出前失败时，`done` 与 `waitForExit()` 会 reject，绝不伪造退出事实。

```ts type-equiv
/**
 * 一个以自身进程树为根的活动子进程。退出后仍可读取收集输出；管道流归调用方所有。
 *
 * 终止始终以进程树为范围：POSIX 提供方可向 detached 进程组发信号（进程组已
 * 消失时回退到直接子进程）；Windows 提供方使用原生的受管进程树机制。此接口
 * 不把 Windows 控制动作承诺为 POSIX 信号、进程组或固定的强杀时序。
 */
interface SubprocessHandle {
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
```

```ts type-equiv
/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
 */
interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}
```

```ts type-equiv
/** One incremental {@link SubprocessOutputReader.readFrom} read. */
interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}
```

```ts type-equiv
/** Offset-based readers for the streams spawned in collect mode. */
interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}
```


## 结果只承载退出事实

`done` 报告 Node close 事件的词汇，不携带原因分类：服务会在中止时终止进程，但绝不判定原因（调用方读取归自己所有的 deadline 信号，例如 bash 执行器的 `timedOut`/`aborted` 拆分）。收集到的输出在结算后仍可经 `handle.collected` 读取，因此批量与流式调用方共用一条访问路径。

```ts type-equiv
/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}
```

## 终端进程原语

`spawnTerminal(spec)` 是非管道进程原语。提供方分配控制终端，并负责 UTF-8 文本传输、前台控制身份检查与终端特定控制，以及一项须等待的终止操作；该操作会使提供方仍可观察到的每个会话成员完全停稳。在 POSIX 上，该身份是前台进程组；Windows 提供方可以发布自身定义的兼容身份。PTY 后端仍负责提示符检测、就绪推断、scrollback、沙箱策略和持久会话所有权；普通 `spawn()` 无法重建控制终端语义。

终端 spec 完全指定 argv、cwd、环境覆盖、尺寸、清理宽限期与可选的分配取消。其句柄公开 `pid`、有序输出、`done`、`write`、`inspectForeground`、`signalForeground` 和须等待的 `terminate`；确切的公共形状生成到 [`ctx.subprocess` 服务目录](#ctxsubprocess--subprocessruntime-abstract-seam)中。

## 服务行为

抽象的 [`SubprocessRuntime`](../../packages/subprocess/subprocess/src/index.ts) Service Definition 规定执行世界坐标、可执行文件查找、普通 `spawn` 与 `spawnTerminal`。[`LocalSubprocessRuntime`](../../packages/subprocess/subprocess-local/src/index.ts) 用 detached 进程树、按处置方式接线、凭据清除、`node-pty`、平台进程检查，以及先终止再等待退出的资源释放处理本地调用；它会把已验证的 Remote-SSH marker target 转发给 Go agent。Service Definition 约定见 [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md)，提供方特有的机制与限制见 [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bruntime"></a>

### `ctx.e2b` — `E2BRuntime`

Creates one lazily consumable E2B SDK handle and deletes the sandbox at timeout or disposal. Creation begins at plugin construction; adapters await getSandbox before their first operation.

```ts cordis-catalog
/**
 * Return the shared live SDK handle.
 * @returns the created sandbox after the configured cwd exists.
 * @throws when E2B rejects creation or the service is disposing.
 */
async getSandbox(): Promise<Sandbox>
```

Source: [`packages/e2b/e2b/src/index.ts:74`](../../packages/e2b/e2b/src/index.ts)

<a id="ctxsubprocess--subprocessruntime-abstract-seam"></a>

### `ctx.subprocess` — `SubprocessRuntime` (abstract seam)

Abstract subprocess service. Subclass, implement spawn, and load the subclass as a plugin — it registers as `ctx.subprocess` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Executable paths belong to one execution world shared with the mounted filesystem provider.
- spawn 会立即返回活动句柄；`done` 在进程关闭时以退出事实 resolve； 若 spawn 无法完成或活动执行世界的传输在退出前失败则 reject。
- Collect-mode readers are offset-based and non-consuming, so independent readers never consume one another's output; lossy reads report truncation and the spill file holding the complete stream when one exists. Piped streams are handed to the caller raw and never buffered here.
- SubprocessHandle.terminate（及 spec 的 abort 信号）启动以进程树为范围的 TERM→宽限→KILL 清理。 它是唯一的终止动词。POSIX 提供方可使用 detached 进程组；Windows 提供方使用原生的受管树机制。 此接口不承诺 Windows 的 POSIX 信号、进程组或固定的强杀时序。 SubprocessHandle.waitForExit 观察整棵进程树的存活状态。 若活动执行世界的传输在证明退出前失败，该 promise 会 reject，不能伪造停稳。
- Disposal of the service terminates all still-running managed processes and awaits their exit.
- spawnTerminal 负责终端分配、文本传输、前台控制身份与终端特定控制。 它还提供一项须等待的完整会话停稳操作。 POSIX 前台身份为进程组，Windows 可使用提供方定义的兼容身份。 就绪状态与持久 shell 策略仍归 PTY 消费方所有。 顶层进程退出后，其输出流会在已排队的终端输出之后结束。

```ts cordis-catalog
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
abstract resolveExecutable( command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, remoteTarget?: RemoteWorkspaceTarget, ): Promise<string>

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
```

Source: [`packages/subprocess/subprocess/src/index.ts:125`](../../packages/subprocess/subprocess/src/index.ts)
<!-- END GENERATED cordis-surface -->
