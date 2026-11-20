import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from 'coding-llm'
import type { ToolSchema } from 'coding-llm'
import * as LlmPiAi from 'coding-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const PATCH = '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch'
const GRAMMAR = 'start: /[\\s\\S]+/'
const tool: ToolSchema = {
  name: 'apply_patch',
  description: 'Supply a patch as JSON input.',
  parameters: {
    type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false,
  },
  inputFormat: {
    type: 'grammar', syntax: 'lark', definition: GRAMMAR,
    description: 'Supply the patch directly.',
  },
}

const customCall = {
  type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'apply_patch', input: PATCH,
}
const customEvents = [
  { type: 'response.output_item.added', output_index: 0, item: { ...customCall, input: '' } },
  { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: PATCH.slice(0, 18) },
  { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: PATCH.slice(18) },
  { type: 'response.custom_tool_call_input.done', output_index: 0, input: PATCH },
  { type: 'response.output_item.done', output_index: 0, item: customCall },
  { type: 'response.completed', response: {
    id: 'resp_1', status: 'completed', output: [customCall],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
  } },
].map(event => JSON.stringify(event))

const answerEvents = [
  { type: 'response.output_item.added', output_index: 0, item: {
    type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }],
  } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'done' },
  { type: 'response.completed', response: {
    id: 'resp_2', status: 'completed', output: [],
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17 },
  } },
].map(event => JSON.stringify(event))

beforeEach(() => { vi.stubEnv('PI_GRAMMAR_KEY', 'test-key') })
afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

async function harness(baseURL: string, optOut = false, api = 'openai-responses'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {
    gateway: {
      apiKeyEnv: 'PI_GRAMMAR_KEY', api, baseURL,
      models: [{ id: 'model-alpha', ...optOut ? { compat: { supportsOpenAIGrammarTools: false } } : {} }],
    },
  } })
  return ctx
}

describe('Responses grammar tool dispatch', () => {
  it('sends a custom schema and streams a raw patch as a JSON string argument', async () => {
    const server = await mockServer([{ events: customEvents }])
    const ctx = await harness(`${server.url}/v1`)
    const result = await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [], tools: [tool] })

    expect(result.finish).toEqual({ kind: 'tool-calls' })
    expect(server.paths).toEqual(['/v1/responses'])
    expect(server.requests[0]).toMatchObject({ tools: [{
      type: 'custom', name: 'apply_patch', description: 'Supply the patch directly.',
      format: { type: 'grammar', syntax: 'lark', definition: GRAMMAR },
    }] })
    expect(result.message.content).toMatchObject([{
      type: 'tool-call', name: 'apply_patch', arguments: JSON.stringify({ input: PATCH }),
    }])
  })

  it('replays matching calls and results as a native custom pair', async () => {
    const server = await mockServer([{ events: customEvents }, { events: answerEvents }])
    const ctx = await harness(`${server.url}/v1`)
    const first = await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [], tools: [tool] })
    const call = first.message.content[0]
    if (call?.type !== 'tool-call') throw new Error('the first response did not call the tool')
    const result = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'patched' }] }],
    })

    await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [first.message, result], tools: [tool] })
    expect(server.requests[1]).toMatchObject({ input: [
      { type: 'custom_tool_call', name: 'apply_patch', input: PATCH },
      { type: 'custom_tool_call_output', output: 'patched' },
    ] })
  })

  it('replays a removed grammar tool as a consistent function call and result', async () => {
    const server = await mockServer([{ events: customEvents }, { events: answerEvents }])
    const ctx = await harness(`${server.url}/v1`)
    const first = await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [], tools: [tool] })
    const call = first.message.content[0]
    if (call?.type !== 'tool-call') throw new Error('the first response did not call the tool')
    const result = createUserMessage({
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'patched' }] }],
    })

    await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [first.message, result], tools: [] })
    expect(server.requests[1]).toMatchObject({ input: [
      { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: PATCH }) },
      { type: 'function_call_output', output: 'patched' },
    ] })
  })

  it('keeps the JSON tool and its original description when the model opts out', async () => {
    const server = await mockServer([{ events: answerEvents }])
    const ctx = await harness(`${server.url}/v1`, true)
    await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [], tools: [tool] })
    expect(server.requests[0]).toMatchObject({ tools: [{
      type: 'function', name: 'apply_patch', description: 'Supply a patch as JSON input.',
      parameters: tool.parameters,
    }] })
  })

  it('keeps the JSON tool on a non-Responses protocol regardless of model ID', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(`${server.url}/v1`, false, 'openai-completions')
    const result = await assemble(ctx, { provider: 'gateway', model: 'model-alpha', messages: [], tools: [tool] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.requests[0]).toMatchObject({ tools: [{
      type: 'function', function: { name: 'apply_patch', description: 'Supply a patch as JSON input.' },
    }] })
  })
})
