import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderProgressReminder } from 'coding-progress-reminder'
import * as ProgressInvariant from 'coding-progress-reminder/invariant'
import InvariantRegistry from 'coding-invariants'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from 'coding-llm'
import SessionStore, { Session, SessionId } from 'coding-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ProgressInvariant)
  return ctx
}

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendToolResults(session: Session, count: number, turn: number, step = 1): void {
  for (let index = 0; index < count; index += 1) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: CallId(`call-${String(turn)}-${String(step)}-${String(index)}`),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
}

function appendReminder(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'progress-reminder' },
  }), { surfaceOp: 'append' })
}

/** 触发一次 session/event 分发，让配套入口校验刚追加的提醒。 */
function emitLastEvent(ctx: Context, session: Session): void {
  const event = session.events.at(-1)
  if (event === undefined) throw new Error('missing event')
  ctx.emit('session/event', session, event)
}

describe('progress-reminder invariants', () => {
  it('accepts a reminder whose declared count matches the completed tool calls', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('accepted'))
    openTurn(session, 1)
    appendToolResults(session, 3, 1)
    appendReminder(session, renderProgressReminder(3))

    expect(() => { emitLastEvent(ctx, session) }).not.toThrow()
  })

  it('rejects a declared count that disagrees with the completed tool calls', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('mismatch'))
    openTurn(session, 1)
    appendToolResults(session, 2, 1)
    appendReminder(session, renderProgressReminder(4))

    expect(() => { emitLastEvent(ctx, session) }).toThrow(/声明 4 次调用，日志中该边界之后为 2 次/)
  })

  it.each([1, 3])('validates only calls after visible assistant text, not the preceding calls (%i)', async (declared) => {
    const ctx = await setup()
    const session = Session.create(SessionId(`after-report-${String(declared)}`))
    openTurn(session, 1)
    appendToolResults(session, 2, 1)
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '已经定位问题，继续修复。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    appendToolResults(session, 1, 1, 2)
    appendReminder(session, renderProgressReminder(declared))

    if (declared === 1) {
      expect(() => { emitLastEvent(ctx, session) }).not.toThrow()
    } else {
      expect(() => { emitLastEvent(ctx, session) }).toThrow(/声明 3 次调用，日志中该边界之后为 1 次/)
    }
  })

  it('rejects a reminder whose text was altered', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('altered'))
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    appendReminder(session, `${renderProgressReminder(1)}\n额外一句`)

    expect(() => { emitLastEvent(ctx, session) }).toThrow(/文本必须逐字等于渲染结果/)
  })

  it('rejects a reminder that does not carry the package frame', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('unframed'))
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    appendReminder(session, '你已连续执行 1 次工具调用，其间没有向用户汇报过进展。')

    expect(() => { emitLastEvent(ctx, session) }).toThrow(/文本不符合固定格式/)
  })

  it('rejects a reminder whose declared count ignores the current turn', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('turn-boundary'))
    openTurn(session, 1)
    appendToolResults(session, 5, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(session, 2)
    appendToolResults(session, 1, 2)
    appendReminder(session, renderProgressReminder(6))

    expect(() => { emitLastEvent(ctx, session) }).toThrow(/声明 6 次调用，日志中该边界之后为 1 次/)
  })
})
