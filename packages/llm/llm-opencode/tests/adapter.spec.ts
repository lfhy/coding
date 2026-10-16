/**
 * 适配器端到端测试：用注入的假提供商观察发往上游的构造函数调用，
 * 断言请求头、请求体门与流式分片的形状——这些正是上游按指纹拒绝的点。
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import * as LlmOpencode from '@deepseek-ai/dsh-llm-opencode'
import { ensureFreeLaneShape } from '../src/free-lane.ts'
import { disguiseHeaders, deriveRequestIds } from '../src/ids.ts'
import { resolveOpencodeOptions } from '../src/config.ts'

/** 一次 streamSimple 调用的记录。 */
interface Call {
  model: {
    id: string
    baseUrl: string
    contextWindow: number
    input: readonly string[]
    reasoning: boolean
    thinkingLevelMap?: Readonly<Record<string, string | null>>
  }
  context: unknown
  options: Record<string, unknown>
}

/** 假 pi-ai 提供商：记录调用并回放一段固定事件流。 */
function fakeProvider(events: AssistantMessageEvent[], calls: Call[]) {
  return {
    id: 'opencode-zen',
    name: 'fake',
    auth: {},
    getModels: () => [],
    stream: () => { throw new Error('unused') },
    streamSimple: (model: Call['model'], context: unknown, options: Record<string, unknown>) => {
      calls.push({ model, context, options })
      return (async function* () { for (const event of events) yield event })()
    },
  }
}

/** 一段最小的成功事件流：文本块 + 终止事件。 */
function textEvents(text: string): AssistantMessageEvent[] {
  const partial = { content: [{ type: 'text', text }], usage: undefined } as never
  return [
    { type: 'start', partial },
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: text, partial },
    { type: 'text_end', contentIndex: 0, content: text, partial },
    {
      type: 'done',
      message: {
        api: 'openai-completions',
        provider: 'opencode-zen',
        model: 'mimo-v2.6-flash-free',
        content: [{ type: 'text', text }],
        usage: {
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 0,
      },
    } as unknown as AssistantMessageEvent,
  ]
}

const disposers: Context[] = []
afterEach(async () => {
  for (const ctx of disposers.splice(0)) await ctx.fiber.dispose()
})

/** 组装一个只挂 LLM 服务与假提供商的上下文。 */
async function harness(events: AssistantMessageEvent[], calls: Call[], config: object = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpencode, config)
  // 注入假提供商：真实提供商由插件在请求时构造，测试观察的是它的调用参数。
  const adapter = new LlmOpencode.OpencodeZenAdapter({
    options: () => resolveOpencodeOptions(config),
    providerOverride: fakeProvider(events, calls) as never,
  })
  const registration = ctx.llm.registerAdapter(['fake-route'], adapter)
  ctx.effect(() => registration, 'test: fake route')
  disposers.push(ctx)
  return ctx
}

describe('adapter wire shape', () => {
  it('发出 CLI 同形的伪装头，并把请求体改成免费通道形状', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'mimo-v2.6-flash-free',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)

    const call = calls[0]!
    const options = call.options
    const headers = options.headers as Record<string, string>
    // 会话头必须是官方形状且时钟段来自真实时钟；四个关联头同值。
    const session = headers['x-opencode-session']!
    expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(session.slice(4, 16)).toMatch(/^[0-9a-f]{9}f[c-f][0-9a-f]$/)
    expect(headers['x-opencode-session-id']).toBe(session)
    expect(headers['x-session-affinity']).toBe(session)
    expect(headers['X-Session-Id']).toBe(session)
    expect(headers['x-opencode-client']).toBe('cli')
    expect(headers['x-opencode-project']).toMatch(/^[0-9a-f]{40}$/)
    // 上游会拒收请求级关联头，因此它不能出现在线上头里。
    expect(headers).not.toHaveProperty('x-opencode-request')
    // 指纹 UA 是这条路由的最终值：换成 harness 归因 UA 会被上游 403。
    expect(headers['user-agent']).toMatch(/^opencode\//)
    expect(options.apiKey).toBe('public')
    expect(call.model.baseUrl).toBe('https://opencode.ai/zen/v1')
    // 能力声明进入 pi-ai 的模型描述符：模态决定图片是否内联。
    expect(call.model.input).toEqual(['text', 'image'])
    expect(call.model.reasoning).toBe(true)
    expect(call.model.thinkingLevelMap).toBeUndefined()
    expect(options.reasoning).toBeUndefined()

    // onPayload 是 pi-ai 在序列化后改写请求体的钩子：这里断言它确实补了门工具。
    const shape = options.onPayload as (payload: unknown) => unknown
    const shaped = shape({ model: 'mimo-v2.6-flash-free', messages: [], stream: true }) as { tools: unknown[] }
    expect(shaped.tools).toHaveLength(2)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.at(-2)).toMatchObject({ type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('把选中的推理档位转发给 pi-ai，并把未声明的档位钉成不支持', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'deepseek-v4.1-flash-free',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'think' }], source: { kind: 'user' } })],
      reasoningEffort: ReasoningEffortId('high'),
    })) { /* drain */ }

    const call = calls[0]!
    expect(call.options.reasoning).toBe('high')
    // 声明的档位带上自身拼写（pi-ai 据此发出 reasoning_effort），未声明的档位钉成 null，
    // 因此选择器给出的档位都能真正转发。
    expect(call.model.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
    })
    expect(call.model.input).toEqual(['text', 'image'])
  })

  it('没有档位声明的模型不携带档位映射，选择器只留提供方默认', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'nemotron-3.5-lightning-free',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) { /* drain */ }
    expect(calls[0]?.model.input).toEqual(['text'])
    expect(calls[0]?.model.reasoning).toBe(true)
    expect(calls[0]?.model.thinkingLevelMap).toBeUndefined()
  })

  it('同一会话的两次调用复用同一个会话 id 与项目头', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'stable' }], source: { kind: 'user' } })]
    for (let index = 0; index < 2; index += 1) {
      for await (const _chunk of ctx.llm.stream({ provider: 'fake-route', model: 'mimo-v2.6-flash-free', messages })) { /* drain */ }
    }
    const headerAt = (index: number, name: string): string | undefined =>
      (calls[index]?.options.headers as Record<string, string>)[name]
    expect(headerAt(1, 'x-opencode-session')).toBe(headerAt(0, 'x-opencode-session'))
    expect(headerAt(1, 'x-opencode-project')).toBe(headerAt(0, 'x-opencode-project'))
  })

  it('把工具 schema 与历史里的工具调用/结果投影到 pi-ai 词汇', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('done'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'mimo-v2.6-flash-free',
      system: 'be brief',
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'tool-call', id: CallId('call-1'), name: 'bash', arguments: '{"command":"ls"}' },
          ],
          source: { provider: 'fake-route', model: 'mimo-v2.6-flash-free' },
        }),
        createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: 'a.txt' }], isError: false }),
      ],
    })) { /* drain */ }

    const context = calls[0]!.context as { systemPrompt?: string; messages: { role: string }[]; tools?: { name: string }[] }
    expect(context.systemPrompt).toBe('be brief')
    expect(context.tools?.map(tool => tool.name)).toEqual(['bash'])
    expect(context.messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult'])
  })

  it('适配器拒绝未声明的推理档位，宿主把它交付为错误 finish', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'mimo-v2.6-flash-free',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      reasoningEffort: ReasoningEffortId('high'),
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
    })
    expect((finish as { reason: { failure: { message: string } } }).reason.failure.message)
      .toMatch(/reasoning effort/)
    expect(calls).toEqual([])
  })

  it('适配器自身的选项拒绝保持为适配器契约里的抛出', async () => {
    const adapter = new LlmOpencode.OpencodeZenAdapter({ options: () => resolveOpencodeOptions({}) })
    const rejected = adapter.stream({
      provider: 'fake-route',
      model: 'mimo-v2.6-flash-free',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      stop: ['\n\n'],
    })
    await expect(async () => {
      for await (const _chunk of rejected) { /* drain */ }
    }).rejects.toThrow(/does not support GenerateOptions.stop/)
  })
})

describe('wire helpers stay used', () => {
  it('导出面覆盖指纹、门与配置解析', () => {
    const ids = deriveRequestIds([{ role: 'user', content: 'x' }])
    expect(disguiseHeaders(ids)['x-opencode-client']).toBe('cli')
    expect(ensureFreeLaneShape({ messages: [], stream: true })).toBeDefined()
  })
})
