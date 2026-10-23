/**
 * 适配器端到端测试：用注入的假提供商观察发往上游的构造函数调用，
 * 断言请求头、请求体门与流式分片的形状——这些正是上游按指纹拒绝的点。
 */

import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from 'coding-attachment'
import type { AttachmentStore, ImageAttachmentRef } from 'coding-attachment'
import LlmRuntime, {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
} from 'coding-llm'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import * as LlmOpencode from 'coding-llm-opencode'
import { ensureFreeLaneShape } from '../src/free-lane.ts'
import { disguiseHeaders, deriveRequestIds } from '../src/ids.ts'

/** 持久化截图的引用；内联测试用它确认图片字节真的进了请求。 */
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 2,
  height: 2,
}

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

/** 组装一个只挂 LLM 服务与假提供商的上下文；`attachments` 供含图片的请求解析附件。 */
async function harness(
  events: AssistantMessageEvent[],
  calls: Call[],
  options: Pick<LlmOpencode.FreeChannelAdapterOptions, 'resolveAttachments'> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpencode)
  // 注入假提供商：真实提供商由插件在请求时构造，测试观察的是它的调用参数。
  const adapter = new LlmOpencode.FreeChannelAdapter({
    providerOverride: fakeProvider(events, calls) as never,
    ...options,
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
    // 因此选择器给出的档位都能真正转发。`none` 不在 pi-ai 词汇里，不出现为键。
    expect(call.model.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
    })
    expect(call.model.input).toEqual(['text', 'image'])
  })

  it('声明 none 档位的模型把 off 与未选档位都折算成显式关闭值', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'think' }], source: { kind: 'user' } })]
    // 选择器只暴露 off：none 与它同义（关闭推理）。`none` 不在目录折算后的
    // 选择器词汇里，直接以它发起会走 resolveCallFor 的未声明拒绝，因此这里
    // 验证的是真正能走通的路径：选 off 与完全不选档位。
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'Qwen3.5-397B-A17B',
      messages,
      reasoningEffort: ReasoningEffortId('off'),
    })) { /* drain */ }
    // OVH 的 Qwen3.5 把省略参数读作默认深推理，关闭必须显式发 `none`。
    expect(calls.map(call => call.options.reasoning)).toEqual(['none'])
    // 未点名档位同样显式关闭：省略参数会被上游读作默认深推理。
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'Qwen3.5-397B-A17B',
      messages,
    })) { /* drain */ }
    expect(calls.map(call => call.options.reasoning)).toEqual(['none', 'none'])
    // `off` 在声明了 none 的模型上映射成关闭值；none 不在 pi-ai 词汇里，不出现为键。
    expect(calls[0]!.model.thinkingLevelMap).toEqual({
      off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null,
    })
  })

  it('选择器里关闭档位只有一项 Off，其余档位按拼写大写', async () => {
    const ctx = await harness(textEvents('hi'), [])
    const qwen = await ctx.llm.resolveModelInfo('fake-route', 'Qwen3.5-397B-A17B')
    // off（「不点名档位」）与 none（线上的显式关闭值）语义相同，选择器只保留
    // off 一项；线上按模型声明折算成 none。
    expect(qwen.reasoning?.efforts.map(effort => effort.name)).toEqual(
      ['Off', 'Low', 'Medium', 'High', 'Xhigh'],
    )
    const deepseek = await ctx.llm.resolveModelInfo('fake-route', 'deepseek-v4.1-flash-free')
    expect(deepseek.reasoning?.efforts.map(effort => effort.name)).toEqual(
      ['Off', 'Low', 'High', 'Max'],
    )
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

  it('把工具结果里的截图内联进请求，而不是压成纯文本', async () => {
    const calls: Call[] = []
    const attachments = {
      readImage: () => Promise.resolve({ ref: IMAGE_REF, data: Uint8Array.of(1, 2, 3) }),
    } as unknown as AttachmentStore
    const ctx = await harness(textEvents('done'), calls, { resolveAttachments: () => attachments })
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'deepseek-v4.1-flash-free',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'look at the app' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'tool-call', id: CallId('shot-1'), name: 'browser_screenshot', arguments: '{}' },
          ],
          source: { provider: 'fake-route', model: 'deepseek-v4.1-flash-free' },
        }),
        createToolResultMessage({
          callId: CallId('shot-1'),
          content: [
            { type: 'text', text: '{"action":"screenshot"}' },
            { type: 'image', attachment: IMAGE_REF },
          ],
          isError: false,
        }),
      ],
    })) { /* drain */ }

    // 工具结果保留块表：模型的唯一画面来源不能被摊平成文本。
    const context = calls[0]!.context as { messages: { role: string; content: unknown }[] }
    expect(context.messages.at(-1)).toEqual({
      role: 'toolResult',
      toolCallId: 'shot-1',
      toolName: 'browser_screenshot',
      content: [
        { type: 'text', text: '{"action":"screenshot"}' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: 0,
    })
  })

  it('含截图却拿不到附件服务时拒绝请求，而不是静默丢图', async () => {
    const adapter = new LlmOpencode.FreeChannelAdapter({})
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'fake-route',
        model: 'deepseek-v4.1-flash-free',
        messages: [createToolResultMessage({
          callId: CallId('shot-1'),
          content: [{ type: 'image', attachment: IMAGE_REF }],
          isError: false,
        })],
      })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
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
    const adapter = new LlmOpencode.FreeChannelAdapter({})
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

  it('目录未收录的模型被拒绝：没有可用的上游就无法发出请求', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'unlisted-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNKNOWN_MODEL' } },
    })
    expect(calls).toEqual([])
  })
})

describe('OVH anonymous upstream', () => {
  it('OVH 模型不带伪装头与工具门，凭据经空 Authorization 覆盖', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'gpt-oss-120b',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) { /* drain */ }
    const options = calls[0]!.options
    const headers = options.headers as Record<string, string>
    // OVH 匿名层把空 Bearer 读作免费通道；SDK 默认拼接的 Authorization 必须被覆盖。
    expect(headers.Authorization).toBe('Bearer ')
    // 伪装头属于 Zen 的客户端指纹门；对 OVH 发出反而是一次无关的身份声明。
    expect(headers).not.toHaveProperty('user-agent')
    expect(headers).not.toHaveProperty('x-opencode-session')
    expect(options.onPayload).toBeUndefined()
    expect(calls[0]!.model.baseUrl).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1')
    expect(options.apiKey).toBe('')
  })

  it('OVH 模型的推理档位按目录声明转发', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'gpt-oss-120b',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'think' }], source: { kind: 'user' } })],
      reasoningEffort: ReasoningEffortId('low'),
    })) { /* drain */ }
    expect(calls[0]!.options.reasoning).toBe('low')
    expect(calls[0]!.model.thinkingLevelMap).toMatchObject({ low: 'low', high: 'high', medium: 'medium', max: null })
  })

  it('Qwen3.5 声明图片输入：视觉请求会内联图片', async () => {
    const calls: Call[] = []
    const ctx = await harness(textEvents('hi'), calls)
    for await (const _chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'Qwen3.5-397B-A17B',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'look' }], source: { kind: 'user' } })],
    })) { /* drain */ }
    expect(calls[0]!.model.input).toEqual(['text', 'image'])
    expect(calls[0]!.model.baseUrl).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1')
  })
})

describe('Auto failover route', () => {
  /** 空用量：pi-ai 的错误事件也携带完整用量对象。 */
  const zeroUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }

  /** 按候选顺序依次失败的假事件流：错误 finish 携带给定 code。 */
  function errorEvents(code: string): AssistantMessageEvent[] {
    const partial = { content: [], usage: undefined } as never
    return [
      { type: 'start', partial },
      {
        type: 'error',
        error: {
          api: 'openai-completions',
          provider: 'opencode-zen',
          model: 'mimo-v2.6-flash-free',
          content: [],
          usage: zeroUsage,
          stopReason: 'error',
          errorMessage: `upstream failure ${code}`,
          timestamp: 0,
        },
      } as unknown as AssistantMessageEvent,
    ]
  }

  it('候选按序尝试，可转移失败换下一候选，成功候选的分片原样交付', async () => {
    const calls: Call[] = []
    // 首选两个候选都返回可转移错误，第三个候选成功。
    const eventsFor = new Map<string, AssistantMessageEvent[]>([
      ['mimo-v2.6-flash-free', errorEvents('FreeTierError 403')],
      ['deepseek-v4.1-flash-free', errorEvents('RegionError 403')],
    ])
    const provider = {
      ...fakeProvider([], calls),
      streamSimple: (model: Call['model'], _context: unknown, options: Record<string, unknown>) => {
        calls.push({ model, context: _context, options })
        const events = eventsFor.get(model.id) ?? textEvents('hi')
        return (async function* () { for (const event of events) yield event })()
      },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode)
    const adapter = new LlmOpencode.FreeChannelAdapter({ providerOverride: provider as never })
    ctx.effect(() => ctx.llm.registerAdapter(['fake-route'], adapter), 'test: fake route')
    disposers.push(ctx)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'auto',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    // 前两个候选各尝试一次，第三个候选成功收尾。
    expect(calls.map(call => call.model.id)).toEqual([
      'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'gpt-oss-120b',
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('全部候选失败时，最后一个候选的失败原样交付', async () => {
    const calls: Call[] = []
    const events = errorEvents('FreeTierError 403')
    const provider = fakeProvider(events, calls)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode)
    const adapter = new LlmOpencode.FreeChannelAdapter({ providerOverride: provider as never })
    ctx.effect(() => ctx.llm.registerAdapter(['fake-route'], adapter), 'test: fake route')
    disposers.push(ctx)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'auto',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(calls.length).toBe(LlmOpencode.AUTO_MODEL_CANDIDATES.length)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'FREE_TIER_RESTRICTED' } },
    })
  })

  it('不可转移的失败立即停止，不再尝试后续候选', async () => {
    const calls: Call[] = []
    const provider = fakeProvider(errorEvents('bad request 400'), calls)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode)
    const adapter = new LlmOpencode.FreeChannelAdapter({ providerOverride: provider as never })
    ctx.effect(() => ctx.llm.registerAdapter(['fake-route'], adapter), 'test: fake route')
    disposers.push(ctx)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'fake-route',
      model: 'auto',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(calls.length).toBe(1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } },
    })
  })

  it('Auto 在目录里可解析，容量取候选的最紧约束', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode)
    disposers.push(ctx)
    const info = await ctx.llm.resolveModelInfo('free', 'auto')
    expect(info).toMatchObject({ id: 'auto', name: 'Auto' })
    expect(info.context?.contextWindow).toBe(Math.min(...LlmOpencode.AUTO_MODEL_CANDIDATES.map(m => m.contextWindow)))
    const models = await ctx.llm.listModels('free')
    expect(models.map(model => model.id)).toContain('auto')
    await ctx.fiber.dispose()
  })
})

describe('wire helpers stay used', () => {
  it('导出面覆盖指纹与门', () => {
    const ids = deriveRequestIds([{ role: 'user', content: 'x' }])
    expect(disguiseHeaders(ids)['x-opencode-client']).toBe('cli')
    expect(ensureFreeLaneShape({ messages: [], stream: true })).toBeDefined()
  })
})
