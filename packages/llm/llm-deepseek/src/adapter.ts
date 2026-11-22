/**
 * DeepSeek 渠道的请求路由。Chat 使用原生编码与 SSE；其余协议复用通用转换。
 * 每次请求使用同一份连接快照和凭据，设置分层与校验由注册插件负责。
 *
 * @module dsh-llm-deepseek/adapter
 */

import { contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from 'coding-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from 'coding-llm'
import type { AttachmentStore } from 'coding-attachment'
import type { CredentialRef } from 'coding-credentials'
import { streamChannelRequest } from 'coding-llm-pi-ai'
import type { ConfiguredProtocol } from 'coding-llm-pi-ai'
import type { AnonymousUserId } from 'coding-anonymous-user-id'
import { fetchForOutbound } from './outbound.ts'
import type { DeepSeekOutbound, DeepSeekOutboundConfig } from './outbound.ts'
import { streamCompatibleRequest } from './protocol.ts'
import type { DeepSeekRequestOptions } from './protocol.ts'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** 渠道目录中的可选模型条目。 */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** 只覆盖当前模型的上游协议；省略时继承渠道。 */
  api?: ConfiguredProtocol
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** 可接收的输入模态；省略时仅支持文本。 */
  inputModalities?: ModelModality[]
  /** 该模型允许的推理档位；省略时使用渠道级能力。 */
  reasoningEfforts?: Array<'off' | 'low' | 'high' | 'max'>
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** 上游端点的基址；请求路径由有效协议决定。 */
  baseURL: string
  /** 渠道协议；模型显式配置时优先。 */
  api: ConfiguredProtocol
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated base64 image payload in one request. */
  maxRequestImageBytes: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
  /**
   * 本渠道模型请求的 User-Agent，本代解析已完成：配置了渠道值就用它，否则填入
   * 产品默认值。对话请求与模型发现请求都从这里取值，因此两者永远一致。
   */
  userAgent: string
  /** 渠道级出站选择（直连／内置代理池／自定义代理），与端点同代解析。 */
  outbound: DeepSeekOutboundConfig
}

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
  /** 当前渠道显示名称；独立于请求连接配置，在注册路由时读取。 */
  providerName?: () => string
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * 把渠道级出站选择解析成一次请求的传输。缺省按直连；插件在场时向代理池取
   * 地址，池规则为直连则同样返回直连。每次请求调用一次，选择变化无需重注册。
   */
  resolveOutbound?: (selection: DeepSeekOutboundConfig) => DeepSeekOutbound
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** 未声明容量的模型沿用的回退上下文容量（256K），与自定义渠道的缺省一致。 */
export const DEFAULT_CONTEXT_WINDOW = 262_144
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
/** Default bound on accumulated base64 image payload per request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: LOW_REASONING_EFFORT, name: 'Low' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const
const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

function modelReasoningEfforts(model: DeepSeekCatalogModel | undefined, connection: DeepSeekConnectionOptions) {
  // 档位属于模型；切换请求格式只改变上游编码，不改变可选档位。
  const available = connection.defaults.thinking === 'disabled' ? OFF_ONLY_REASONING_EFFORTS : REASONING_EFFORTS
  return model?.reasoningEfforts === undefined
    ? available
    : available.filter(effort => model.reasoningEfforts?.some(id => id === effort.id))
}

function modelInfo(provider: string, model: DeepSeekCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class DeepSeekAdapter extends LlmAdapter {
  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.providerName?.() ?? 'DeepSeek' }
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
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const efforts = modelReasoningEfforts(configured, connection)
    const requestedDefault = connection.defaults.thinking === 'disabled'
      ? OFF_REASONING_EFFORT
      : connection.defaults.reasoningEffort === undefined
        ? efforts.at(-1)?.id
        : ReasoningEffortId(connection.defaults.reasoningEffort)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // 未列出的模型按纯文本处理，避免把未经验证的视觉输入持久写入会话。
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts,
        defaultEffort: efforts.find(effort => effort.id === requestedDefault)?.id ?? efforts.at(0)?.id ?? OFF_REASONING_EFFORT,
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 每次流调用只解析一次连接和凭据；进行中的请求不混用其他设置世代的端点、
    // 密钥或 User-Agent。
    const connection = this.config.options()
    const model = connection.models.find(entry => entry.id === options.model)
    const api = model?.api ?? connection.api
    const availableEfforts = modelReasoningEfforts(model, connection)
    const defaultEffort = (connection.defaults.reasoningEffort === undefined
      ? availableEfforts.at(-1)
      : availableEfforts.find(entry => entry.id === connection.defaults.reasoningEffort))
      ?? availableEfforts.at(0) ?? REASONING_EFFORTS[0]
    const effectiveDefault = defaultEffort.id as NonNullable<RequestDefaults['reasoningEffort']>
    const effort = options.purpose === 'session-title' ? 'off' : options.reasoningEffort ?? effectiveDefault
    if (options.purpose !== 'session-title' && (api !== 'openai-completions' || model?.reasoningEfforts !== undefined)) {
      if (!availableEfforts.some(entry => entry.id === effort)) {
        throw new LlmError(`Model "${options.model}" does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
      }
    }
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `Model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'Image conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const headers = {
      'user-agent': connection.userAgent,
      'x-deepseek-harness-user-id': String(this.config.resolveUserId()),
      ...options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {},
      ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
    }
    const requestFetch = fetchForOutbound(this.config.resolveOutbound?.(connection.outbound) ?? { kind: 'direct' })
    try {
      yield* streamChannelRequest({
        signal: options.signal,
        idleTimeoutMs: connection.streamIdleTimeoutMs,
        open: (signal, heartbeat) => {
          const requestOptions = { apiKey, headers, signal, fetch: requestFetch }
          return api === 'openai-completions'
            ? this.requestChat(
              options, connection,
              model?.reasoningEfforts === undefined ? connection.defaults : { ...connection.defaults, reasoningEffort: effectiveDefault },
              requestOptions, attachments, heartbeat,
            )
            : streamCompatibleRequest(options, { api, connection, model, efforts: availableEfforts, effort, requestOptions, attachments })
        },
      })
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
  }

  private async * requestChat(
    options: GenerateOptions,
    connection: DeepSeekConnectionOptions,
    defaults: RequestDefaults,
    request: DeepSeekRequestOptions,
    attachments: AttachmentStore | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = attachments === undefined
      ? serializeRequest(options, defaults)
      : await serializeRequestWithImages(options, {
        attachments,
        maxRequestImageBytes: connection.maxRequestImageBytes,
        signal: request.signal,
      }, defaults)
    // 编码失败不是传输失败；这里只归类真正发出的 HTTP 请求。
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${request.apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...request.headers,
    }

    let response: Response
    try {
      response = await request.fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal: request.signal,
      })
    } catch (error: unknown) {
      // 调用方取消与空闲超时由外层区分。保留 fetch 的 cause 供错误诊断。
      if (request.signal.aborted) throw error
      throw new LlmError(
        `API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}
