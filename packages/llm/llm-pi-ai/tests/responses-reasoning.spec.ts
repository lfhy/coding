import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createAssistantMessage, createUserMessage } from 'coding-llm'
import type { StreamChunk } from 'coding-llm'
import { Session, SessionId } from 'coding-session'
import type { SessionEvent } from 'coding-session'
import * as LlmPiAi from 'coding-llm-pi-ai'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

function responseEvents(summary: string, encryptedContent: string, responseId: string): {
  events: string[]
  reasoningItem: Record<string, unknown>
} {
  const reasoningItem = {
    type: 'reasoning',
    id: `rs_${responseId}`,
    status: 'completed',
    summary: summary === '' ? [] : [{ type: 'summary_text', text: summary }],
    encrypted_content: encryptedContent,
  }
  const messageItem = {
    type: 'message',
    id: `msg_${responseId}`,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The answer', annotations: [] }],
  }
  return {
    reasoningItem,
    events: [
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoningItem.id } },
      ...summary === '' ? [] : [{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: summary }],
      { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: messageItem.id } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'The answer' },
      { type: 'response.output_item.done', output_index: 1, item: messageItem },
      {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          output: [reasoningItem, messageItem],
          usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
        },
      },
    ].map(event => JSON.stringify(event)).concat('[DONE]'),
  }
}

describe('Responses 加密推理回放', () => {
  it.each([
    ['有可读摘要', 'A readable summary'],
    ['只有密文', ''],
  ])('%s：密文只作为同模型下一轮的回放元数据', async (_scenario, summary) => {
    const ciphertext = 'opaque-encrypted-reasoning-for-next-turn'
    const first = responseEvents(summary, ciphertext, 'resp_first')
    const second = responseEvents('', 'opaque-second-turn', 'resp_second')
    const server = await mockServer([{ events: first.events }, { events: second.events }])
    vi.stubEnv('RESPONSES_TEST_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'responses-test': {
          apiKeyEnv: 'RESPONSES_TEST_KEY',
          api: 'openai-responses',
          baseURL: `${server.url}/v1`,
          reasoning: 'high',
          models: [{
            id: 'reasoning-model',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })

    const prompt = createUserMessage({
      content: [{ type: 'text', text: 'Question' }],
      source: { kind: 'user' },
    })
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'responses-test', model: 'reasoning-model', messages: [prompt] })) {
      chunks.push(chunk)
      assembler.push(chunk)
    }
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: summary },
      { type: 'text', text: 'The answer' },
    ])
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')).toBe(summary)
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual(assembler.blocks())
    expect(JSON.stringify(assembler.blocks())).not.toContain(ciphertext)
    expect(assembler.replayState?.blocks?.[0]).toMatchObject({ type: 'reasoning' })
    const firstRequest = server.requests[0] as Record<string, unknown>
    expect(firstRequest).toMatchObject({
      model: 'reasoning-model',
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high', summary: 'auto' },
    })

    const sessionId = SessionId(`responses-reasoning-${summary === '' ? 'opaque' : 'summary'}`)
    const session = Session.create(sessionId)
    session.append('user/message', prompt, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: 'responses-test',
          model: 'reasoning-model',
          ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
        },
      }),
    }, { surfaceOp: 'append' })
    const savedEvents = JSON.parse(JSON.stringify(session.events)) as SessionEvent[]
    const restored = Session.create(sessionId, savedEvents)
    expect(restored.deriveMessages().map(message => message.content)).toEqual(session.deriveMessages().map(message => message.content))
    expect(restored.deriveMessages()[1]?.content[0]).toEqual({ type: 'reasoning', text: summary })

    for await (const _chunk of ctx.llm.stream({
      provider: 'responses-test',
      model: 'reasoning-model',
      messages: [
        ...restored.deriveMessages(),
        createUserMessage({ content: [{ type: 'text', text: 'Follow up' }], source: { kind: 'user' } }),
      ],
    })) {
      // 消费完整响应，确保第二个请求已结束。
    }
    const secondRequest = server.requests[1] as { input: unknown[] }
    expect(secondRequest.input).toContainEqual(first.reasoningItem)
    expect(server.paths).toEqual(['/v1/responses', '/v1/responses'])
  })
})
