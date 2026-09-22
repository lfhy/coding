/**
 * Local PowerShell Service Provider for the bash capability seam. Each command runs
 * as `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` in a managed
 * process spawned through `ctx.subprocess`; the executor owns command
 * defaulting, deadlines and cause classification, the model-friendly terminal
 * environment, and the model-facing stdout/stderr merge for background reads.
 * The command string is passed as ONE argv element to `-Command`: PowerShell
 * itself parses the text, and no intermediate shell exists, so there is no
 * shell-quoting layer to escape (the `bash -c` string domain has no
 * equivalent here). Native Win32 paths (`C:\...`) pass through unchanged.
 * @module @deepseek-ai/dsh-pwsh-local
 */

/* jscpd:ignore-start -- this executor mirrors dsh-bash-local call-for-call by
   design (see this package's README), so the two import the same seam surface */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellProcessRead, ShellRunResult, CollectedOutput } from '@deepseek-ai/dsh-shell'
import { remoteWorkspacePathSync } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
/* jscpd:ignore-end */
import { resolvePwshPath } from './resolve.ts'

/* jscpd:ignore-start -- deliberate call-for-call mirror of dsh-bash-local (design record: pwsh-tool-and-executor). */
/**
 * Model-friendly environment overrides for PowerShell: disable colors and
 * pagers that would garble tool output. `TERM=dumb` is a POSIX concept and is
 * deliberately absent; `NO_COLOR` is honored by modern pwsh renderers.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * UTF-8 output pinning prepended to every command. The subprocess collector
 * decodes output bytes as UTF-8, but Windows PowerShell 5.1 (the last-resort
 * executable fallback) writes the console/OEM code page by default, which
 * garbles non-ASCII output; pwsh 7 defaults to UTF-8 and is unaffected. The
 * statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config). */
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
  /**
   * Explicit pwsh executable. When omitted, well-known Windows install
   * locations and PATH entries are probed in order (PowerShell 7 install,
   * PATH entries such as the Microsoft Store install, then Windows
   * PowerShell 5.1), falling back to a bare `pwsh` resolved through PATH.
   */
  pwshPath?: string
}

/** The shape after schemastery applied the defaults (cwd/pwshPath have none). */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'pwshPath'>> & Pick<Config, 'cwd' | 'pwshPath'>

// Resolution lives in its own dependency-free module so the repository's
// coverage-gate probe shares the exact definition the suites use.
export { candidatePwshPaths, resolvePwshPath } from './resolve.ts'

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`pwsh-local: ${name} must be a positive finite number`)
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
export function assertServiceablePwshConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`pwsh-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Local PowerShell executor over `ctx.subprocess`. Bounded output, spill
 * files, and process-tree termination are the subprocess service's mechanics;
 * this executor supplies their configured budgets per spawn.
 */
export class PwshLocalExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
    pwshPath: z.string(),
  })

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig

  /** The declared executable the current {@link pwshPath} was resolved from. */
  private declaredPwshPath: string | undefined

  /** The pwsh executable resolved from the current config. */
  private resolvedPwshPath: string

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.source()
  }

  /** The pwsh executable every command runs through. */
  get pwshPath(): string {
    return this.resolvedPwshPath
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    assertServiceablePwshConfig(entry)
    this.source = () => entry
    this.declaredPwshPath = entry.pwshPath
    this.resolvedPwshPath = resolvePwshPath(entry.pwshPath)
    installSettingsSection(ctx, SHELL_SETTINGS_NAMESPACE, PwshLocalExecutor.Config, entry, {
      validate: assertServiceablePwshConfig,
      setSource: (current) => {
        this.source = current as () => ResolvedConfig
      },
      // Probing the filesystem is the one fact derived from the source: every
      // other field is read through the getter at each command.
      onChange: () => {
        const declared = this.source().pwshPath
        if (declared === this.declaredPwshPath) return
        this.declaredPwshPath = declared
        this.resolvedPwshPath = resolvePwshPath(declared)
      },
    })
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'pwsh-local: request.timeoutMs',
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
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * The pwsh invocation argv for one resolved spec — the argv-level seam a
   * confining subclass wraps through `ctx.sandbox.confine` (the pwsh twin of
   * `dsh-bash-local`'s `runArgv`/`startArgv` hooks; see
   * `@deepseek-ai/dsh-pwsh-sandbox`).
   */
  protected argv(spec: ShellExecSpec): string[] {
    // 远端不能使用本机解析出的绝对 pwsh 路径。显式配置仍是调用者的
    // 意图；省略时由 Go agent 在其受控 PATH 中解析裸命令。
    const executable = spec.remoteTarget === undefined
      ? this.pwshPath
      : this.config.pwshPath ?? 'pwsh'
    return [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }

  /** Map one resolved spec plus its argv onto a fully-specified subprocess spawn. */
  private spawnSpec(
    spec: ShellExecSpec,
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
    argv: readonly string[],
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: [...argv],
      cwd: spec.remoteTarget?.remotePath ?? spec.workdir,
      ...spec.remoteTarget === undefined ? {} : { remoteTarget: spec.remoteTarget },
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('pwsh-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.runArgv(spec, this.argv(spec))
  }

  /** Foreground run of an exact argv (the confining subclass re-wraps it). */
  protected async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, d.signal, argv))
    const outcome = await handle.done
    const collected = PwshLocalExecutor.collected(handle)
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
    return this.startArgv(spec, this.argv(spec))
  }

  /** 启动精确 argv 的后台任务（隔离子类会再次包装它）。 */
  protected startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    // 后台运行忽略 timeoutMs；调用方通过 kill() 或 spec.signal 停止它们。
    const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal, argv))
    const collected = PwshLocalExecutor.collected(running)

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
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // 所有信号终止都归类为 killed，包括命令自行发出信号。
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
      }, (error: unknown) => {
        // 后台 provider failure 以 killed 结算，并通过读取路径暴露。
        proc.status = 'killed'
        providerFailureNote = `subprocess failed before reporting an outcome: ${String(error)}`
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
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }

  /**
   * 供子类在进程上附加执行事实的结算钩子。基类刻意不处理；与
   * `dsh-bash-local` 的对应钩子保持镜像，使用者是
   * `@deepseek-ai/dsh-pwsh-sandbox`。
   * @param _proc - 已结算的进程句柄。
   * @param _stderr - 子类用于结算分类的进程保留 stderr 尾部。
   * @param _providerRejected - subprocess promise 是否在没有直接结果时 reject。
   * @param _providerError - provider rejection 原因，可能是 undefined。
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _providerRejected: boolean, _providerError?: unknown): void {}
}
/* jscpd:ignore-end */

export default PwshLocalExecutor
