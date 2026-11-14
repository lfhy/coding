/** 参数和结果均通过真实执行器，拒绝路径不得写入任何进度事实。 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from 'coding-llm'
import { supportsToolSummary, validateJsonSchemaValue } from 'coding-tools'
import * as ToolStatus from '../src/index.ts'
import { callStatus, resultText, statusAgent, statusFacts, statusHarness } from './harness.ts'

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function setup(): Promise<Context> {
  context = await statusHarness()
  return context
}

describe('set_status 工具契约', () => {
  it('固定模型 schema、说明与规范输出，不增加 summary', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'set_status')
    expect(schema).toBeDefined()
    expect(schema).toMatchSnapshot()
    expect(Object.keys((schema?.parameters as { properties: object }).properties)).toEqual(['text'])
    expect(supportsToolSummary('set_status')).toBe(false)
    expect(ctx.tools.get('set_status')?.output.schema).toEqual({
      type: 'object', additionalProperties: false,
      properties: { text: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['text'],
    })
  })

  it('Loader 保留具名插件的 name、inject 与 apply', () => {
    expect('default' in ToolStatus).toBe(false)
    expect(ToolStatus.name).toBe('tool-status')
    expect(ToolStatus.inject).toEqual(['tools'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(ToolStatus)).toBe(ToolStatus)
  })

  it('修剪输入并只向所属会话追加一条全量事实，结果与持久值一致', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'writer', 7)
    const other = statusAgent(ctx, 'other', 7)
    const result = await callStatus(ctx, owner, { text: '\u3000 正在检查代码 \u00a0' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ text: '正在检查代码' })
    expect(result.content).toEqual([{ type: 'text', text: 'Current progress: 正在检查代码' }])
    expect(statusFacts(owner.session).map(event => event.data)).toEqual([{ turn: 7, text: '正在检查代码' }])
    expect(other.session.events).toHaveLength(1)
    expect(owner.session.events.map(event => event.type)).toEqual(['turn/start', 'status/set'])
    expect(owner.session.deriveMessages()).toEqual([])
  })

  it('后续设置替换进度，null 和重复清除都留下可重放全量事实', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'replacement', 2)
    await callStatus(ctx, owner, { text: '检查' })
    await callStatus(ctx, owner, { text: '验证' })
    for (let index = 0; index < 2; index += 1) {
      const cleared = await callStatus(ctx, owner, { text: null })
      expect(cleared.isError).toBe(false)
      expect(cleared.value).toEqual({ text: null })
      expect(resultText(cleared)).toBe('Automatic progress restored.')
    }
    expect(statusFacts(owner.session).map(event => event.data)).toEqual([
      { turn: 2, text: '检查' }, { turn: 2, text: '验证' }, { turn: 2, text: null }, { turn: 2, text: null },
    ])
  })

  it.each(['a'.repeat(120), '😀'.repeat(120), '界'.repeat(119) + '😀'])('接受修剪后恰好到边界的文本', async (text) => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'unicode-limit', 0)
    const result = await callStatus(ctx, owner, { text: `  ${text}  ` })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ text })
    expect(statusFacts(owner.session).map(event => event.data)).toEqual([{ turn: 0, text }])
  })

  it.each([
    ['缺少字段', {}], ['undefined', { text: undefined }], ['数字', { text: 1 }],
    ['布尔', { text: true }], ['数组字段', { text: ['处理中'] }], ['对象字段', { text: {} }],
    ['null 根', null], ['数组根', []], ['字符串根', '处理中'],
    ['空文本', { text: '' }], ['纯空白', { text: ' \t\r\n\u3000' }],
    ['换行', { text: '第一行\n第二行' }], ['回车', { text: 'a\rb' }],
    ['Tab', { text: 'a\tb' }], ['控制符', { text: 'a\u0000b' }], ['DEL', { text: 'a\u007fb' }],
    ['C1 控制符', { text: 'a\u0085b' }], ['零宽格式符', { text: 'a\u200bb' }],
    ['方向格式符', { text: 'a\u202eb' }], ['连接格式符', { text: 'a\u200db' }],
    ['Unicode 行分隔', { text: 'a\u2028b' }], ['Unicode 段分隔', { text: 'a\u2029b' }],
    ['ASCII 超长', { text: 'a'.repeat(121) }], ['Unicode 超长', { text: '😀'.repeat(121) }],
  ])('拒绝%s且保留已有日志与进度', async (_label, args) => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'invalid', 1)
    await callStatus(ctx, owner, { text: '已有有效进度' })
    const before = [...owner.session.events]
    const result = await callStatus(ctx, owner, args)
    expect(result.isError).toBe(true)
    expect(result).not.toHaveProperty('value')
    expect(resultText(result)).not.toBe('')
    expect(owner.session.events).toEqual(before)
  })

  it('无 exec.agent 时即使已有其他开放会话也拒绝，不猜测所属者', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'not-the-owner', 1)
    const before = [...owner.session.events]
    const result = await callStatus(ctx, undefined, { text: '无所属者' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('owning agent session')
    expect(owner.session.events).toEqual(before)
  })

  it.each([false, true])('轮次外拒绝设置与清除，closed=%s', async (closed) => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'outside-turn', closed ? 1 : undefined)
    if (closed) {
      owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      owner.session.append('status/set', { turn: 1, text: '迟到旧轮次事实' })
    }
    const before = [...owner.session.events]
    for (const text of ['不能预设下一轮', null]) {
      const result = await callStatus(ctx, owner, { text })
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('open agent turn')
      expect(owner.session.events).toEqual(before)
    }
  })

  it('只认最新开放轮次，而不受夹杂的未来进度事实影响', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'latest-turn', 1)
    owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    owner.session.append('turn/start', { turn: 3 })
    owner.session.append('step/start', { turn: 3, step: 1 })
    owner.session.append('status/set', { turn: 99, text: '未来轮次' })
    const result = await callStatus(ctx, owner, { text: '当前轮次' })
    expect(result.isError).toBe(false)
    expect(statusFacts(owner.session).at(-1)?.data).toEqual({ turn: 3, text: '当前轮次' })
  })

  it('取消与策略拒绝均不产生进度事实', async () => {
    const ctx = await setup()
    const owner = statusAgent(ctx, 'cancelled', 1)
    const before = [...owner.session.events]
    const abort = new AbortController()
    abort.abort(new Error('test cancellation'))
    expect((await callStatus(ctx, owner, { text: '已取消' }, abort.signal)).isError).toBe(true)
    const stopDenying = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'set_status'
      ? Promise.resolve({ kind: 'deny', reason: 'test policy' }) : next())
    expect((await callStatus(ctx, owner, { text: '未获准' })).isError).toBe(true)
    stopDenying()
    expect(owner.session.events).toEqual(before)
  })

  it('设置与清除均独占执行，稳定中文标题不包含原始输入', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('set_status')
    for (const text of ['正在检查', null]) {
      const input = { name: 'set_status', arguments: { text }, callId: CallId('mode'), signal: new AbortController().signal }
      expect(ctx.tools.executionMode(input)).toEqual({ kind: 'exclusive' })
      expect(def?.presentCall?.({ text })).toEqual({ card: 'generic', title: '更新当前进度', kind: 'other' })
    }
    expect(def?.presentCall?.({})).toBeUndefined()
    expect(def?.presentCall?.({ text: 1 })).toBeUndefined()
    expect(def?.presentCall?.(null)).toBeUndefined()
  })

  it('输出边界只允许 text 的 string 或 null，不接受缺值和额外键', async () => {
    const ctx = await setup()
    const schema = ctx.tools.get('set_status')?.output.schema
    expect(schema).toBeDefined()
    if (schema === undefined) throw new Error('missing output schema')
    for (const value of [{ text: '处理中' }, { text: null }]) {
      expect(validateJsonSchemaValue(schema, value)).toEqual([])
    }
    for (const value of [{}, { text: 1 }, { text: null, extra: true }]) {
      expect(validateJsonSchemaValue(schema, value).length).toBeGreaterThan(0)
    }
  })
})
