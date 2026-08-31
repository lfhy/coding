# Subprocess

English | [中文](subprocess.zh.md)

The subprocess seam is split across a Service Definition ([dsh-subprocess](../../packages/subprocess/subprocess), `ctx.subprocess`) and Service Provider ([dsh-subprocess-local](../../packages/subprocess/subprocess-local)); its Consumers are other capability seams and out-of-process backends: the [bash executor family](shell.md) uses collected batch output, LSP uses raw protocol pipes, the PTY backend uses the terminal primitive, and the ACP subagent backend uses piped ndjson plus inherited stderr. This seam owns the managed `DSH_*` environment namespace, the shared credential scrub (`scrubbedParentEnv`), and the `CollectedOutput` shape; [dsh-shell](../../packages/shell/shell) re-exports the vocabulary so bash consumers keep one import root.

Source: [`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts), [`packages/subprocess/subprocess/src/index.ts`](../../packages/subprocess/subprocess/src/index.ts), and [`packages/subprocess/subprocess/src/remote-workspace.ts`](../../packages/subprocess/subprocess/src/remote-workspace.ts)

## Executable lookup

One provider's spawn working directories, executable paths, ordinary processes, and terminal sessions inhabit the same path and process namespace as the mounted filesystem provider. `resolveExecutable(command, env?, signal?, remoteTarget?)` verifies absolute executable paths or resolves bare names through the provider's scrubbed `PATH` plus deliberate overrides. A caller that already has a verified Remote-SSH target supplies it on lookup and `SubprocessSpawnSpec`; the provider revalidates that marker identity before selecting the target rather than treating a local marker alias as a process directory. The remote root is a request-time execution coordinate and path constraint, not an OS sandbox; it does not defend against a target-side concurrent replacement of a checked symlink or ancestor.

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

## Managed environment namespace and captured output

`DSH_*` variables are Harness-owned child-process facts; implementations discard ambient `DSH_*` names before the caller's explicit `env` merges, so a current fact arrives only as a deliberate string entry, while an explicit `undefined` tombstone removes an ordinary ambient value. Each collected stream reports its truncation and spill-recovery state through `CollectedOutput`.

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

## Node-shaped stdio dispositions

Each stream's disposition is explicit, chosen per consumer: raw pipes for protocol framing (LSP JSON-RPC, ACP ndjson), inherit for pass-through diagnostics, and collect mode for bounded batch output — with the spill file optional, so a diagnostic tail (a language server's stderr) buffers without leaving files behind.

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

## The fully-explicit spawn spec

The seam applies no defaults: every disposition, limit, and directory is explicit on the spec, so the caller's own config — not a hidden subprocess-service default — decides them. `argv` is never shell-interpreted.

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

## Handles: streams, readers, and tree-scoped termination

A spawn returns a live handle immediately. Collect-mode readers take whole-stream byte offsets and never consume, so independent readers cannot steal one another's deltas; piped streams belong to the caller. Termination is tree-scoped: POSIX providers may use detached process groups, while Windows providers use their native managed-tree lifecycle. `terminate()` — the only termination verb — starts the seam's TERM→grace→KILL cleanup, and `waitForExit()` observes the whole tree — enough for a consumer to build its own teardown ladder (the ACP backend's stdin-EOF-first `disposeAcpChild` is the template). Providers document platform control semantics and timing. When an active execution-world transport fails before it proves exit, `done` and `waitForExit()` reject rather than inventing exit facts.

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


## Outcomes carry exit facts only

`done` reports Node's close-event vocabulary and no cause classification — the service kills on abort but never decides why (the caller reads the deadline signal it owns, e.g. the bash executor's `timedOut`/`aborted` split). Collected output stays readable through `handle.collected` after settlement, so batch and streaming callers share one access path.

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

## Terminal-process primitive

`spawnTerminal(spec)` is the non-pipe process primitive. The provider allocates the controlling terminal and owns UTF-8 text transport, foreground-control-identity inspection and terminal-specific control, and one awaited termination operation that reaches quiescence for every session member it can still observe. On POSIX the identity is a foreground process group; a Windows provider may publish a provider-defined compatibility identity. The PTY backend remains responsible for prompt detection, readiness inference, scrollback, sandbox policy, and persistent-session ownership; ordinary `spawn()` cannot reconstruct controlling-terminal semantics.

The terminal spec fully specifies argv, cwd, environment overrides, dimensions, cleanup grace, and optional allocation cancellation. Its handle exposes `pid`, ordered output, `done`, `write`, `inspectForeground`, `signalForeground`, and awaited `terminate`; the exact public shapes are generated into the [`ctx.subprocess` service catalog](#ctxsubprocess--subprocessruntime-abstract-seam).

## Service behavior

The abstract [`SubprocessRuntime`](../../packages/subprocess/subprocess/src/index.ts) Service Definition specifies execution-world coordinates, executable lookup, ordinary `spawn`, and `spawnTerminal`. [`LocalSubprocessRuntime`](../../packages/subprocess/subprocess-local/src/index.ts) provides local calls with detached process trees, per-disposition wiring, credential scrubbing, `node-pty`, platform process inspection, and terminate-and-join disposal; it forwards a verified Remote-SSH marker target to its Go agent. See [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md) for the Service Definition contract and [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md) for provider-specific mechanics and limits.

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
