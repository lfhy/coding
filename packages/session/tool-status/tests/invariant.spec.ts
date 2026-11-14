/** 不变式独立装配，覆盖已有日志、恢复发布与实时追加三个边界。 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from 'coding-invariants'
import SessionStore, { SessionId, type Session, type SessionEvent } from 'coding-session'
import * as StatusInvariant from '../src/invariant.ts'

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function statusEvent(data: unknown): SessionEvent {
  return { type: 'status/set', seq: 0, time: 0, data } as SessionEvent
}

async function setup(companion = true): Promise<Context> {
  context = new Context()
  await context.plugin(SessionStore)
  await context.plugin(InvariantRegistry, { enabled: true })
  if (companion) await context.plugin(StatusInvariant)
  return context
}

const INVALID_FACTS: { label: string; data: unknown }[] = [
  { label: 'null', data: null }, { label: '数组', data: [] }, { label: '空对象', data: {} },
  { label: '缺少轮次', data: { text: '处理中' } }, { label: '缺少 text', data: { turn: 1 } },
  { label: '负轮次', data: { turn: -1, text: null } }, { label: '非整数轮次', data: { turn: 1.5, text: null } },
  { label: '字符串轮次', data: { turn: '1', text: null } }, { label: '未知字段', data: { turn: 1, text: null, extra: true } },
  { label: '非字符串', data: { turn: 1, text: 1 } }, { label: '空文本', data: { turn: 1, text: '' } },
  { label: '未修剪', data: { turn: 1, text: ' padded ' } }, { label: '换行', data: { turn: 1, text: 'a\nb' } },
  { label: '控制符', data: { turn: 1, text: 'a\u0000b' } }, { label: '格式符', data: { turn: 1, text: 'a\u200bb' } },
  { label: 'Unicode 分隔', data: { turn: 1, text: 'a\u2028b' } },
  { label: 'Unicode 超长', data: { turn: 1, text: '😀'.repeat(121) } },
]

describe('进度事实不变式', () => {
  it('合法历史与实时状态、null 和 Unicode 精确边界均通过', async () => {
    const ctx = await setup(false)
    const session = ctx.sessions.create(SessionId('valid-history'))
    session.append('turn/start', { turn: 0 })
    session.append('status/set', { turn: 0, text: '😀'.repeat(120) })
    session.append('status/set', { turn: 0, text: null })
    await expect(ctx.plugin(StatusInvariant).then(() => undefined)).resolves.toBeUndefined()
    expect(() => session.append('status/set', { turn: 0, text: '继续验证' })).not.toThrow()
    expect(() => { ctx.emit('session/event', session, statusEvent({ turn: 20, text: null })) }).not.toThrow()
  })

  it.each(INVALID_FACTS)('实时分发拒绝$label，并归因到本包', async ({ data }) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    let caught: unknown
    try {
      ctx.emit('session/event', session, statusEvent(data))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvariantError)
    expect(caught).toMatchObject({ code: 'INVARIANT', packageName: 'coding-tool-status' })
    expect((caught as Error).message).toContain('status/set')
  })

  it.each(INVALID_FACTS)('晚挂载拒绝已有日志中的$label', async ({ data }) => {
    const ctx = await setup(false)
    ctx.sessions.create(SessionId('invalid-existing'), { seed: [statusEvent(data)] })
    await expect(ctx.plugin(StatusInvariant).then(() => undefined)).rejects.toThrow(/status\/set/)
  })

  it('新建恢复会话时拒绝坏事实并回滚会话发布', async () => {
    const ctx = await setup()
    const id = SessionId('invalid-restored')
    expect(() => ctx.sessions.create(id, { seed: [statusEvent({ turn: 1, text: ' bad ' })] }))
      .toThrow(/status\/set/)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(() => ctx.sessions.create(id, { seed: [statusEvent({ turn: 1, text: '有效' })] })).not.toThrow()
  })

  it('忽略其他分发、其他会话事实，以及形状合法但错轮次的状态', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      ctx.emit('session/created', session)
      ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
      ctx.emit('session/event', session, statusEvent({ turn: 100, text: '未来轮次由投影忽略' }))
    }).not.toThrow()
  })

  it('卸载移除校验和包所有权，HMR 再挂载恢复实时校验', async () => {
    const ctx = await setup(false)
    const fiber = await ctx.plugin(StatusInvariant)
    const invalid = statusEvent({ turn: 1, text: '' })
    expect(() => { ctx.emit('session/event', {} as Session, invalid) }).toThrow(/status\/set/)
    await fiber.dispose()
    expect(() => { ctx.emit('session/event', {} as Session, invalid) }).not.toThrow()
    await ctx.plugin(StatusInvariant)
    expect(() => { ctx.emit('session/event', {} as Session, invalid) }).toThrow(/status\/set/)
  })
})
