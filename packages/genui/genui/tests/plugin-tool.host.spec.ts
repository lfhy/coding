// 上游 plugin-tool 测试的移植版：render_ui/validate_dsh_ui 工具定义、
// guard 支撑的修复与上限，以及 call/result 卡片与 meta 投影。
// 适配点：本仓库 ToolDefinition.execute/presentationMeta 需要 (args, exec/value)
// 双参签名，测试以哑 exec 对象补位。
import { describe, expect, it } from 'vitest'
import { createRenderUiTool, createValidateDshUiTool } from '../src/plugin/tool.ts'

const tool = createRenderUiTool()
const vtool = createValidateDshUiTool()
const exec = { signal: new AbortController().signal } as never

const text = (content: string) => ({ type: 'text', content })

describe('render_ui tool definition', () => {
  it('registers under the render_ui name with an open spec argument', () => {
    expect(tool.name).toBe('render_ui')
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(50)
    const parameters = tool.parameters as { required?: string[]; properties?: Record<string, unknown> }
    expect(parameters.required).toContain('spec')
    const spec = parameters.properties?.spec as { type?: string } | undefined
    expect(spec).toBeDefined()
    // spec 必须是 object：模型把整棵树序列化成字符串是已观察到的失败模式，
    // 参数校验直接挡下（guard 也修不了字符串）。
    expect(spec!.type).toBe('object')
    const specProps = (spec as { properties?: Record<string, unknown> }).properties
    expect(Object.keys(specProps ?? {})).toContain('items')
  })

  it('renders a valid spec and reports the rendered count', async () => {
    const value = await tool.execute({ spec: { title: '监控面板', items: [text('a'), { type: 'stat', label: 'CPU', value: '42%' }] } }, exec)
    expect(String(value)).toContain('rendered=2')
  })

  it('caps oversized specs at the guard limit and reports the cap', async () => {
    const value = await tool.execute({ spec: { items: Array.from({ length: 500 }, (_, i) => text(`n${i}`)) } }, exec)
    expect(String(value)).toContain('rendered=200')
  })

  it('returns the invalid protocol instead of throwing for unusable args', async () => {
    const value = await tool.execute({ spec: 'not a tree' }, exec)
    expect(String(value)).toContain('status=invalid')
  })
})

describe('validate_dsh_ui tool definition', () => {
  it('validates a good fence body end-to-end', async () => {
    const good = JSON.stringify({ items: [{ type: 'stat', label: '收入', value: '¥128,430', delta: '+12.4%' }] })
    const value = String(await vtool.execute({ spec: good }, exec))
    expect(value).toContain('status=valid')
    expect(value).toContain('rendered=1')
  })

  it('repairs an unbalanced-but-complete body and hands back the fixed JSON', async () => {
    const bad = '{"items":[{"type":"text","content":"你好"},],'
    const value = String(await vtool.execute({ spec: bad }, exec))
    expect(value).toContain('repair=applied')
    expect(value).toContain('next=emit_repaired_fence')
    expect(value).toContain('```')
  })

  it('reports structural bracket counts for unrepairable bodies', async () => {
    const bad = '{"title": "x", garbage'
    const v2 = String(await vtool.execute({ spec: bad }, exec))
    expect(v2).toContain('repair=failed')
    expect(v2).toContain('braces_open=')
  })

  it('keeps dropped-node diagnostics for a schema-invalid tree', async () => {
    const value = String(await vtool.execute({ spec: '{"items":[{"type":"table","rows":42}]}' }, exec))
    expect(value).toContain('status=invalid')
    expect(value).toContain('next=fix_and_revalidate')
  })

  it('presents generic cards for both call and result', () => {
    const call = tool.presentCall?.({ spec: { title: '面板', items: [] } })
    expect(call).toBeDefined()
    const result = tool.presentResult?.({ spec: { title: '面板', items: [] } }, { content: [], isError: false })
    expect(result).toBeDefined()
  })

  it('derives the repaired spec as presentationMeta for the browser toolview', () => {
    const args = { spec: { title: '监控', items: [{ type: 'stat', label: 'QPS', value: '99' }] } }
    const meta = tool.output.presentationMeta?.(args, '') as { title?: string } | undefined
    expect(meta).toBeDefined()
    expect(meta!.title).toBe('监控')
  })
})
