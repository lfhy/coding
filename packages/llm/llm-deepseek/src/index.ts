/**
 * Register a {@link DeepSeekAdapter} for the `deepseek-official` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-deepseek` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * base URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 * @module coding-llm-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from 'coding-llm'
import type { LlmModelDiscoveryRequest, ModelModality, RetryPolicyConfig } from 'coding-llm'
import { credentialRef } from 'coding-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from 'coding-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from 'coding-settings'
import { MAX_TIMER_DELAY_MS } from 'coding-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from 'coding-anonymous-user-id'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
} from './adapter.ts'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './adapter.ts'
import { discoverModels } from './discovery.ts'
import type {} from 'coding-proxy-pool'
import type { DeepSeekOutbound, DeepSeekOutboundConfig } from './outbound.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
} from './adapter.ts'
export type { DeepSeekAdapterOptions, DeepSeekCatalogModel, DeepSeekConnectionOptions } from './adapter.ts'
export type { RequestDefaults } from './serialize.ts'
export type { DeepSeekOutbound, DeepSeekOutboundConfig } from './outbound.ts'
export type * from './types.ts'

export const name = 'llm-deepseek'
export const inject = ['llm']

const NS = settingsNamespace('llm-deepseek')
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_CHANNEL_NAME = 'DeepSeek'
/** 本插件拥有的唯一提供方路由。 */
const PROVIDER = 'deepseek-official'

const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]
const MODEL_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

/**
 * 插件配置也作为 `llm-deepseek` settings 分节的结构，所有字段在 yml 中均可省略。
 * 缺少密钥时，每次请求会通过 {@link Config.apiKeyEnv} 查找，仍未找到才以
 * `MISSING_CREDENTIAL` 失败；省略 thinking 使用提供方默认值，省略推理强度
 * 则采用所选模型支持的最高档位。渠道目录使用有效设置中的名称，不改变提供方路由。
 */
export interface Config {
  /** 单一渠道的显示名称，默认 `DeepSeek`，最多 64 个字符；不用于路由、凭据引用或模型请求。 */
  channelName?: string
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** 默认思考档位；省略时使用所选模型支持的最高档位；`off` 关闭思考。 */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to V4 Flash and V4 Pro. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated base64 image payload per request (default 20 MiB). */
  maxRequestImageBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
  /**
   * 渠道级出站：直连（缺省）、内置代理池或自定义代理。选择只影响传输；选择内置
   * 代理池时使用池自己的出站控制（直连/本地池/自定义代理）。
   */
  outbound?: DeepSeekOutboundConfig
}

/** 渠道级出站的 schema：自定义模式必须带 http(s) 地址。 */
const outboundSchema: z<DeepSeekOutboundConfig> = z.object({
  mode: z.union([z.const('direct'), z.const('pool'), z.const('custom')]).default('direct'),
  customUrl: z.string(),
})

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  // 联合避免 Schemastery 把缺失的数组字段物化为 []；false 在 resolver 被拒绝。
  reasoningEfforts: z.union([z.const(false), z.array(z.union(MODEL_REASONING_EFFORTS)).min(1)]) as unknown as z<NonNullable<DeepSeekCatalogModel['reasoningEfforts']>>,
})

export const Config: z<Config> = z.object({
  channelName: z.string().min(1).max(64).pattern(/\S/u).default(DEFAULT_CHANNEL_NAME),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  retryPolicy: RetryPolicySchema,
  outbound: outboundSchema,
})

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedDeepSeekOptions = DeepSeekConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly DeepSeekCatalogModel[] | undefined): DeepSeekCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-deepseek: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    const efforts = model.reasoningEfforts
    if (efforts !== undefined) {
      if (!Array.isArray(efforts) || efforts.length === 0 || efforts.some(effort => !MODEL_REASONING_EFFORTS.includes(effort))) {
        throw new Error(`llm-deepseek: catalog model "${model.id}" reasoningEfforts must contain supported efforts`)
      }
      if (new Set(efforts).size !== efforts.length) {
        throw new Error(`llm-deepseek: catalog model "${model.id}" reasoningEfforts must not contain duplicates`)
      }
    }
    if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...inputModalities],
      ...efforts === undefined ? {} : { reasoningEfforts: [...efforts] },
    }
  })
}

/**
 * 校验渠道级出站选择：未知模式、自定义模式缺少合法 http(s) 地址都在这里拒绝，
 * 与端点、密钥同代进入连接快照。池地址不在这里解析——它随池规则与端口变化，
 * 由请求期的解析钩子读取。
 * @param outbound - 原始配置里的出站选择。
 * @returns 归一化后的出站选择。
 */
function resolveOutboundConfig(outbound: DeepSeekOutboundConfig | undefined): DeepSeekOutboundConfig {
  if (outbound === undefined) return { mode: 'direct' }
  if (outbound.mode !== 'custom') return { mode: outbound.mode }
  if (outbound.customUrl === undefined || !/^https?:\/\//.test(outbound.customUrl)) {
    throw new Error('llm-deepseek: outbound.customUrl must be an http(s) proxy URL')
  }
  return { mode: 'custom', customUrl: outbound.customUrl }
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: the product trusts the
 * project it is launched in, so a checkout can point its own agent at the
 * gateway that checkout is meant to use.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  if (config.channelName !== undefined
    && (typeof config.channelName !== 'string'
      || config.channelName.trim().length === 0
      || config.channelName.length > 64)) {
    throw new Error('llm-deepseek: channelName must contain non-whitespace text of at most 64 characters')
  }
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.thinking === 'disabled' && config.models?.some(model =>
    model.reasoningEfforts !== undefined && (model.reasoningEfforts.length !== 1 || model.reasoningEfforts[0] !== 'off'))) {
    throw new Error('llm-deepseek: model reasoningEfforts must be ["off"] when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-deepseek: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-deepseek: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-deepseek: maxRequestImageBytes must be a positive safe integer')
  }
  return {
    outbound: resolveOutboundConfig(config.outbound),
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-deepseek: retryPolicy'),
  }
}

/**
 * 注册单一 DeepSeek 路由，并在有效设置变化后同步渠道目录名称与重试策略。
 * @param ctx - 持有适配器与目录注册生命周期的插件上下文。
 * @param config - 作为设置基础层的插件配置；设置卸载后恢复使用。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedDeepSeekOptions | undefined
  const options = (): ResolvedDeepSeekOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-deepseek: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
      }
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  // 渠道级出站逐请求解析：内置代理池按池自己的出站控制取地址，池为直连（或
  // 池服务缺席）时回落直连；渠道自定义代理直接使用渠道设置里的地址。
  const resolveOutbound = (selection: DeepSeekOutboundConfig): DeepSeekOutbound => {
    if (selection.mode === 'pool') {
      const url = ctx.get('proxyPool')?.proxyURL({ kind: 'pool' })
      return url === undefined ? { kind: 'direct' } : { kind: 'proxy', url }
    }
    if (selection.mode === 'custom' && selection.customUrl !== undefined) {
      return { kind: 'proxy', url: selection.customUrl }
    }
    return { kind: 'direct' }
  }
  const adapter = new DeepSeekAdapter({
    options,
    resolveApiKey,
    providerName: () => current().channelName ?? DEFAULT_CHANNEL_NAME,
    resolveUserId,
    resolveUserAgent: () => ctx.llm.getUserAgent(),
    resolveAttachments: () => ctx.get('attachments'),
    resolveOutbound,
  })
  let registeredName = current().channelName ?? DEFAULT_CHANNEL_NAME
  const directory = ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: registeredName, settingsNs: NS, settingsPath: [] },
  ])
  const ensureDirectory = (): void => {
    const displayName = current().channelName ?? DEFAULT_CHANNEL_NAME
    if (displayName === registeredName) return
    // 名称只更新配置目录；原子替换保留同一条路由及插件卸载时的清理责任。
    directory.replace([{ provider: PROVIDER, displayName, settingsNs: NS, settingsPath: [] }])
    registeredName = displayName
  }
  ctx.llm.registerModelDiscovery(NS, (request: LlmModelDiscoveryRequest) =>
    discoverModels(request, options(), resolveApiKey, ctx.llm.getUserAgent(), resolveOutbound))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  let registeredProviderName = registeredName
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    const providerName = current().channelName ?? DEFAULT_CHANNEL_NAME
    if (deepEqualJson(policy, registeredPolicy) && providerName === registeredProviderName) return
    // 注册表会捕获渠道名称与重试策略，名称变化须原地替换并通知选择器重读目录。
    registration.replace([PROVIDER])
    registeredPolicy = policy
    registeredProviderName = providerName
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      ensureDirectory()
      ensureRegistrationFacts()
    },
  })
}
