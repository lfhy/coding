/**
 * 内置 OpenCode Zen 免费渠道的连接事实与模型目录。
 *
 * 这是本插件唯一的配置解析点：把设置分节（分层后的 `llm-opencode`）解析成
 * 适配器每操作读取一次的不可变快照。字段全部可省略，省略时使用内置默认值，
 * 因此默认安装无需任何 settings 分节即可工作。
 *
 * @module @deepseek-ai/dsh-llm-opencode/config
 */

import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/**
 * 提供商空闲超时默认值：覆盖未完成的流读取，不包含消费方思考时间。
 * 定义在这里而不是适配器里，因为配置 schema 的默认值与适配器都要读它，
 * 而 `config.ts` 是两者之中更底层的模块（无 import 环）。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** 单次请求 base64 图片载荷默认上限。 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** 上游端点；用户可改指自建网关。 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1'

/**
 * 匿名通道的凭据字面量。上游对免费模型只认这一个值，它不是机密，
 * 因此不走凭据存储；用户填自己的 key 时整份凭据被替换。
 */
export const DEFAULT_API_KEY = 'public'

/** 内置渠道的提供方路由。 */
export const PROVIDER_ID = 'opencode-zen'

/** 内置渠道在界面上的显示名称。 */
export const DEFAULT_CHANNEL_NAME = 'OpenCode Zen'

/** 一个内置模型的配置。 */
export interface OpencodeModelConfig {
  /** 线协议上的模型 id。 */
  id: string
  /** 选择器显示名称；省略时用 id。 */
  name?: string
  /** 上下文容量；省略时用路由的 `defaultContextWindow`。 */
  contextWindow?: number
  /** 单次请求输出上限；省略时用提供方自身的值。 */
  maxTokens?: number
  /** 该模型提供的推理档位；省略时按不具备推理能力处理。 */
  reasoningEfforts?: string[]
}

/**
 * 内置默认目录：三个免费模型。菜单里显示的名称是固定的，不随上游元数据漂移。
 */
export const DEFAULT_MODELS: readonly OpencodeModelConfig[] = [
  { id: 'mimo-v2.6-flash-free', name: 'Mimo V2.6 Flash', contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: 'deepseek-v4.1-flash-free', name: 'Deepseek V4.1 Flash', contextWindow: 262_144, maxTokens: 32_768 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', contextWindow: 262_144, maxTokens: 32_768 },
]

/**
 * 插件配置，同时也是 `llm-opencode` settings 分节的结构。
 * 省略字段使用内置默认值，因此默认安装无需任何分节即可工作；
 * 用户改 key、改端点、增删模型都写在这一节里。
 */
export interface Config {
  /** 界面显示名称，默认 `OpenCode Zen`。 */
  channelName?: string
  /** 凭据；省略时为匿名通道的 `public`。填自己的 key 时请求走该凭据。 */
  apiKey?: string
  /** 端点基址，默认官方 Zen；可改为自建网关。 */
  baseURL?: string
  /** 目录；省略时使用内置三个免费模型。 */
  models?: OpencodeModelConfig[]
  /** 模型未给出容量时的回退上下文容量。 */
  defaultContextWindow?: number
  /** 模型未给出输出上限时的回退值。 */
  defaultMaxTokens?: number
  /** 提供商空闲超时，覆盖未完成的流读取。 */
  streamIdleTimeoutMs?: number
  /** 单次请求 base64 图片载荷上限。 */
  maxRequestImageBytes?: number
  /** 提供商自有的重试策略；省略时使用 normal 模式重试五次。 */
  retryPolicy?: RetryPolicyConfig
}

const modelConfig: z<OpencodeModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoningEfforts: z.array(z.string()),
})

/** 运行时 schema；同时是设置分节的校验结构。 */
export const Config: z<Config> = z.object({
  channelName: z.string().min(1).max(64).pattern(/\S/u).default(DEFAULT_CHANNEL_NAME),
  apiKey: z.string().default(DEFAULT_API_KEY),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  models: z.array(modelConfig).default(DEFAULT_MODELS.map(model => ({ ...model }))),
  defaultContextWindow: z.number().step(1).min(1).default(262_144),
  defaultMaxTokens: z.number().step(1).min(1).default(32_768),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(
    2_147_483_647,
  ).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  retryPolicy: RetryPolicySchema,
})

/** 解析后的一条目录条目，容量与显示名都已定型。 */
export interface ResolvedOpencodeModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoningEfforts: readonly string[]
}

/**
 * 一次操作读取的连接事实快照。适配器只在解析点构造它，
 * 因此进行中的请求不会混用另一份设置世代的端点或凭据。
 */
export interface ResolvedOpencodeOptions {
  /** 界面显示名称。 */
  channelName: string
  /** 端点基址；不带尾斜杠。 */
  baseURL: string
  /** 本次请求使用的凭据。 */
  apiKey: string
  /** 已定型的模型目录。 */
  models: readonly ResolvedOpencodeModel[]
  /** 提供商空闲超时。 */
  streamIdleTimeoutMs: number
  /** base64 图片载荷上限。 */
  maxRequestImageBytes: number
  /** 已解析的重试策略。 */
  retryPolicy: ResolvedRetryPolicy
}

/**
 * 解析一份配置为连接事实。URL 与模型 id 在这里校验，
 * 因此写错的分节会在写入处被拒绝，而不是等到请求才失败。
 * @param config - 分层后的设置值。
 * @returns 适配器每操作读取一次的不可变事实。
 * @throws Error 端点或模型列表不可用时，点名出问题的字段。
 */
export function resolveOpencodeOptions(config: Config): ResolvedOpencodeOptions {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (baseURL.length === 0) throw new Error('llm-opencode: baseURL must not be empty')
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`llm-opencode: baseURL "${baseURL}" is not an absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`llm-opencode: baseURL "${baseURL}" must use http or https`)
  }
  const models = config.models ?? [...DEFAULT_MODELS]
  if (models.length === 0) throw new Error('llm-opencode: models must list at least one model')
  const seen = new Set<string>()
  const resolvedModels = models.map((model) => {
    if (model.id.length === 0) throw new Error('llm-opencode: model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-opencode: lists model "${model.id}" more than once`)
    seen.add(model.id)
    return {
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? config.defaultContextWindow ?? 262_144,
      maxTokens: model.maxTokens ?? config.defaultMaxTokens ?? 32_768,
      reasoningEfforts: model.reasoningEfforts ?? [],
    }
  })
  const apiKey = config.apiKey ?? DEFAULT_API_KEY
  if (apiKey.length === 0) throw new Error('llm-opencode: apiKey must not be empty')
  return {
    channelName: config.channelName ?? DEFAULT_CHANNEL_NAME,
    baseURL,
    apiKey,
    models: resolvedModels,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opencode: retryPolicy'),
  }
}
