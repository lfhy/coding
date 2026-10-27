/**
 * 所有沙箱工具家族（`coding-tool-bash`、`coding-tool-fs`）
 * 共用的升权词汇与流程：严格拓宽阶梯、参数配对校验、模型可见的拒绝／提示标记，
 * 以及 {@link approveEscalation}。后者会在执行前处理重复目标或经用户审批通道解析
 * `sandbox_permissions` 请求；单一归属可防止两个家族的审批顺序和错误文案漂移。
 *
 * 通道采用最小结构函数形状（{@link EscalationApprover}），而非审批服务类型：工具层
 * 拥有 agent、call id 与工具名，由它闭包 `ctx.approval.request(...)` 后传入，因此本包
 * 无需依赖 approval 或 agent 包。
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever } from 'coding-llm'
import type { SandboxMode } from './index.ts'

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * 封闭的升权目标词汇：调用可能升至的所有模式（`read-only` 是底档，不会成为目标）。
 * 只要已挂载能力实施限制就完整公开；若按组合默认值裁剪枚举，生效模式更窄的会话会
 * 失去升权入口。schema 是注册表全局数据，而生效模式按调用确定，因此执行期会把已
 * 生效的同档目标视为幂等请求，只对真正更宽的目标发起审批。
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * `sandbox_permissions` 上“沿用当前权限”的哨兵值。模型（尤其按 Codex 的 shell 词汇
 * 训练过的）会显式写出它来表示不请求升权；它与省略该字段完全等价：整对参数（连同理由）
 * 在执行前被忽略，既不降权也不触发审批。
 */
export const ESCALATION_DEFAULT_TARGET = 'use_default'

/**
 * schema 公开的完整取值词汇：{@link ESCALATION_TARGETS} 加上沿用当前权限的哨兵。参数
 * 校验按 schema 的 `enum` 执行，因此哨兵必须列在这里，否则模型照习惯写出的
 * `use_default` 会在执行前被判成无效参数而不是被忽略。
 */
export const ESCALATION_VALUES: readonly string[] = [...ESCALATION_TARGETS, ESCALATION_DEFAULT_TARGET]

/**
 * 把 `sandbox_permissions` 的原始取值归一成本次调用真正请求的目标模式。
 * @param value - 模型传入的原始值，可能缺省、可能是沿用当前权限的哨兵，或任意字符串。
 * @returns 待判断的升权目标；缺省与哨兵都返回 `undefined`（本次调用不请求升权）。
 */
export function escalationTarget(value: string | undefined): SandboxMode | undefined {
  return value === undefined || value === ESCALATION_DEFAULT_TARGET ? undefined : value as SandboxMode
}

/**
 * 校验工具 schema 无法表达的升权参数配对。本次已处于 `danger-full-access` 时，
 * `sandbox_permissions` 无法再拓宽任何权限，因此整个字段（连同理由）一律忽略；
 * {@link ESCALATION_DEFAULT_TARGET} 不请求升权，同样整对忽略；其他请求缺少理由或仅
 * 提供理由均在执行前失败。
 * @param sandboxPermissions - 原始 `sandbox_permissions` 参数。
 * @param justification - 原始 `justification` 参数。
 * @param effectiveMode - 本次调用已经生效的沙箱模式；未提供时严格校验配对。
 */
export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
  effectiveMode?: SandboxMode,
): void {
  // 已持有全部权限：此时没有更宽的目标，字段写什么都不会改变本次调用的能力，
  // 也无法降低它——因此拼写、理由是否成对都不再是待执行的请求，直接忽略。
  if (effectiveMode === 'danger-full-access') return
  // 沿用当前权限不是升权请求：理由可有可无，也不进入下面的配对校验。
  if (sandboxPermissions === ESCALATION_DEFAULT_TARGET) return
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/**
 * The model-facing denial marker — the one vocabulary both enforcing families
 * teach and report, so the model recognizes a policy denial identically
 * whether the kernel refused a bash file effect or the filesystem provider's
 * fence refused a mutation.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields — the nudge lives at the decision point so
 * the sanctioned retry does not depend on the model recalling the tool
 * description.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * The closed outcome vocabulary of one escalation ask — structurally identical
 * to the approval seam's `ApprovalOutcome` so an `ApprovalService.request`
 * return is assignable without this package importing it.
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The minimal approval-request shape {@link approveEscalation} needs —
 * structurally the approval seam's `ApprovalService`, generic over the agent
 * type `A` and call-id type `C` so this package resolves escalations through
 * `ctx.approval` without importing the approval or agent packages (the tool
 * layer infers `A`/`C` as its own `Agent`/`CallId`).
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * Ask the human to approve one action, resolving to a closed outcome.
   * @param req - the audit-self-contained request (agent, tool, call id, reason, optional signal).
   * @returns the human's decision as a closed {@link EscalationOutcome}.
   */
  request(req: { agent: A; toolName: string; callId: C; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome>
}

/**
 * The approval ingredients an escalating tool hands {@link approveEscalation}:
 * the approval requester (`ctx.approval`, or `undefined` when none is
 * composed), the calling agent (or `undefined` for an agent-less execution),
 * and the call's identity. The tool layer holds all of these; this package
 * only judges them.
 */
export interface EscalationApproval<A = object, C = string> {
  /** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
  approver: EscalationApprover<A, C> | undefined
  /** The calling agent, or `undefined` for an agent-less execution (fails closed). */
  agent: A | undefined
  /** The tool-call id the approval prompt attaches to. */
  callId: C
  /** The tool name recorded on the approval request. */
  toolName: string
  /** The tool-execution abort signal the approval request rides, when present. */
  signal?: AbortSignal
}

/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS} when advertised). */
  requestedMode: string
  /** The model's one-sentence reason, shown verbatim to the user inside the audit reason. */
  justification: string
  /** The call's effective mode (session override ?? composition default) the request must strictly widen. */
  effectiveMode: SandboxMode
  /** The family's noun for the escalated action in user-facing texts (`command` for bash, `operation` for fs). */
  subject: string
}

/**
 * 已具备 `danger-full-access` 的调用没有更宽的目标，其请求字段一律按无效请求忽略，
 * 也不会被它降低权限或触发审批；其他模式下，同档请求无需审批，只有严格拓宽才会
 * 请求审批。更窄或非法的请求、缺少审批服务、无 agent、拒绝、取消和无法应答都会
 * 以各自文案抛出，工具注册表会将其转成 `isError`，且操作尚未执行。
 * @param request - 待判断的升权请求，见 {@link EscalationRequest}。
 * @param approval - 工具持有的审批原料，见 {@link EscalationApproval}。
 * @returns 仅供本次调用使用的目标模式。
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (mode === effectiveMode && ESCALATION_TARGETS.includes(mode)) {
    return effectiveMode
  }
  // 全访问已经生效时没有任何更宽的目标：请求里的目标值（无论是否在封闭词汇内、
  // 是否与理由成对）都无法增加或降低本次调用的权限，因此按无效请求忽略，仍返回
  // 本次调用的生效模式；更窄的会话继续走下面的词汇与严格拓宽检查。
  if (effectiveMode === 'danger-full-access') {
    return effectiveMode
  }
  // 真正的拓宽仍以逐调用生效模式为准，不能只依据注册时的组合默认值。
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // Self-contained for the audit trail: approval/asked stores this reason,
  // and the target mode is part of the grant's identity.
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // The schema enum already pinned `mode` to the closed target vocabulary;
    // the check above proved it is strictly wider.
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw new Error(`the user rejected escalating this ${subject} to "${mode}"`)
    case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
