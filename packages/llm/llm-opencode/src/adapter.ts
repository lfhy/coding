/**
 * `FreeChannelAdapter`：Free 渠道的 LlmAdapter 实现。
 *
 * 线协议层复用 `@earendil-works/pi-ai` 的 `openai-completions`（与通用
 * llm-pi-ai 适配器同一实现），本模块只补三件它不提供的东西：
 * 1. 上游要求的客户端指纹头与按会话派生的关联 id（{@link disguiseHeaders}）；
 * 2. 免费通道的工具形状门（{@link ensureFreeLaneShape}，经 pi-ai `onPayload`）；
 * 3. 匿名凭据：上游对免费模型只认固定字面量，无需凭据存储。
 *
 * 连接事实按模型取自 {@link FREE_CHANNEL_MODELS}：同一个渠道下的模型可以来自
 * 不同上游，端点与凭据因此是每条请求按模型解析的，而不是整条路由共用一个。
 *
 * @module coding-llm-opencode/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from 'coding-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from 'coding-llm'
import type { AttachmentStore, ImageAttachmentRef } from 'coding-attachment'
import { idleWatchdog, timeoutOf } from 'coding-timeout'
import type {
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent as PiThinkingContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
} from '@earendil-works/pi-ai'
import type { FreeChannelModel, ReasoningEffortLevel } from './channel.ts'
import {
  AUTO_MODEL_CANDIDATES,
  AUTO_MODEL_ID,
  AUTO_MODEL_NAME,
  CHANNEL_NAME,
  CHANNEL_RETRY_POLICY,
  freeChannelModel,
  FREE_CHANNEL_MODELS,
  PROVIDER_ID,
  REASONING_EFFORT_LEVELS,
  STREAM_IDLE_TIMEOUT_MS,
} from './channel.ts'
import { deriveRequestIds, disguiseHeaders } from './ids.ts'
import { ensureFreeLaneShape } from './free-lane.ts'
import { applyOutbound } from './outbound.ts'
import { isFailoverCode, isFailoverError, toStreamChunks } from './stream.ts'

/** 空闲超时使用的稳定错误码。 */
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** 一次请求的出站路径：直连、代理池（本地入站）或自定义代理地址。 */
export type OutboundMode =
  | { kind: 'direct' }
  | { kind: 'pool'; url: string }
  | { kind: 'custom'; url: string }

/** 适配器构造参数。 */
export interface FreeChannelAdapterOptions {
  /** 解析当前持久化附件服务；缺席时拒绝图片输入。 */
  resolveAttachments?: () => AttachmentStore | undefined
  /** 解析本次请求的出站模式；缺席时直连。抛出的错误按适配器错误交付。 */
  resolveOutbound?: () => OutboundMode
  /** 可注入的 pi-ai 提供商，供测试替换线协议层。 */
  providerOverride?: Provider
}

/** 把一条目录条目投影成 seam 的模型信息。 */
function modelInfo(provider: string, model: FreeChannelModel): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: [...model.inputModalities] }
}

/**
 * Auto 的模型信息投影：模态与容量取候选表的并集/最小值，让带图片的请求
 * 不会被选择器提前拒绝；真正路由到的候选仍按各自的目录事实约束。
 */
function autoModelInfo(provider: string): LlmModelInfo {
  const modalities = new Set(FREE_CHANNEL_MODELS.flatMap(model => model.inputModalities))
  return { provider, id: AUTO_MODEL_ID, name: AUTO_MODEL_NAME, inputModalities: [...modalities] }
}

/**
 * 声明的档位映射成 pi-ai 的 `thinkingLevelMap`：声明过的档位带上要发出的拼写，
 * 未声明的档位钉成 `null`（不支持），因此选择器给出的档位与真正能转发的
 * `reasoning_effort` 一一对应。`off` 不在任何模型的声明表里（它表达「不点名
 * 档位」）；声明了 `none` 的模型例外——pi-ai 词汇里没有 `none`，`off`／`none`
 * 都折算成线上的关闭值，`off` 因此映射为 `'none'`。
 * @param efforts - 该模型声明的档位。
 * @returns pi-ai 读档位的映射。
 */
function thinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const level of REASONING_EFFORT_LEVELS) {
    // `off` 是「不点名档位」，不在任何模型的声明表里：模型声明了 `none` 时它
    // 折算成显式关闭值，其余模型钉成 null（省略参数）。
    if (level === 'off') {
      if (efforts.includes('none')) map.off = 'none'
      else map.off = null
      continue
    }
    // `none` 不在 pi-ai 的思考档位词汇里（ModelThinkingLevel 没有它），因此
    // 无法作为键映射：它只经上面的 off 分支生效，这里不再占位。
    if (level === 'none') continue
    if (!efforts.includes(level)) map[level] = null
    else map[level] = level
  }
  return map
}

/** 自由文本内容：把 harness 文本块摊平，图片另行处理。 */
function flattenText(content: readonly ContentBlock[]): string {
  return content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** 递归摊平一条工具结果里的文本；嵌套的结果块同样计入。 */
function toolResultText(content: readonly ContentBlock[]): string {
  return content.map(block => (block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '')).join('')
}

/** 把 harness 工具 schema 投影成 pi-ai 的工具表。 */
function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined
  return options.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** 一条 assistant 历史的 pi-ai 投影；工具名同时记入调用表供结果消息回填。 */
function toPiAssistant(
  message: Message,
  model: string,
  toolNames: Map<string, string>,
): PiMessage {
  const content: (PiTextContent | PiThinkingContent | PiToolCall)[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text.length > 0) content.push({ type: 'text', text: block.text })
    if (block.type === 'reasoning' && block.text.length > 0) {
      content.push({ type: 'thinking', thinking: block.text })
    }
    if (block.type === 'tool-call') {
      toolNames.set(block.id, block.name)
      content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** user 消息可内联的部分：文本原样，图片读成内联载荷。 */
async function userParts(
  content: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
): Promise<(PiTextContent | PiImageContent)[]> {
  const parts: (PiTextContent | PiImageContent)[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
    if (block.type === 'image' && attachments !== undefined) {
      parts.push(await imagePart(block.attachment, attachments))
    }
  }
  return parts
}

/** 把一组内容块折成 pi-ai 接受的用户内容：纯文本用字符串形式，含图片则保留块表。 */
function userContent(parts: readonly (PiTextContent | PiImageContent)[]): string | (PiTextContent | PiImageContent)[] {
  const texts: string[] = []
  let onlyText = true
  for (const part of parts) {
    if (part.type !== 'text') onlyText = false
    else texts.push(part.text)
  }
  return onlyText ? texts.join('') : [...parts]
}

/** 解析工具调用参数；上游要求它始终是一个 JSON 对象。 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return {}
  }
}

/** 读取一个持久化图片为 pi-ai 的内联图片块；任何失败都降级为文本占位。 */
async function imagePart(
  reference: ImageAttachmentRef,
  attachments: AttachmentStore,
): Promise<PiTextContent | PiImageContent> {
  try {
    const stored = await attachments.readImage(reference)
    return {
      type: 'image',
      data: Buffer.from(stored.data).toString('base64'),
      mimeType: stored.ref.mediaType,
    }
  } catch {
    return { type: 'text', text: '[image omitted: attachment is no longer readable]' }
  }
}

/**
 * 把 harness 历史投影成 pi-ai 上下文。图片只有在附件服务可用时才内联，
 * 否则以文本占位替代——一个缺失的对象不能让整轮请求失败。
 */
async function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
): Promise<PiContext> {
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      messages.push(toPiAssistant(message, options.model, toolNames))
      continue
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
      continue
    }
    // user 角色：普通块合成一条消息，工具结果各自成为一条 toolResult。
    const parts = await userParts(message.content, attachments)
    const results = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    if (parts.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: userContent(parts), timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const tools = toolsOf(options)
  return {
    ...options.system === undefined ? {} : { systemPrompt: options.system },
    messages,
    ...tools === undefined ? {} : { tools },
  }
}

/**
 * Free 渠道适配器。一个实例服务其路由下的全部模型；模型目录是包内事实，
 * 每个模型带着自己的上游，因此一次请求的端点与凭据在开始时按模型解析一次，
 * 进行中的请求不会被另一次解析改变。
 */
export class FreeChannelAdapter extends LlmAdapter {
  constructor(private readonly config: FreeChannelAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CHANNEL_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return CHANNEL_RETRY_POLICY
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = FREE_CHANNEL_MODELS.map(model => modelInfo(provider, model))
    return Promise.resolve([autoModelInfo(provider), ...catalog])
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (model === AUTO_MODEL_ID) {
      // Auto 是虚拟条目：容量取候选里最紧的约束，避免把某个候选放不下的
      // 历史当成一定能发；档位不透出，路由到的候选各自按目录事实校验。
      const contextWindow = Math.min(...AUTO_MODEL_CANDIDATES.map(entry => entry.contextWindow))
      const maxTokens = Math.min(...AUTO_MODEL_CANDIDATES.map(entry => entry.maxTokens))
      return Promise.resolve({
        ...autoModelInfo(provider),
        context: { contextWindow },
        defaultMaxTokens: maxTokens,
      })
    }
    const served = freeChannelModel(model)
    // 未列出的模型按纯文本、无推理档位处理：不把未经验证的能力持久写进会话。
    // `off` 表达「不点名档位」，对有档位的模型始终可选；`none` 与它语义相同
    // （关闭推理，只是线上拼写不同），选择器上只保留 off 一项，避免两个
    // 同名的关闭档位。
    const declaredEfforts = served?.reasoningEfforts ?? []
    const selectorEfforts: ReasoningEffortLevel[] = declaredEfforts.length > 0 ? ['off'] : []
    for (const level of declaredEfforts) {
      if (level !== 'none' && level !== 'off') selectorEfforts.push(level)
    }
    const efforts = selectorEfforts.map(effort => ({
      id: ReasoningEffortId(effort),
      name: effort === 'off' ? 'Off' : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
    }))
    return Promise.resolve({
      ...served === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, served),
      context: { contextWindow: served?.contextWindow ?? 262_144 },
      ...served === undefined ? {} : { defaultMaxTokens: served.maxTokens },
      ...efforts.length === 0 ? {} : { reasoning: { efforts } },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === AUTO_MODEL_ID) {
      // Auto 不指向任何上游：按候选表逐个尝试，直到一个候选真正产出内容分片。
      // 已经产出分片的候选不再转移——中途换模型会把半截回复拼成两种风格。
      let opened = false
      let lastFailure: LlmError | undefined
      for (const candidate of AUTO_MODEL_CANDIDATES) {
        // transferred 为 true 表示本候选以可转移错误收场、需要试下一个；
        // 其余路径（成功 finish、不可转移错误、抛出）都到此为止。
        let transferred = false
        try {
          for await (const chunk of this.streamModel({ ...options, model: candidate.id }, candidate)) {
            if (chunk.type === 'finish') {
              // 候选的失败以错误 finish 分片到达而不是抛出：可转移的码换下一个
              // 候选，其余（含成功 finish）原样交付并结束。
              const reason = chunk.reason
              if (reason.kind === 'error' && !opened && isFailoverCode(reason.failure.code)) {
                lastFailure = new LlmError(reason.failure.message, reason.failure.code)
                transferred = true
                break
              }
              yield chunk
              return
            }
            if (chunk.type !== 'usage') opened = true
            yield chunk
          }
          if (!transferred) return
          continue
        } catch (error: unknown) {
          if (error instanceof LlmError) lastFailure = error
          if (opened || !isFailoverError(error)) throw error
        }
      }
      // 最后一个候选的失败原样上抛：它就是本次请求的最终诊断。
      if (lastFailure !== undefined) throw lastFailure
      throw new LlmError('the Free channel has no Auto candidate', 'UNKNOWN_MODEL')
    }
    const served = freeChannelModel(options.model)
    // 目录是渠道服务的唯一来源：没收录的 id 没有可用的端点与凭据，不能猜一个上游发出去。
    if (served === undefined) {
      throw new LlmError(
        `the Free channel serves no model "${options.model}"`,
        'UNKNOWN_MODEL',
      )
    }
    yield* this.streamModel(options, served)
  }

  /**
   * 向一条具体目录条目发起流式请求。Auto 与直选模型最终都走到这里；
   * 端点、凭据与请求形状全部按该条目所属上游决定。
   */
  private async * streamModel(options: GenerateOptions, served: FreeChannelModel): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('the Free channel does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // 出站路径按请求解析一次：代理池/自定义代理经 undici 全局 dispatcher 的
    // 请求级替换生效（见 outbound.ts），请求结束后恢复原 dispatcher。
    const outbound = this.config.resolveOutbound?.() ?? { kind: 'direct' } satisfies OutboundMode
    const restore = applyOutbound(outbound)
    const model = this.piModel(served)
    const effort = options.reasoningEffort
    // `off` 是全局词汇而不是某个模型的声明档位：任何模型选它都表示「不点名」，
    // 由下方 explicitNone 分支决定发什么，不进未声明拒绝。
    if (effort !== undefined && effort !== 'off' && !served.reasoningEfforts.includes(effort as ReasoningEffortLevel)) {
      restore()
      throw new LlmError(
        `Free channel model "${options.model}" does not support reasoning effort "${effort}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    // `off` 与“未选择档位”默认都表示不点名档位：pi-ai 直接省略 `reasoning_effort`，
    // 模型按自身默认行为推理。声明了 `none` 的模型（Qwen3.5）例外：上游把省略
    // 读作默认深推理，因此此时 `off`/`none` 都显式发 `reasoning_effort: "none"`。
    const explicitNone = served.reasoningEfforts.includes('none')
    const reasoning = effort === undefined || effort === 'off' || effort === 'none'
      ? explicitNone ? 'none' as ThinkingLevel : undefined
      : effort as ThinkingLevel
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
    const ids = deriveRequestIds(options.messages)
    let context: PiContext
    try {
      context = await toPiContext(options, attachments)
    } catch (error) {
      restore()
      throw error
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE)

    try {
      // 上游差异只落在请求形状上：Zen 要 CLI 伪装头与工具门，OVH 要空 Bearer。
      // 两者的注释都描述上游事实，改写逻辑分别在 ids.ts 与 free-lane.ts。
      const shape = served.upstream.disguise
        ? {
          // 上游只接受 OpenCode CLI 形态的 User-Agent：harness 归因 UA 会 403，
          // 因此本路由的指纹头是最终值，不再叠加共享的模型请求 UA。
          headers: disguiseHeaders(ids),
          // 上游免费通道只在请求体带上 agent 形状的工具表时才放行；
          // pi-ai 没有对应选项，因此改写在序列化后的请求体上进行。
          onPayload: (payload: unknown) => ensureFreeLaneShape(payload),
        }
        : {
          // OVH 的匿名层把空 Bearer 读作免费通道；OpenAI SDK 要求非空 key，
          // 因此经 headers 显式携带空 Authorization 覆盖 SDK 的默认拼接。
          headers: { Authorization: 'Bearer ' },
        }
      const events = this.provider(served).streamSimple(model, context, {
        apiKey: served.upstream.apiKey,
        ...shape,
        maxRetries: 0,
        ...reasoning === undefined ? {} : { reasoning },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        signal: watchdog.signal,
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE)
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('free channel stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedUpstreamTeardown) {
            // 稳定信号已经负责终止上游；返回时的 abort 不改变结果。
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Free channel stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Free channel request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      restore()
      consumer.abort('free channel stream consumer stopped')
    }
  }

  /** 本次请求所属上游的 pi-ai 提供商；端点与凭据都从那条上游记录读取。 */
  private provider(served: FreeChannelModel): Provider {
    if (this.config.providerOverride !== undefined) return this.config.providerOverride
    return createProvider({
      id: PROVIDER_ID,
      name: CHANNEL_NAME,
      baseUrl: served.upstream.baseURL,
      auth: {
        apiKey: {
          name: CHANNEL_NAME,
          resolve: () => Promise.resolve({ auth: { apiKey: served.upstream.apiKey } }),
        },
      },
      models: [],
      api: openAICompletionsApi(),
    })
  }

  /** 本次请求的模型描述符；容量、显示名与端点都取自该模型所属的上游记录。 */
  private piModel(served: FreeChannelModel): Model<Api> {
    return {
      id: served.id,
      name: served.name,
      api: 'openai-completions',
      provider: PROVIDER_ID,
      baseUrl: served.upstream.baseURL,
      // 能力声明决定 pi-ai 的请求形状：模态决定图片是否内联，档位映射决定
      // `reasoning_effort` 能否发出。恒推理但没有档位的模型仍然声明 reasoning，
      // 这样它的推理增量不会被当成普通文本丢弃。
      reasoning: served.reasoning,
      ...served.reasoningEfforts.length === 0
        ? {}
        : { thinkingLevelMap: thinkingLevelMap(served.reasoningEfforts) },
      input: [...served.inputModalities],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: served.contextWindow,
      maxTokens: served.maxTokens,
    }
  }
}
