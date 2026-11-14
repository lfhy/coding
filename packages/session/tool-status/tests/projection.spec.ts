/** 实时投影、重放和持久检查点必须遵守同一轮次边界及会话隔离。 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent, type TodoItem } from 'coding-session'
import SessionProjectionRegistry from 'coding-session-projection'
import * as ToolStatus from '../src/index.ts'
import { callStatus, statusAgent, statusHarness } from './harness.ts'

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function setup(tool = true): Promise<Context> {
  context = await statusHarness({ projections: true, tool })
  return context
}

describe('turnStatus 投影', () => {
  it('空日志为 null 且切点为 -1，每次读取与最后已提交 seq 对齐', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'empty')
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({ asOfSeq: -1, values: { turnStatus: null } })
    owner.session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({ asOfSeq: 0, values: { turnStatus: null } })
    await callStatus(ctx, owner, { text: '正在检查' })
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({ asOfSeq: 1, values: { turnStatus: '正在检查' } })
    await callStatus(ctx, owner, { text: '正在验证' })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('正在验证')
    await callStatus(ctx, owner, { text: null })
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({ asOfSeq: 3, values: { turnStatus: null } })
  })

  it.each([
    ['进行中', [{ content: '验证', status: 'in_progress' }]],
    ['全部完成', [{ content: '验证', status: 'completed' }]],
    ['空表', []],
  ] satisfies [string, TodoItem[]][])('set -> %s待办 -> 再 set 按提交顺序交替显示', async (_label, todos) => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'todo-rotation', 4)
    await callStatus(ctx, owner, { text: '手动报告' })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('手动报告')
    const todo = owner.session.append('todo/write', { todos })
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({ asOfSeq: todo.seq, values: { turnStatus: null } })
    await callStatus(ctx, owner, { text: '后续手动报告' })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('后续手动报告')
    expect(owner.session.events.filter(event => event.type === 'todo/write').map(event => event.data.todos)).toEqual([todos])
  })

  it('turn/end 与新的 turn/start 清空，旧轮次和未来轮次事件不复活覆盖', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'turn-boundaries', 1)
    await callStatus(ctx, owner, { text: '第一轮' })
    owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()
    owner.session.append('status/set', { turn: 1, text: '结束后迟到' })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()
    owner.session.append('turn/start', { turn: 2 })
    await callStatus(ctx, owner, { text: '第二轮' })
    for (const turn of [1, 3]) {
      owner.session.append('status/set', { turn, text: '错轮次' })
      owner.session.append('status/set', { turn, text: null })
      expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('第二轮')
    }
    owner.session.append('turn/start', { turn: 3 })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()
    expect(ctx.sessionProjections.snapshot(owner.session).asOfSeq).toBe(owner.session.seq - 1)
  })

  it('变更流只为有效状态变化推送，错轮次与无关事件只推进切点', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'changes', 2)
    const seen: { session: string; key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      seen.push({ session: session.id, key, value, seq })
    })
    const first = owner.session.append('status/set', { turn: 2, text: '检查' })
    owner.session.append('step/start', { turn: 2, step: 1 })
    owner.session.append('status/set', { turn: 1, text: '过时' })
    owner.session.append('status/set', { turn: 3, text: '未来' })
    const todo = owner.session.append('todo/write', { todos: [] })
    owner.session.append('todo/write', { todos: [] })
    expect(seen).toEqual([
      { session: owner.id, key: 'turnStatus', value: '检查', seq: first.seq },
      { session: owner.id, key: 'turnStatus', value: null, seq: todo.seq },
    ])
    expect(ctx.sessionProjections.snapshot(owner.session)).toEqual({
      asOfSeq: owner.session.seq - 1, values: { turnStatus: null },
    })
  })

  it('父会话、子会话和相同轮次的其他会话均独立，待办和结束不会跨会话清除', async () => {
    const ctx = await setup()
    const parent = statusAgent(ctx, 'parent', 1)
    const childSession = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id, origin: 'subagent' } })
    childSession.append('turn/start', { turn: 1 })
    const child = { ...parent, id: childSession.id, session: childSession }
    const other = statusAgent(ctx, 'independent', 1)
    await callStatus(ctx, parent, { text: '父任务' })
    await callStatus(ctx, child, { text: '子任务' })
    await callStatus(ctx, other, { text: '独立任务' })
    child.session.append('todo/write', { todos: [] })
    other.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.snapshot(parent.session).values.turnStatus).toBe('父任务')
    expect(ctx.sessionProjections.snapshot(child.session).values.turnStatus).toBeNull()
    expect(ctx.sessionProjections.snapshot(other.session).values.turnStatus).toBeNull()
    await callStatus(ctx, child, { text: '子任务继续' })
    expect(ctx.sessionProjections.snapshot(parent.session).values.turnStatus).toBe('父任务')
    expect(ctx.sessionProjections.snapshot(child.session).values.turnStatus).toBe('子任务继续')
  })

  it('序列化重放恢复开放轮次的最新进度，不把领域事实加入模型消息', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'source', 8)
    await callStatus(ctx, owner, { text: '初次报告' })
    owner.session.append('todo/write', { todos: [] })
    await callStatus(ctx, owner, { text: '最新报告' })
    owner.session.append('status/set', { turn: 7, text: '过时报告' })
    const seed = JSON.parse(JSON.stringify(owner.session.events)) as SessionEvent[]
    const replay = ctx.sessions.create(SessionId('replay'), { seed })
    expect(ctx.sessionProjections.snapshot(replay)).toEqual({
      asOfSeq: replay.seq - 1, values: { turnStatus: '最新报告' },
    })
    expect(replay.deriveMessages()).toEqual([])
    replay.append('turn/end', { turn: 8, reason: { kind: 'completed' } })
    const closedReplay = Session.create(SessionId('closed-replay'), replay.events)
    expect(ctx.sessionProjections.snapshot(closedReplay).values.turnStatus).toBeNull()
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('最新报告')
  })

  it('投影缓存为版本 1，冷恢复仅折叠尾部且旧版本必须全量重建', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'checkpoint', 5)
    await callStatus(ctx, owner, { text: '检查点进度' })
    const checkpoint = ctx.sessionProjections.checkpoint(owner.session)
    expect(checkpoint.turnStatus).toEqual({ ver: 1, seq: owner.session.seq - 1, val: { turn: 5, text: '检查点进度' } })
    owner.session.append('todo/write', { todos: [] })
    await callStatus(ctx, owner, { text: '检查点之后' })
    const floor = ctx.sessionProjections.restoreFloor(checkpoint)
    expect(floor).toBe(1)
    if (floor === undefined) throw new Error('missing restore floor')
    const restored = ctx.sessionProjections.restore(checkpoint, owner.session.events.slice(floor), floor)
    expect(restored.snapshot).toEqual(ctx.sessionProjections.snapshot(owner.session))
    const old = { turnStatus: { ver: 0, seq: 1, val: { turn: 5, text: '旧缓存' } } }
    expect(ctx.sessionProjections.viewCheckpoint(old)).toEqual({})
    expect(ctx.sessionProjections.restoreFloor(old)).toBe(0)
    expect(ctx.sessionProjections.restore(old, owner.session.events, 0).snapshot).toEqual(restored.snapshot)
    owner.session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.restore(restored.checkpoint, owner.session.events, 0).snapshot.values.turnStatus).toBeNull()
  })

  it('晚注册从既有日志恢复；HMR 卸载移除工具及投影，再挂载丢弃旧 cell', async () => {
    const ctx = await setup(false)
    const owner = statusAgent(ctx, 'hmr', 6)
    owner.session.append('status/set', { turn: 6, text: '挂载前事实' })
    expect(ctx.sessionProjections.snapshot(owner.session).values).toEqual({})
    const first = await ctx.plugin(ToolStatus)
    expect(ctx.tools.get('set_status')).toBeDefined()
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('挂载前事实')
    await first.dispose()
    expect(ctx.tools.get('set_status')).toBeUndefined()
    expect(ctx.tools.schemas().some(schema => schema.name === 'set_status')).toBe(false)
    expect(ctx.sessionProjections.snapshot(owner.session).values).toEqual({})
    owner.session.append('todo/write', { todos: [] })
    await ctx.plugin(ToolStatus)
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()
    await callStatus(ctx, owner, { text: '重新挂载后' })
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('重新挂载后')
  })

  it('无投影服务时仍可写入，服务稍后出现会从日志恢复', async () => {
    context = await statusHarness()
    const ctx = context
    const owner = statusAgent(ctx, 'headless', 3)
    expect(ctx.get('sessionProjections')).toBeUndefined()
    expect((await callStatus(ctx, owner, { text: '不依赖投影服务' })).isError).toBe(false)
    await ctx.plugin(SessionProjectionRegistry)
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBe('不依赖投影服务')
  })
})
