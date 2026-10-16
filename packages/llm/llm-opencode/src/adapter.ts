/**
 * `OpencodeZenAdapter`：面向 OpenCode Zen 免费通道的 LlmAdapter 实现。
 *
 * 线协议层复用 `@earendil-works/pi-ai` 的 `openai-completions`（与通用
 * llm-pi-ai 适配器同一实现），本模块只补三件它不提供的东西：
 * 1. 上游要求的客户端指纹头与按会话派生的关联 id（{@link disguiseHeaders}）；
 * 2. 免费通道的工具形状门（{@link ensureFreeLaneShape}，经 pi-ai `onPayload`）；
 * 3. 匿名凭据：上游对免费模型只认字面量 `public`，无需凭据存储。
 *
 * @module @deepseek-ai/dsh-llm-opencode/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  Context as PiContext,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent as PiThinkingContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
} from '@earendil-works/pi-ai'
import type { ResolvedOpencodeOptions, ResolvedOpencodeModel } from './config.ts'
import { DEFAULT_MODEL_MODALITIES, PROVIDER_ID, REASONING_EFFORT_LEVELS } from './config.ts'
import { deriveRequestIds, disguiseHeaders } from './ids.ts'
import { ensureFreeLaneShape } from './free-lane.ts'
import { toStreamChunks } from './stream.ts'

/** 空闲超时使用的稳定错误码。 */
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * 本适配器的重试策略：免费通道按出口 IP 限流，突发 429 会超出宿主默认的
 * 五次重试窗口，因此把静默吸收窗口拉长到每步最坏约 90 秒。可重试码沿用宿主
 * 默认集合，确定性的 `FREE_TIER_RESTRICTED`、`REGION_BLOCKED` 不参与重试。
 */
export const FREE_LANE_RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 8,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 1_000,
  maxDelayMs: 20_000,
  jitterRatio: 0.2,
})

/** 适配器构造参数：插件拥有的按操作解析钩子。 */
export interface OpencodeZenAdapterOptions {
  /** 当前连接事实；每次操作读取一次。 */
  options: () => ResolvedOpencodeOptions
  /** 当前共享 User-Agent 之外的兜底值，仅在未挂载 llm 服务时使用。 */
  resolveUserAgent?: () => string
  /** 解析当前持久化附件服务；缺席时拒绝图片输入。 */
  resolveAttachments?: () => AttachmentStore | undefined
  /** 可注入的 pi-ai 提供商，供测试替换线协议层。 */
  providerOverride?: Provider
}

/** 合并部署标头与 Harness 应用归因，归因名冲突时以 Harness 为准。 */
function requestHeaders(
  headers: Readonly<Record<string, string>>,
  requestUserAgent: string,
): Record<string, string> {
  const reserved = new Set(['user-agent'])
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => !reserved.has(name.toLowerCase()))),
    'user-agent': requestUserAgent,
  }
}

/** 把一条已解析的目录条目投影成 seam 的模型信息。 */
function modelInfo(provider: string, model: ResolvedOpencodeModel): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: [...model.inputModalities] }
}

/**
 * 声明的档位映射成 pi-ai 的 `thinkingLevelMap`：声明过的档位带上自身拼写，
 * 未声明的档位钉成 `null`（不支持），因此选择器给出的档位与真正能转发的
 * `reasoning_effort` 一一对应。`off` 是唯一不进映射的档位——它的语义是省略参数，
 * 由 pi-ai 按“支持但不发值”处理。
 * @param efforts - 该模型声明的档位。
 * @returns pi-ai 读档位的映射。
 */
function thinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
  return Object.fromEntries(REASONING_EFFORT_LEVELS.map(level => [
    level,
    efforts.includes(level) ? (level === 'off' ? undefined : level) : null,
  ]).filter(([, wire]) => wire !== undefined))
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
 * 免费通道适配器。一个实例服务其路由下的全部模型；连接事实、凭据与目录
 * 都在每次操作开始时读取一次，因此设置变更在下一次请求生效，进行中的请求
 * 仍用开始时的那一份。
 */
export class OpencodeZenAdapter extends LlmAdapter {
  constructor(private readonly config: OpencodeZenAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.options().channelName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const options = this.config.options()
    const configured = options.models.find(entry => entry.id === model)
    // 未列出的模型按纯文本、无推理档位处理：不把未经验证的能力持久写进会话。
    const efforts = (configured?.reasoningEfforts ?? []).map(effort => ({
      id: ReasoningEffortId(effort),
      name: `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`,
    }))
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? 262_144 },
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
      ...efforts.length === 0 ? {} : { reasoning: { efforts } },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-opencode does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // 一次流调用只读取一次连接事实与凭据，进行中的请求不混用其他设置世代。
    const connection = this.config.options()
    const model = this.piModel(connection, options.model)
    const effort = options.reasoningEffort
    if (effort !== undefined) {
      const declared = connection.models.find(entry => entry.id === options.model)?.reasoningEfforts ?? []
      if (!declared.includes(String(effort))) {
        throw new LlmError(
          `OpenCode Zen model "${options.model}" does not support reasoning effort "${effort}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    }
    // `off` 与“未选择档位”都表示不点名档位：pi-ai 会直接省略 `reasoning_effort`，
    // 让模型按自身默认行为推理。
    const reasoning = effort === undefined || effort === 'off' ? undefined : effort as ThinkingLevel
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
    const ids = deriveRequestIds(options.messages)
    const context = await toPiContext(options, attachments)
    const requestUserAgent = this.config.resolveUserAgent?.() ?? userAgent()

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)

    try {
      const events = this.provider(connection).streamSimple(model, context, {
        apiKey: connection.apiKey,
        headers: requestHeaders(disguiseHeaders(ids), requestUserAgent),
        // 上游免费通道只在请求体带上 agent 形状的工具表时才放行；
        // pi-ai 没有对应选项，因此改写在序列化后的请求体上进行。
        onPayload: (payload: unknown) => ensureFreeLaneShape(payload),
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
          consumer.abort('llm-opencode stream consumer stopped')
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
          `OpenCode Zen stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('OpenCode Zen request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('llm-opencode stream consumer stopped')
    }
  }

  /** 该路由的 pi-ai 提供商；端点来自当前连接事实，因此改端点即刻生效。 */
  private provider(connection: ResolvedOpencodeOptions): Provider {
    if (this.config.providerOverride !== undefined) return this.config.providerOverride
    return createProvider({
      id: PROVIDER_ID,
      name: connection.channelName,
      baseUrl: connection.baseURL,
      auth: {
        apiKey: {
          name: 'OpenCode Zen',
          resolve: () => Promise.resolve({ auth: { apiKey: connection.apiKey } }),
        },
      },
      models: [],
      api: openAICompletionsApi(),
    })
  }

  /** 本次请求的模型描述符；容量与显示名都取自当前目录。 */
  private piModel(connection: ResolvedOpencodeOptions, id: string): Model<Api> {
    const configured = connection.models.find(entry => entry.id === id)
    return {
      id,
      name: configured?.name ?? id,
      api: 'openai-completions',
      provider: PROVIDER_ID,
      baseUrl: connection.baseURL,
      // 能力声明决定 pi-ai 的请求形状：模态决定图片是否内联，档位映射决定
      // `reasoning_effort` 能否发出。恒推理但没有档位的模型仍然声明 reasoning，
      // 这样它的推理增量不会被当成普通文本丢弃。
      reasoning: configured?.reasoning ?? false,
      ...configured === undefined || configured.reasoningEfforts.length === 0
        ? {}
        : { thinkingLevelMap: thinkingLevelMap(configured.reasoningEfforts) },
      input: [...(configured?.inputModalities ?? DEFAULT_MODEL_MODALITIES)],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: configured?.contextWindow ?? 262_144,
      maxTokens: configured?.maxTokens ?? 32_768,
    }
  }
}
