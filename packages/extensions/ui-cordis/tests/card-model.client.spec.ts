// 插件卡片只从冻结的调用和结果切片派生身份、展示说明及状态。

import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolResultNode } from 'coding-client-runtime/client'
import { cordisActionCard, cordisDefineCard, cordisRunCard } from '../src/client/card-model.ts'

const ARGS = '{"name":"clock","purpose":"顶栏时钟","code":{"client":"return {}","host":"harness.handle(\'now\', () => Date.now())"}}'

function running(over: Partial<RunningToolCall> = {}): RunningToolCall {
  return {
    callId: 'call-1', name: 'cordis_define', argsRaw: ARGS, turn: 1, step: 1, time: 1_000,
    callView: null, subCalls: [], ...over,
  }
}

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 2, time: 2_000, callId: 'call-1',
    call: { name: 'cordis_define', argsRaw: ARGS }, callTime: 1_000,
    content: [{ type: 'text', text: 'defined dyn-1' }], isError: false,
    meta: { pluginId: 'dyn-1', packageId: 'pkg-1' }, callView: null, resultView: null, subCalls: [], ...over,
  }
}

describe('cordisDefineCard', () => {
  it('reads name, purpose and both code halves off the call arguments', () => {
    const card = cordisDefineCard(running())
    expect(card).toMatchObject({
      name: 'clock', purpose: '顶栏时钟', clientCode: 'return {}', state: 'running', output: null,
    })
    expect(card.hostCode).toContain('harness.handle')
    // The host mints the id during define, so an unsettled call has none and the
    // card renders read-only.
    expect(card.pluginId).toBeNull()
    expect(card.packageId).toBeNull()
  })

  it('takes the minted id from the result presentation meta', () => {
    expect(cordisDefineCard(settled()).pluginId).toBe('dyn-1')
    expect(cordisDefineCard(settled()).packageId).toBe('pkg-1')
    expect(cordisDefineCard(settled()).output).toBe('defined dyn-1')
    expect(cordisDefineCard(settled()).state).toBe('ok')
  })

  it('renders read-only when the meta carries no usable id', () => {
    expect(cordisDefineCard(settled({ meta: undefined })).pluginId).toBeNull()
    expect(cordisDefineCard(settled({ meta: 'dyn-1' })).pluginId).toBeNull()
    expect(cordisDefineCard(settled({ meta: { pluginId: '' } })).pluginId).toBeNull()
    expect(cordisDefineCard(settled({ meta: { pluginId: 7 } })).pluginId).toBeNull()
  })

  it('classifies the define call’s own lifecycle and never operates a failed one', () => {
    const failed = cordisDefineCard(settled({
      isError: true, content: [{ type: 'text', text: 'SyntaxError: unexpected token\n  at line 3' }],
    }))
    expect(failed.state).toBe('error')
    expect(failed.errorSummary).toBe('SyntaxError: unexpected token')
    // A definition that failed to register has nothing to run.
    expect(failed.pluginId).toBeNull()

    expect(cordisDefineCard(settled({ isError: true, error: { name: 'E', code: 'interrupted' } })).state).toBe('stopped')
    expect(cordisDefineCard(settled({ content: [] })).output).toBeNull()
    expect(cordisDefineCard(settled({ content: [], error: { name: 'E', code: 'boom' } })).output).toBe('E: boom')
    // A non-text block has no display text of its own, so the row shows its JSON.
    expect(cordisDefineCard(settled({ content: [{ type: 'reasoning', text: 'weighing it' }] })).output)
      .toContain('"type": "reasoning"')
  })

  it('degrades on a truncated argument stream instead of dropping the row', () => {
    expect(cordisDefineCard(running({ argsRaw: '{"name":"clo' })).name).toBeNull()
    expect(cordisDefineCard(running({ argsRaw: '{"name":"clo' })).purpose).toBeNull()
    expect(cordisDefineCard(running({ argsRaw: '"just a string"' })).name).toBeNull()
  })

  it('没有名称时不把原始参数当作面向用户的回退', () => {
    expect(cordisDefineCard(running({ argsRaw: '{"purpose":"顶栏时钟"}' })).name).toBeNull()
    expect(cordisDefineCard(running({ argsRaw: '{"name":"","purpose":"顶栏时钟"}' })).name).toBeNull()
  })

  it('reports an unknown name when the event window cut the call head', () => {
    // 历史结果没有调用头时只保留已有的结果信息，不从调用标识编造名称。
    const card = cordisDefineCard(settled({ call: null }))
    expect(card.name).toBeNull()
    expect(card.purpose).toBeNull()
  })
})

describe('cordisActionCard', () => {
  it('keeps the Plugin identity and lifecycle result for Stop and Remove cards', () => {
    const card = cordisActionCard(settled({
      call: { name: 'cordis_stop', argsRaw: '{"pluginId":"clock-1"}' },
      content: [{ type: 'text', text: 'Stopped clock-1.' }],
      meta: undefined,
    }))

    expect(card).toEqual({
      pluginId: 'clock-1',
      displayDescription: undefined,
      output: 'Stopped clock-1.',
      errorSummary: null,
      state: 'ok',
    })
  })
})

describe('工具调用展示说明', () => {
  const description = '更新页头时间显示'
  it('定义、运行、停止都从各自冻结参数取说明', () => {
    const defineArgs = JSON.stringify({ name: 'clock', display_description: ` ${description} ` })
    expect(cordisDefineCard(running({ argsRaw: defineArgs })).displayDescription).toBe(description)
    expect(cordisDefineCard(settled({ call: { name: 'cordis_define', argsRaw: defineArgs } })).displayDescription)
      .toBe(description)
    const runArgs = JSON.stringify({ mode: 'run', pluginId: 'clock-1', display_description: description })
    expect(cordisRunCard(running({ argsRaw: runArgs })).displayDescription).toBe(description)
    expect(cordisRunCard(settled({ call: { name: 'cordis_run', argsRaw: runArgs } })).displayDescription)
      .toBe(description)
    expect(cordisActionCard(settled({ call: { name: 'cordis_stop', argsRaw: runArgs } })).displayDescription)
      .toBe(description)
  })

  it('没有调用头或参数不完整时忽略说明且保留失败结果', () => {
    expect(cordisDefineCard(running({ argsRaw: '{"display_description":' })).displayDescription).toBeUndefined()
    expect(cordisRunCard(settled({ call: null })).displayDescription).toBeUndefined()
    const failed = cordisActionCard(settled({ call: null, isError: true, content: [
      { type: 'text', text: '操作失败\n查看详情' },
    ] }))
    expect(failed.displayDescription).toBeUndefined()
    expect(failed.errorSummary).toBe('操作失败')
  })
})
