/** 纯状态模块固定持久字符串边界、轮次匹配与待办接管语义。 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap, TodoItem } from 'coding-session'
import {
  applyStatus, STATUS_TEXT_MAX_LENGTH, statusEventSchema, statusProjectionSchema, statusTextSchema,
  type StatusState,
} from '../src/status.ts'

function event<K extends 'turn/start' | 'turn/end' | 'status/set' | 'todo/write' | 'step/start'>(
  type: K, data: SessionEventMap[K],
): SessionEvent {
  return { type, data, seq: 0, time: 0 } as SessionEvent
}

const empty: StatusState = Object.freeze({ turn: null, text: null })

describe('规范进度字符串', () => {
  it('固定长度上限，并按 Unicode 码点而非 UTF-16 单元计数', () => {
    expect(STATUS_TEXT_MAX_LENGTH).toBe(120)
    expect(statusTextSchema.parse('😀'.repeat(120))).toBe('😀'.repeat(120))
    expect(statusTextSchema.safeParse('😀'.repeat(121)).success).toBe(false)
    expect(statusTextSchema.parse('进'.repeat(119) + '😀')).toBe('进'.repeat(119) + '😀')
    expect(statusTextSchema.safeParse('e\u0301'.repeat(61)).success).toBe(false)
  })

  it.each(['处理中', '正在 检查', 'a', 'a'.repeat(120), 'e\u0301', '进度：50%'])('保留规范值 %j', (text) => {
    expect(statusTextSchema.parse(text)).toBe(text)
    expect(statusProjectionSchema.parse(text)).toBe(text)
  })

  it.each([
    '', ' ', ' 已完成', '已完成 ', '\u00a0已完成', '已完成\u3000',
    '第一行\n第二行', '第一行\r第二行', 'a\tb', 'a\u0000b', 'a\u000bb',
    'a\u007fb', 'a\u0085b', 'a\u200bb', 'a\u200db', 'a\u202eb', 'a\u2066b',
    'a\ufeffb', 'a\u2028b', 'a\u2029b', 'a'.repeat(121),
  ])('拒绝非规范持久文本 %j', (text) => {
    expect(statusTextSchema.safeParse(text).success).toBe(false)
    expect(statusProjectionSchema.safeParse(text).success).toBe(false)
  })

  it.each([null, undefined, 1, true, {}, []])('拒绝非字符串 %j', (value) => {
    expect(statusTextSchema.safeParse(value).success).toBe(false)
  })

  it('投影允许 null，但不允许缺值或对象', () => {
    expect(statusProjectionSchema.parse(null)).toBeNull()
    expect(statusProjectionSchema.safeParse(undefined).success).toBe(false)
    expect(statusProjectionSchema.safeParse({ text: '处理中' }).success).toBe(false)
  })
})

describe('status/set 持久事实结构', () => {
  it.each([{ turn: 0, text: '处理中' }, { turn: 7, text: null }])('接受完整事实 %j', (value) => {
    expect(statusEventSchema.parse(value)).toEqual(value)
  })

  it.each([
    null, [], {}, { turn: 1 }, { text: '处理中' }, { turn: '1', text: null },
    { turn: -1, text: null }, { turn: 0.5, text: null }, { turn: NaN, text: null },
    { turn: Infinity, text: null }, { turn: Number.MAX_SAFE_INTEGER + 1, text: null },
    { turn: 1, text: 12 }, { turn: 1, text: ' padded ' }, { turn: 1, text: '' },
    { turn: 1, text: null, extra: true },
  ])('拒绝不完整或非规范事实 %j', (value) => {
    expect(statusEventSchema.safeParse(value).success).toBe(false)
  })
})

describe('纯状态折叠', () => {
  it('仅当前开放轮次接受全量更新和 null 清除，不改写输入', () => {
    const opened = Object.freeze(applyStatus(empty, event('turn/start', { turn: 4 })))
    expect(opened).toEqual({ turn: 4, text: null })
    const first = Object.freeze(applyStatus(opened, event('status/set', { turn: 4, text: '检查代码' })))
    const second = applyStatus(first, event('status/set', { turn: 4, text: '准备验证' }))
    expect(second).toEqual({ turn: 4, text: '准备验证' })
    expect(first).toEqual({ turn: 4, text: '检查代码' })
    expect(opened).toEqual({ turn: 4, text: null })
    expect(applyStatus(second, event('status/set', { turn: 4, text: null })))
      .toEqual({ turn: 4, text: null })
  })

  it('无开放轮次以及过时或未来轮次的进度不会覆盖当前值', () => {
    expect(applyStatus(empty, event('status/set', { turn: 9, text: '提前写入' }))).toBe(empty)
    const current: StatusState = Object.freeze({ turn: 9, text: '当前工作' })
    for (const turn of [0, 8, 10, 100]) {
      expect(applyStatus(current, event('status/set', { turn, text: '错轮次' }))).toBe(current)
      expect(applyStatus(current, event('status/set', { turn, text: null }))).toBe(current)
    }
    expect(applyStatus(current, event('status/set', { turn: 9, text: '正确轮次' })))
      .toEqual({ turn: 9, text: '正确轮次' })
  })

  it('turn/start 和 turn/end 均清空，结束后迟到事实不复活', () => {
    const current = { turn: 2, text: '处理中' }
    expect(applyStatus(current, event('turn/start', { turn: 3 }))).toEqual({ turn: 3, text: null })
    const closed = applyStatus(current, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    expect(closed).toEqual({ turn: null, text: null })
    expect(applyStatus(closed, event('status/set', { turn: 2, text: '迟到' }))).toBe(closed)
  })

  it.each([
    ['进行中待办', [{ content: '验证改动', status: 'in_progress' }]],
    ['全部完成', [{ content: '验证改动', status: 'completed' }]],
    ['空待办', []],
  ] satisfies [string, TodoItem[]][])('%s接管手动进度，再 set 可重新显示', (_label, todos) => {
    const current = Object.freeze({ turn: 2, text: '手动进度' })
    const afterTodo = applyStatus(current, event('todo/write', { todos }))
    expect(afterTodo).toEqual({ turn: 2, text: null })
    expect(current).toEqual({ turn: 2, text: '手动进度' })
    expect(applyStatus(afterTodo, event('status/set', { turn: 2, text: '重新报告' })))
      .toEqual({ turn: 2, text: '重新报告' })
  })

  it('无手动进度时待办及无关事件保留引用，避免多余投影推送', () => {
    expect(applyStatus(empty, event('todo/write', { todos: [] }))).toBe(empty)
    const opened = Object.freeze({ turn: 1, text: null })
    expect(applyStatus(opened, event('todo/write', { todos: [] }))).toBe(opened)
    expect(applyStatus(opened, event('step/start', { turn: 1, step: 1 }))).toBe(opened)
  })

  it('非法状态事实在纯重放边界失败，不静默修复', () => {
    const malformed = { type: 'status/set', seq: 0, time: 0, data: { turn: 1, text: ' padded ' } } as SessionEvent
    expect(() => applyStatus({ turn: 1, text: '有效值' }, malformed)).toThrow(/trimmed/)
  })
})
