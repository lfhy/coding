/**
 * 共享升权词汇与流程测试：严格拓宽阶梯、同档幂等处理、参数配对校验、模型可见标记，
 * 以及 {@link approveEscalation} 的有序 fail-closed 序列。两个执行工具家族
 * （`dsh-tool-bash`、`dsh-tool-fs`）都委托到这里，因此顺序与逐字文案只在词汇归属处
 * 固定一次。
 */

import { describe, expect, it } from 'vitest'
import {
  ESCALATION_DEFAULT_TARGET,
  ESCALATION_TARGETS,
  ESCALATION_VALUES,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  escalationTarget,
  sandboxDenialMarker,
  validateEscalationArgs,
} from 'coding-sandbox'
import type { EscalationApprover, EscalationOutcome } from 'coding-sandbox'

describe('the strictly-wider ladder', () => {
  it('read-only escalates to either wider mode; workspace-write only to full access', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access'])
    expect(WIDER_MODES['danger-full-access']).toBeUndefined()
  })

  it('the target enum is the closed set every session could escalate TO (read-only is the floor)', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
  })

  it('the advertised vocabulary adds the no-op sentinel after the targets', () => {
    // schema 枚举带哨兵：参数校验按 schema 执行，模型照习惯写出的 use_default 必须通过
    // 校验，再由执行期归一成“不请求升权”。
    expect(ESCALATION_VALUES).toEqual(['workspace-write', 'danger-full-access', 'use_default'])
    expect(ESCALATION_DEFAULT_TARGET).toBe('use_default')
  })
})

describe('escalationTarget', () => {
  it('normalizes the omitted field and the sentinel to no escalation request', () => {
    expect(escalationTarget(undefined)).toBeUndefined()
    expect(escalationTarget(ESCALATION_DEFAULT_TARGET)).toBeUndefined()
  })

  it('passes a real target through for the ladder to judge', () => {
    expect(escalationTarget('workspace-write')).toBe('workspace-write')
    expect(escalationTarget('danger-full-access')).toBe('danger-full-access')
    // 词汇外的值原样传递：拒绝由严格拓宽检查在执行前给出，而不是在这里静默丢弃。
    expect(escalationTarget('yolo')).toBe('yolo')
  })
})

describe('validateEscalationArgs', () => {
  it('accepts neither field, or both with a non-empty justification', () => {
    expect(() => { validateEscalationArgs(undefined, undefined) }).not.toThrow()
    expect(() => { validateEscalationArgs('workspace-write', 'because the workspace needs it') }).not.toThrow()
  })

  it('rejects one field without the other, and a blank justification', () => {
    expect(() => { validateEscalationArgs('workspace-write', undefined) }).toThrow(/requires a justification/)
    expect(() => { validateEscalationArgs(undefined, 'orphan reason') }).toThrow(/only valid together with sandbox_permissions/)
    expect(() => { validateEscalationArgs('workspace-write', '   ') }).toThrow(/non-empty sentence/)
  })

  it('treats advertised targets as redundant at full access without weakening restricted sessions', () => {
    for (const target of ESCALATION_TARGETS) {
      for (const justification of ['', ' ', undefined]) {
        expect(() => { validateEscalationArgs(target, justification, 'danger-full-access') }).not.toThrow()
        if (target === 'danger-full-access') {
          expect(() => { validateEscalationArgs(target, justification, 'read-only') }).toThrow()
          expect(() => { validateEscalationArgs(target, justification, 'workspace-write') }).toThrow()
        }
      }
    }
    expect(() => { validateEscalationArgs('workspace-write', '', 'workspace-write') }).toThrow(/non-empty sentence/)
  })

  it('ignores the whole pair when the target asks for the current mode', () => {
    // 沿用当前权限不是升权请求：理由可有可无、内容不限，都不进入配对校验，也不降权。
    for (const justification of [undefined, '', ' ', 'redundant']) {
      expect(() => { validateEscalationArgs(ESCALATION_DEFAULT_TARGET, justification, 'read-only') }).not.toThrow()
      expect(() => { validateEscalationArgs(ESCALATION_DEFAULT_TARGET, justification, 'workspace-write') }).not.toThrow()
    }
  })

  it('ignores the escalation field entirely once the call already holds full access', () => {
    // 已持有全部权限时没有更宽的目标，字段（连同理由）不再是待执行的请求：任何拼写
    // 都被忽略，且不改变本次调用的权限。
    for (const value of ['require', 'full-access', 'yolo', 'workspace-write', 'danger-full-access', undefined]) {
      for (const justification of ['', ' ', undefined, 'widen it']) {
        expect(() => { validateEscalationArgs(value, justification, 'danger-full-access') }).not.toThrow()
      }
    }
    // 放宽恰好只覆盖这一档：更窄的会话继续完整校验配对与拼写。`require` 不被识别，
    // 因此在更窄会话里它是与理由成对的未知值，配对校验通过、真正的拒绝留给升权阶梯。
    for (const value of ['full-access', 'yolo']) {
      expect(() => { validateEscalationArgs(value, 'widen it', 'read-only') }).not.toThrow()
      expect(() => { validateEscalationArgs(value, undefined, 'read-only') }).toThrow(/requires a justification/)
    }
    expect(() => { validateEscalationArgs('require', 'widen it', 'read-only') }).not.toThrow()
    expect(() => { validateEscalationArgs('require', undefined, 'read-only') }).toThrow(/requires a justification/)
    expect(() => { validateEscalationArgs('unknown-mode', undefined, 'danger-full-access') }).not.toThrow()
    expect(() => { validateEscalationArgs(undefined, ' ', 'danger-full-access') }).not.toThrow()
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('the hint marker names the family subject', () => {
    expect(escalationHintMarker('command')).toContain('retry this exact command once with sandbox_permissions')
    expect(escalationHintMarker('operation')).toContain('retry this exact operation once with sandbox_permissions')
  })
})

describe('approveEscalation', () => {
  const req = (over: Partial<Parameters<typeof approveEscalation>[0]> = {}) => ({
    requestedMode: 'workspace-write',
    justification: 'the user asked to write in the workspace',
    effectiveMode: 'read-only' as const,
    subject: 'command',
    ...over,
  })
  /** An approver that records the request and returns a fixed outcome. */
  const approver = (outcome: EscalationOutcome, sink?: (req: unknown) => void): EscalationApprover => ({
    request: async (request) => { sink?.(request); return outcome },
  })
  const ingredients = (over: Partial<Parameters<typeof approveEscalation>[1]> = {}) => ({
    approver: approver('allowed-once'),
    agent: {},
    callId: 'call-1',
    toolName: 'bash',
    ...over,
  })

  it('grants: returns the requested mode, asking through the approver with the audit reason', async () => {
    const seen: { reason?: string }[] = []
    const granted = await approveEscalation(req(), ingredients({ approver: approver('allowed-once', r => seen.push(r as { reason?: string })) }))
    expect(granted).toBe('workspace-write')
    expect(seen[0]?.reason).toBe('escalate sandbox to workspace-write: the user asked to write in the workspace')
  })

  it('an already-active advertised target is idempotent and never asks', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)), agent: undefined })
    await expect(approveEscalation(req({ effectiveMode: 'workspace-write' }), spy))
      .resolves.toBe('workspace-write')
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' }), {
      ...spy,
      approver: undefined,
    })).resolves.toBe('danger-full-access')
    await expect(approveEscalation(req({ requestedMode: 'danger-full-access', effectiveMode: 'danger-full-access' }), {
      ...spy,
      approver: undefined,
    })).resolves.toBe('danger-full-access')
    expect(seen).toEqual([])
  })

  it('a narrowing or invalid target fails closed with its own text and never asks', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    await expect(approveEscalation(req({ requestedMode: 'read-only' }), spy))
      .rejects.toThrow(/not strictly wider than this call's current "read-only" mode/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toThrow(/not strictly wider/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode', effectiveMode: 'read-only' }), spy))
      .rejects.toThrow(/not strictly wider/)
    expect(seen).toEqual([])
  })

  it('ignores the requested target entirely once the call already holds full access', async () => {
    // 没有更宽的目标可请求：字段写什么都无法增加或降低本次调用的权限，因此一律
    // 按无效请求忽略，且不询问任何人。
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    for (const requestedMode of ['workspace-write', 'read-only', 'unknown-mode']) {
      await expect(approveEscalation(req({ requestedMode, effectiveMode: 'danger-full-access' }), spy))
        .resolves.toBe('danger-full-access')
    }
    expect(seen).toEqual([])
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toThrow(/no approval service is composed/)
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toThrow(/no agent to route it through/)
  })

  it('maps each non-grant outcome to its distinct verbatim text (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toThrow('the user rejected escalating this operation to "workspace-write"')
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toThrow('approval for escalating to "workspace-write" was cancelled')
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toThrow('no approval channel is available')
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
