/**
 * 免费通道 body 门的回归测试：上游只接受流式且带 agent 形状工具表的请求，
 * 而客户端自己的同名工具必须原样保留。
 */

import { describe, expect, it } from 'vitest'
import { ensureFreeLaneShape, FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from '../src/free-lane.ts'

function body(tools?: unknown[]): Record<string, unknown> {
  return { model: 'mimo-v2.6-flash-free', messages: [], stream: true, ...tools === undefined ? {} : { tools } }
}

function toolNames(payload: unknown): unknown[] {
  return (payload as { tools: { function: { name: string } }[] }).tools.map(entry => entry.function.name)
}

describe('ensureFreeLaneShape', () => {
  it('补齐缺失的门工具，并保留客户端自己的同名工具', () => {
    const own = { type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object' } } }
    const shaped = ensureFreeLaneShape(body([own]))
    expect(toolNames(shaped)).toEqual(['bash', 'read'])
    // 客户端注册的工具必须原样保留，否则模型会调用一个消费方并不实现的 schema。
    expect((shaped as { tools: unknown[] }).tools[0]).toBe(own)
  })

  it('没有任何工具时把 tool_choice 固定为 none，使注入的占位定义不会被调用', () => {
    const shaped = ensureFreeLaneShape(body()) as Record<string, unknown>
    expect(toolNames(shaped)).toEqual([...FREE_LANE_GATE_TOOL_NAMES])
    expect(shaped.tool_choice).toBe('none')
  })

  it('已有工具时保留调用方自己的 tool_choice', () => {
    const own = { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }
    const shaped = ensureFreeLaneShape({ ...body([own]), tool_choice: 'auto' }) as Record<string, unknown>
    expect(shaped.tool_choice).toBe('auto')
  })

  it('已满足门禁时返回 undefined，让 pi-ai 保留原请求体', () => {
    const complete = body([freeLaneGateTool('bash'), freeLaneGateTool('read')])
    expect(ensureFreeLaneShape(complete)).toBeUndefined()
  })

  it('不是 chat 请求体时返回 undefined', () => {
    expect(ensureFreeLaneShape(null)).toBeUndefined()
    expect(ensureFreeLaneShape([])).toBeUndefined()
    expect(ensureFreeLaneShape({ input: [] })).toBeUndefined()
  })

  it('占位工具声明自己不可调用', () => {
    expect(freeLaneGateTool('read').function.description).toContain('do not call')
  })
})
