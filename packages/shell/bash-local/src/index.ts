/**
 * Bash 执行器：本地及 agent 模式使用受管 subprocess；basic 模式前台通过
 * bridge 运行一次 SSH exec，后台使用 bridge 的受管进程。命令默认值、环境与输出处理属于本模块，
 * 执行审批属于 `tools/pre-execute` 或沙箱执行器。
 * @module @deepseek-ai/dsh-bash-local
 */

import { constants } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellProcessRead, ShellRunResult, CollectedOutput } from '@deepseek-ai/dsh-shell'
import {
  callRemoteWorkspaceBridge,
  RemoteWorkspaceError,
  requireRemoteWorkspaceCapability,
  remoteWorkspacePathSync,
  scrubbedParentEnv,
  verifyRemoteWorkspaceTarget,
} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * 关闭颜色、分页器与交互式终端特性；显式调用方环境可以覆盖这些默认值。
 * 本地/agent 由 subprocess 清除 ambient 凭据，basic 在请求前使用同一清除函数。
 * basic 的显式环境经 SSH stdin 帧传输，不进入 SSH exec 命令行。
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config; matches OpenCode's 3s). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

const DIRECT_EXEC_OUTPUT_MAX_BYTES = 1 << 20

/** 远端单次执行响应只有已结算退出事实才能映射为 ShellRunResult。 */
function parseDirectExecResponse(value: unknown): {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
} {
  const invalid = (): never => { throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote SSH exec returned an invalid response') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  const required = ['exitCode', 'timedOut', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated']
  if (required.some(key => !Object.hasOwn(record, key))
    || Object.keys(record).some(key => !required.includes(key) && key !== 'signal')
    || typeof record.timedOut !== 'boolean' || typeof record.stdout !== 'string' || typeof record.stderr !== 'string'
    || typeof record.stdoutTruncated !== 'boolean' || typeof record.stderrTruncated !== 'boolean'
    || Buffer.byteLength(record.stdout, 'utf8') > DIRECT_EXEC_OUTPUT_MAX_BYTES
    || Buffer.byteLength(record.stderr, 'utf8') > DIRECT_EXEC_OUTPUT_MAX_BYTES
    || (record.exitCode !== null && (typeof record.exitCode !== 'number' || !Number.isSafeInteger(record.exitCode) || record.exitCode < 0))) return invalid()
  const rawSignal = record.signal
  if (rawSignal !== undefined && typeof rawSignal !== 'string') return invalid()
  const signal = rawSignal === undefined ? null : `SIG${rawSignal}`
  if (signal !== null && !Object.hasOwn(constants.signals, signal)) return invalid()
  if (!record.timedOut && (record.exitCode === null) === (signal === null)) return invalid()
  if (record.timedOut && (record.exitCode !== null || signal !== null)) return invalid()
  return {
    exitCode: record.exitCode,
    signal: signal as NodeJS.Signals | null,
    timedOut: record.timedOut,
    stdout: record.stdout,
    stderr: record.stderr,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
  }
}

/** 将远端固定上限进一步收紧到调用方的字节预算，不承诺本地 spill 文件。 */
function directOutput(text: string, truncated: boolean, maxBytes: number): CollectedOutput {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated }
  const tail = bytes.subarray(bytes.length - Math.floor(maxBytes))
  return { text: tail.toString('utf8').replace(/^\uFFFD+/u, ''), truncated: true }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`bash-local: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved section this executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has to
 * fit, so a stored value is refused where it is written instead of failing at
 * the next command.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableBashConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`bash-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Local bash executor over `ctx.subprocess`. Bounded output, spill files, and
 * process-group SIGTERM→SIGKILL escalation are the subprocess service's
 * mechanics; this executor supplies their configured budgets per spawn, so a
 * still-running background process stays managed (killed and joined at
 * composition teardown) even across an executor reload.
 */
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.source()
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    assertServiceableBashConfig(entry)
    this.source = () => entry
    installSettingsSection(ctx, SHELL_SETTINGS_NAMESPACE, LocalBashExecutor.Config, entry, {
      validate: assertServiceableBashConfig,
      setSource: (current) => {
        this.source = current as () => ResolvedConfig
      },
      // Every field is read through the getter at each command, so nothing
      // derived from the source needs rebuilding when the document changes.
      onChange: () => {},
    })
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`. The tool layer calls
   * this before {@link run}/{@link start}, so those methods receive explicit
   * values and never re-default.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'bash-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    const workdir = request.workdir ?? this.config.cwd ?? process.cwd()
    const remoteTarget = remoteWorkspacePathSync(workdir, process.cwd())
    return {
      command: request.command,
      workdir,
      timeoutMs,
      stdoutMaxBytes,
      ...remoteTarget === undefined ? {} : { remoteTarget },
      ...request.signal ? { signal: request.signal } : {},
      // Carry stdin/ordinary env/trusted dshEnv through verbatim — optional,
      // no config default. The subprocess service owns the scrub and merge order.
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      // Carry a sandbox policy through verbatim: this executor never
      // confines, so the field is inert here (the seam contract) — a
      // sandboxing subclass overrides resolve() to stamp its default instead.
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** Map one resolved bash spec and explicit argv onto a fully-specified subprocess spawn. */
  // XXX(stateful-shell): evaluate persistent cwd or PTY sessions when workflows require shell state.
  private spawnSpec(
    spec: ShellExecSpec,
    argv: readonly string[],
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv,
      cwd: spec.remoteTarget?.remotePath ?? spec.workdir,
      ...spec.remoteTarget === undefined ? {} : { remoteTarget: spec.remoteTarget },
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      // One explicit env map for the seam, layered so the trusted dshEnv
      // snapshot beats both the caller's env and the terminal overrides; the
      // subprocess service merges the whole map after its ambient scrub.
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('bash-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    if (spec.remoteTarget?.mode === 'basic') return this.runBasicRemote(spec)
    return this.runArgv(spec, ['bash', '-c', spec.command])
  }

  /** basic 模式仅拥有一次性 SSH exec，超时/取消后无法证明远端进程树停稳。 */
  private async runBasicRemote(spec: ShellExecSpec): Promise<ShellRunResult> {
    const target = spec.remoteTarget
    if (target === undefined) {
      throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote SSH exec requires a remote target')
    }
    requireRemoteWorkspaceCapability(target, 'exec')
    // 先复核世代和模式；过期 marker 或 bridge 不可用绝不能退回本机执行。
    const current = await verifyRemoteWorkspaceTarget(target, spec.signal)
    // 服务端按 timeoutMs 结算；额外的传输宽限只用于避免 bridge 永久悬挂。
    using transport = deadline(spec.signal, Math.min(MAX_TIMER_DELAY_MS, spec.timeoutMs + 5_000), 'BASH_REMOTE_TRANSPORT_TIMEOUT')
    let response: ReturnType<typeof parseDirectExecResponse>
    try {
      response = await callRemoteWorkspaceBridge(current, '/v1/exec', 'POST', {
        path: current.remotePath,
        shell: 'bash',
        command: spec.command,
        timeoutMs: spec.timeoutMs,
        ...spec.stdin === undefined ? {} : { stdin: spec.stdin },
        env: { ...scrubbedParentEnv(), ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
      }, parseDirectExecResponse, transport.signal)
    } catch (error: unknown) {
      if (transport.signal.aborted) {
        throw new RemoteWorkspaceError('REMOTE_BRIDGE_ABORTED', 'remote SSH exec was cancelled or its transport timed out; remote process status is unknown')
      }
      throw error
    }
    if (response.timedOut) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_ABORTED', 'remote SSH exec timed out; remote process status is unknown')
    }
    return {
      exitCode: response.exitCode,
      signal: response.signal,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: directOutput(response.stdout, response.stdoutTruncated, spec.stdoutMaxBytes),
      stderr: directOutput(response.stderr, response.stderrTruncated, this.config.maxOutputBytes),
    }
  }

  /**
   * 使用受管 subprocess 的前台生命周期运行显式 argv；basic 模式不能进入此路径。
   * 子类在执行边界替换 argv 后也必须受此能力检查约束。
   * @param spec - 已解析的命令与执行设置。
   * @param argv - 交给 `ctx.subprocess` 的可执行文件与参数。
   * @returns 带收集输出和退出原因的前台结算结果。
   */
  protected async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    if (spec.remoteTarget?.mode === 'basic') {
      throw new RemoteWorkspaceError('REMOTE_CAPABILITY_UNAVAILABLE', 'remote SSH basic mode supports only foreground bash exec')
    }
    if (spec.remoteTarget !== undefined) requireRemoteWorkspaceCapability(spec.remoteTarget, 'process')
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = LocalBashExecutor.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr),
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.startArgv(spec, ['bash', '-c', spec.command])
  }

  /**
   * 以本执行器的后台生命周期、环境、输出、取消与进程树所有权语义启动显式
   * argv。子类在执行边界替换公共命令的 shell argv 后调用此方法。
   * @param spec - 已解析的执行设置和调用方拥有的命令元数据。
   * @param argv - 交给 `ctx.subprocess` 的精确可执行文件与参数。
   * @returns 实时后台句柄；provider rejection 以 failed 状态结算。
   */
  protected startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    if (spec.remoteTarget !== undefined) requireRemoteWorkspaceCapability(spec.remoteTarget, 'process')
    // 后台运行忽略 timeoutMs；调用方通过 kill() 或 spec.signal 停止它们。
    const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal))
    const collected = LocalBashExecutor.collected(running)

    // Provider rejection 没有可展示的直接结果，且不公开失败阶段；通过读取
    // 路径恰好交付一次中性提示。
    let providerFailureNote: string | undefined
    const consumeProviderFailure = (): string => {
      const note = providerFailureNote ?? ''
      providerFailureNote = undefined
      return note
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    let killRequested = false
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // 所有信号终止都归类为 killed，包括命令自行发出信号。
        proc.status = outcome.signal !== null ? 'killed' : 'completed'
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
      }, (error: unknown) => {
        // Basic SSH 的清理失败无法证明远端进程已退出；也不将桥接错误原文暴露给模型。
        proc.status = 'failed'
        providerFailureNote = spec.remoteTarget?.mode === 'basic'
          ? 'subprocess failed before reporting an outcome; remote process status is unknown'
          : `subprocess failed before reporting an outcome: ${String(error)}`
        this.onProcessDone(proc, providerFailureNote, true, error)
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        const providerFailure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text
          + (providerFailure.length > 0 ? `${failureSeparator}${providerFailure}` : '')
        // 两个区块之间只保留一个换行：stdout chunk 通常已有换行，仅在缺失时补充。
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running' || killRequested) return false
        killRequested = true
        running.terminate()
        return true
      },
    }
    return proc
  }

  /**
   * 供子类在进程上附加执行事实的结算钩子。退出事实或 provider-failure 输出
   * 已写入、且 {@link ShellProcess.done} resolve 前调用；基类刻意不处理。
   * @param _proc - 已结算的进程句柄。
   * @param _stderr - 子类用于结算分类的进程保留 stderr 尾部。
   * @param _providerRejected - subprocess promise 是否在没有直接结果时 reject。
   * @param _providerError - provider rejection 原因，可能是 undefined。
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _providerRejected: boolean, _providerError?: unknown): void {}
}

export default LocalBashExecutor
