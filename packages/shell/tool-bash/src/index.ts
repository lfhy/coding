/**
 * Model-facing Consumer of the `ctx.shell` capability seam. Background calls
 * register process handles with `ctx.jobs`; their work uses job cancellation
 * rather than the tool-call signal after an id is returned.
 *
 * TODO(permissions): deployment policy belongs in `tools/pre-execute` and
 * sandboxing executors; see docs/architecture.md § Where new behavior goes.
 * @module coding-tool-bash
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { defineTool, TOOL_ABORTED } from 'coding-tools'
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from 'coding-tools'
import { HarnessError } from 'coding-llm'
import type { Agent } from 'coding-agent'
import type {} from 'coding-system-prompt'
import type {} from 'coding-jobs'
import type {} from 'coding-user-approval'
import type {} from 'coding-shell-env'
import type { SandboxExecutionPolicy, SandboxMode } from 'coding-sandbox'
import { ESCALATION_TARGETS, ESCALATION_VALUES, approveEscalation, canonicalPath, escalationTarget, validateEscalationArgs } from 'coding-sandbox'
import type { SandboxPolicyService } from 'coding-sandbox-policy'
import { DSH_ENV_PREFIX } from 'coding-shell'
import type { ShellRunResult } from 'coding-shell'
import {
  isRemoteAbsolutePath,
  remoteWorkspaceLocalPath,
  remoteWorkspacePathSync,
  RemoteWorkspaceError,
} from 'coding-subprocess'
import { processOutcome } from './background.ts'
import { parseExitStatus, renderProcessRead, renderResult } from './render.ts'

export const name = 'tool-bash'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/**
 * 后台会话由哪组工具收尾。`jobs` 是默认的 `job_output`/`job_kill` 组合；
 * `write_stdin` 表示同一个部署装的是 Codex 风格的单会话控制器，因此背景提示必须
 * 指向它才不会让模型去找不存在的 job 工具。
 */
export type BackgroundSessionTools = 'jobs' | 'write_stdin'

/** Configuration for the bash tool. */
export interface Config {
  /** Model-facing tool name (default `bash`). */
  toolName?: string
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
  /** Tools that read and stop a background session (default `jobs`, i.e. `job_output`/`job_kill`). */
  backgroundSessionTools?: BackgroundSessionTools
}

/** Runtime configuration schema for the bash tool plugin. */
export const Config: z<Config> = z.object({
  toolName: z.string().default('bash'),
  enableRunInBackground: z.boolean().default(true),
  backgroundSessionTools: z.union(['jobs', 'write_stdin'] as const).default('jobs'),
})

/** Parsed tool args; execute validates value constraints absent from ParameterSchemaSpec. */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  tty?: boolean
  sandbox_permissions?: string
  justification?: string
}

function validateBashArgs(args: BashToolArgs, effectiveMode?: SandboxMode): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification, effectiveMode)
}

function bashDescription(
  backgroundEnabled: boolean,
  backgroundTools: BackgroundSessionTools,
  escalationModes: readonly SandboxMode[],
): string {
  const background = !backgroundEnabled
    ? 'Background execution is not available; long-running commands must finish within the timeout.'
    : backgroundTools === 'write_stdin'
      ? 'Set `run_in_background: true` for long-running commands: the call returns a session id immediately; read its output, wait on it, or interrupt it with `write_stdin`.'
      : 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
  const base = 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
    + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
    + `Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
    + 'just hit; escalating up front is fine only when this session already denied the same access. '
    + 'A rejected escalation is final for that command — stop and explain, never work around '
    + 'it — but it does not forbid attempting or escalating other commands later.'
}

/**
 * Present foreground calls as terminals and background starts as generic cards.
 * The command remains the title on both paths; foreground cwd is passed through
 * for the bridge to resolve, while background descriptions remain card content.
 */
type BashCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentBashCall(args: BashCallArgs, _toolName: string): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
 */
function presentBashResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  // Background acknowledgements and errors have no terminal exit status.
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  // The exit marker becomes the card's exit pill, so it leaves the output body.
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/**
 * 先解析显式 workdir；相对路径以会话工作区为基准。沙箱策略已解析出的根目录优先，
 * 让工作目录与限制使用同一身份。Remote-SSH 会话的相对路径必须仍位于同一 marker，
 * 不能借由本地路径逃出后回退到本机执行器。
 */
function resolveWorkdir(
  modelWorkdir: string | undefined,
  exec: { agent?: Agent },
  policyWorkspaceRoot?: string,
): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd))
  if (modelWorkdir === undefined) return sessionCwd
  const remote = sessionCwd === undefined ? undefined : remoteWorkspacePathSync('.', sessionCwd)
  if (remote !== undefined && sessionCwd !== undefined) {
    if (isRemoteAbsolutePath(modelWorkdir)) return remoteWorkspaceLocalPath(remote, modelWorkdir)
    if (!isAbsolute(modelWorkdir)) {
      const localWorkdir = resolvePath(sessionCwd, modelWorkdir)
      const resolvedRemote = remoteWorkspacePathSync(localWorkdir)
      if (resolvedRemote?.markerRoot !== remote.markerRoot) {
        throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
      }
      return localWorkdir
    }
  }
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalBashResult(result: ShellRunResult) {
  const output = (stream: ShellRunResult['stdout']) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}

/** Canonical background-handle properties shared by the bash output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const toolName = config.toolName ?? 'bash'
  if (toolName.trim().length === 0) throw new Error('tool-bash: toolName must be non-empty')
  const backgroundEnabled = config.enableRunInBackground ?? true
  const backgroundSessionTools: BackgroundSessionTools = config.backgroundSessionTools ?? 'jobs'
  // 交互式会话只有能分配伪终端的执行器才存在；不支持时不公开 `tty`，调用也会被拒。
  const ttySupported = ctx.shell.tty
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing')
  }
  /** 在挂载受限执行器时解析本次调用的完整常驻策略。 */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * 在任何执行前解析沙箱升权请求，把同档幂等处理、严格拓宽检查、通道解析与结果映射
   * 委托给 {@link approveEscalation}。本工具只提供组合守卫和审批原料：无沙箱执行器时
   * 不公开字段，但 schema 只校验已公开键，因此注入的 `sandbox_permissions` 仍可能
   * 到达执行阶段。只要执行器声明限制能力就必须存在共享策略解析器，使割裂组合在
   * 工具插件加载时直接失败。
   */
  const approveBashEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: toolName,
        signal: exec.signal,
      },
    )
  }

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  ctx.tools.register(defineTool({
    name: toolName,
    description: bashDescription(backgroundEnabled, backgroundSessionTools, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      ...ttySupported ? {
        tty: {
          type: 'boolean' as const,
          description: 'Run the command in a pseudo-terminal so it can read from an interactive stdin. '
            + (backgroundSessionTools === 'write_stdin'
              ? 'Background tty sessions accept live input through write_stdin and receive Ctrl-C as terminal input.'
              : 'A background tty session can only be collected with the job tools; typing into it requires a stdin-capable session controller.'),
        },
      } : {},
      ...backgroundEnabled ? {
        run_in_background: {
          type: 'boolean' as const,
          description: backgroundSessionTools === 'write_stdin'
            ? 'Run in the background and return a session id immediately (read, wait on, or interrupt it with write_stdin). No timeout applies.'
            : 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
        },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...ESCALATION_VALUES],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval. `use_default` asks for no change and equals omitting the field.',
        },
        justification: {
          type: 'string' as const,
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: BACKGROUND_OUTPUT_PROPERTIES,
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderResult(value as { kind: 'foreground' } & ShellRunResult, escalationModes),
      }],
    },
    async execute(args: BashToolArgs, exec) {
      const standingPolicy = resolveSandboxPolicy(exec)
      validateBashArgs(args, standingPolicy?.mode)
      // description 仅供展示；未指定 workdir 时使用调用会话的工作区。`use_default` 与缺省
      // 都归一成“不请求升权”，本次调用沿用常驻策略。
      const requestedMode = escalationTarget(args.sandbox_permissions)
      const approvedMode = requestedMode === undefined
        ? undefined
        : await approveBashEscalation(requestedMode, args.justification ?? '', exec, standingPolicy)
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
      const dshEnv = ctx.shellEnv.collect(exec)
      if (args.tty === true && !ttySupported) {
        throw new Error('tty is not available in this composition (the mounted shell executor cannot allocate a pseudo-terminal)')
      }
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        dshEnv,
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
        ...args.tty === true ? { tty: true } : {},
      }
      if (args.run_in_background === true) {
        // 未公开的键仍可能到达执行期，因此禁用后台任务也必须在此拒绝。
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load coding-jobs and coding-tool-jobs')
        }
        // 后台任务发布前由当前调用持有取消权。
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Task preflight finishes before the starter can spawn a process.
        const id = jobs.start({
          kind: 'bash',
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => {
            const proc = ctx.shell.start(ctx.shell.resolve(request))
            return {
              cancel: () => void proc.kill(),
              done: proc.done.then(() => processOutcome(proc)),
              readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
              // 只有伪终端会话有 stdin 通道；管道会话省略该钩子，写入会被明确拒绝。
              ...proc.write === undefined ? {} : { write: (data: string) => proc.write?.(data) ?? false },
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const result = await ctx.shell.run(ctx.shell.resolve({
        ...request,
        signal: exec.signal,
      }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonicalBashResult(result) }
    },
    presentCall: args => presentBashCall(args, toolName),
    presentResult: presentBashResult,
  }))
}
