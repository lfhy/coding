/** DeepSeek 渠道对非 Chat 协议的适配；不改变渠道路由或凭据策略。 */

import { LlmError } from 'coding-llm'
import type { GenerateOptions, ReasoningEffortId, StreamChunk } from 'coding-llm'
import type { AttachmentStore } from 'coding-attachment'
import { configuredProtocolStreams, streamPiAiRequest } from 'coding-llm-pi-ai'
import type { ConfiguredProtocol, PiAiStreamRequest } from 'coding-llm-pi-ai'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './adapter.ts'

/** 同一连接快照解析出的凭据、标头、取消信号与请求级出站。 */
export interface DeepSeekRequestOptions {
  apiKey: string
  headers: Record<string, string>
  signal: AbortSignal
  fetch: typeof fetch
}

type CompatibleProtocol = Exclude<ConfiguredProtocol, 'openai-completions'>

interface CompatibleRequest {
  api: CompatibleProtocol
  connection: DeepSeekConnectionOptions
  model: DeepSeekCatalogModel | undefined
  efforts: ReadonlyArray<{ id: ReasoningEffortId }>
  effort: ReasoningEffortId | 'off' | 'low' | 'high' | 'max'
  requestOptions: DeepSeekRequestOptions
  attachments: AttachmentStore | undefined
}

const streams = {
  'openai-responses': configuredProtocolStreams('openai-responses'),
  'anthropic-messages': configuredProtocolStreams('anthropic-messages'),
} satisfies Record<CompatibleProtocol, unknown>

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 使用通用协议编码历史和转换响应，同时保留 DeepSeek 渠道的请求边界。
 * @param options - 生成请求；`stop` 仅由原生 Chat 支持。
 * @param request - 请求已捕获的协议、连接和模型能力。
 * @returns 选定协议的 Harness 流。
 */
export function streamCompatibleRequest(options: GenerateOptions, request: CompatibleRequest): AsyncIterable<StreamChunk> {
  const { api, connection, model, efforts, effort, requestOptions, attachments } = request
  if (options.stop !== undefined) {
    throw new LlmError(`${api} does not support GenerateOptions.stop on this channel`, 'UNSUPPORTED_OPTION')
  }
  const supports = (id: string): boolean => efforts.some(level => level.id === id)
  const upstream: PiAiStreamRequest['model'] = {
    id: options.model,
    name: model?.name ?? options.model,
    provider: options.provider,
    api,
    baseUrl: connection.baseURL,
    input: [...model?.inputModalities ?? ['text']],
    cost: NO_COST,
    contextWindow: model?.contextWindow ?? connection.defaultContextWindow,
    maxTokens: model?.maxTokens ?? connection.maxTokens,
    reasoning: efforts.some(level => level.id !== 'off'),
    thinkingLevelMap: {
      minimal: null,
      low: supports('low') ? 'low' : null,
      medium: null,
      high: supports('high') ? 'high' : null,
      xhigh: null,
      max: supports('max') ? 'max' : null,
    },
  }
  // 调用面的品牌类型已经过渠道档位校验；再把允许的三种值交给 SDK。
  const reasoning = effort === 'low' ? 'low' : effort === 'high' ? 'high' : effort === 'max' ? 'max' : undefined
  return streamPiAiRequest(options, {
    model: upstream,
    stream: (model, context, options) => streams[api].streamSimple(model, context, options),
    streamOptions: {
      ...requestOptions,
      // 标准 fetch 不会在跨域重定向时清除 Anthropic 的 x-api-key。
      fetch: (input, init) => requestOptions.fetch(input, { ...init, redirect: 'error' }),
      ...reasoning === undefined ? {} : { reasoning },
      // 统一由 Harness 管理重试，SDK 不另外重发。
      maxRetries: 0,
    },
    maxRequestImageBytes: connection.maxRequestImageBytes,
    ...attachments === undefined ? {} : { resolveAttachments: () => attachments },
  })
}
