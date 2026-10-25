/**
 * Sandbox-consuming bash executor. It wraps the exact local bash argv through
 * `ctx.sandbox`, inherits local process mechanics, and reports the selected
 * mode, enforcement, and denial facts. Positive runner-launch evidence means
 * the command never ran: foreground calls throw `SANDBOX_UNAVAILABLE`, while
 * background processes carry `runnerFailed`; other spawn rejections retain
 * local-executor semantics. The tool owns approval and passes a complete per-call policy.
 * @module coding-bash-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from 'coding-shell'
import { SandboxUnavailableError } from 'coding-sandbox'
import { remoteWorkspacePath, remoteWorkspacePathSync } from 'coding-subprocess'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from 'coding-sandbox'
import type {} from 'coding-sandbox-policy'
import { LocalBashExecutor } from 'coding-bash-local'
import type { Config as LocalConfig } from 'coding-bash-local'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`coding-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig

/**
 * Registers as `ctx.shell` in place of the local executor and requires a
 * `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
 * unchanged. Tool calls pass the calling session's resolved policy; direct
 * calls fall back to deployment policy. `result.sandbox` reports the mode and
 * enforcement actually used.
 */
/**
 * 伪终端把 stderr 合流进 stdout，而沙箱分类器只读 stderr；交互式运行的分类证据因此
 * 取自合流输出。返回值只用于分类，不替换面向调用方的结果。
 * @param result - 伪终端运行结果。
 * @returns 证据视图。
 */
function terminalEvidence(result: ShellRunResult): ShellRunResult {
  return result.stderr.text.length > 0
    ? result
    : { ...result, stderr: { text: result.stdout.text, truncated: result.stdout.truncated } }
}

export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // No own Config: the sandbox default (mode + workspaceRoot) is owned by
  // ctx.sandboxPolicy, so this executor inherits LocalBashExecutor's Config
  // verbatim (the config catalog walks the inherited static).

  private readonly mode: SandboxMode
  /**
   * Per-process confinement facts retained until settlement. Providers may
   * vary enforcement and diagnostic dialect between overlapping calls, so a
   * shared latest-wrap value would classify a process against the wrong facts.
   * Unconfined processes have no entry.
   */
  private readonly processFacts = new Map<ShellProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The default mode is the capability fact used for schema advertisement;
    // actual tool executions carry their resolved per-call policy.
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp a complete per-call policy onto the spec. Tool calls supply the
   * calling session's resolved mode and root; lower-level callers fall back to
   * the deployment policy.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    spec.signal?.throwIfAborted()
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await super.run(spec)
      return { ...result, sandbox: { mode, denied: false } }
    }
    if (await remoteWorkspacePath(spec.workdir, process.cwd(), spec.signal) !== undefined) {
      throw new Error('remote SSH bash requires danger-full-access: the local file sandbox cannot enforce this mode on a remote shell')
    }
    const confined = this.confine(spec.command, { ...policy, mode })
    let result: ShellRunResult
    try {
      result = spec.tty
        ? await this.runTerminal(spec, confined.argv)
        : await this.runArgv(spec, confined.argv)
    } catch (error) {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    // 伪终端合流后 stderr 为空，分类证据改看 stdout，返回结果仍保留原始分流。
    const evidence = spec.tty ? terminalEvidence(result) : result
    // Runner failure outranks denial because the command did not run. Carry
    // the matched fatal line, not an informational line that preceded it.
    const runnerFailure = classifyRunnerFailure(evidence.exitCode, evidence.stderr.text, confined.runnerFailureRules)
    if (runnerFailure !== undefined) {
      throw new SandboxUnavailableError(mode, runnerFailure.detail)
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(evidence, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') return super.start(spec)
    if (remoteWorkspacePathSync(spec.workdir, process.cwd()) !== undefined) {
      throw new Error('remote SSH bash requires danger-full-access: the local file sandbox cannot enforce this mode on a remote shell')
    }
    // Once startArgv returns, install facts synchronously; promise settlement
    // cannot run before start() returns.
    const confined = this.confine(spec.command, { ...policy, mode })
    let proc: ShellProcess
    try {
      proc = spec.tty ? this.startTerminal(spec, confined.argv) : this.startArgv(spec, confined.argv)
    } catch (error) {
      // LocalSubprocessRuntime reports ENOENT/EACCES with the failed executable path through async
      // `done` rejection; this covers alternatives that throw the same error synchronously.
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    const { enforcement, denialSignatures, runnerFailureRules } = confined
    this.processFacts.set(proc, {
      mode,
      enforcement,
      denialSignatures,
      runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    })
    return proc
  }

  /** 在 `done` 结算前写入进程级 sandbox 事实；完全访问的进程没有事实，信号死亡也不是拒绝。 */
  protected override onProcessDone(proc: ShellProcess, stderr: string, providerRejected: boolean, providerError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // Provider rejection 不公开失败阶段；仅当错误自行指向 argv[0] 时归因
      // 给 confinement runner，否则已结算 runner failure 优先于拒绝诊断。
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }

  /**
   * Wrap one shell command via the `ctx.sandbox` provider. Provider errors
   * propagate unchanged; the returned argv is handed directly to the local
   * executor's subprocess path.
   * @param command - shell source for the confined inner `bash -c`.
   * @param policy - resolved confined execution policy.
   * @returns the provider's exact argv and settlement-classification facts.
   */
  private confine(command: string, policy: SandboxPolicy): ConfinedArgv {
    return this.ctx.sandbox.confine(['bash', '-c', command], policy)
  }
}

export default SandboxBashExecutor
