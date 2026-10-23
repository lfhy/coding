/**
 * Register a DeepSeek-backed provider in `ctx.web`. It calls the Anthropic-compatible Messages API
 * with native `web_search_20250305`. Search uses its own credential reference, not
 * `DEEPSEEK_BASE_URL`, because search and chat-completions use different bases.
 * @module coding-web-search-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from 'coding-agent'
import { credentialRef } from 'coding-credentials'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import type {} from 'coding-session'
import type {} from 'coding-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  isSafeBaseUrl,
  isSafeProxyUrl,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
} from './provider.ts'
export type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_SEARCH_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** 每次搜索独立解析的凭据引用；默认 `DEEPSEEK_SEARCH_API_KEY`。 */
  apiKeyEnv?: string
  /** Anthropic 兼容端点基址；请求会追加 `/messages`。 */
  baseURL?: string
  /** 仅当前搜索使用的出站：直连（缺省）、内置代理池或自定义代理。 */
  outbound?: OutboundConfig
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model?: string
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion?: string
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens?: number
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  outbound: OutboundConfigSchema,
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES),
})

/**
 * Environment variable naming this provider's endpoint. Deliberately distinct
 * from `$DEEPSEEK_BASE_URL`, which belongs to the chat-completions adapter:
 * search speaks the Anthropic-compatible Messages API, so one variable cannot
 * serve both.
 */

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): DeepSeekSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    // 密钥按字面值 → 凭据服务解析；不读取进程环境变量。
    resolveApiKey: async () => literalApiKey ?? (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value,
    apiKeyEnv,
    baseURL: config.baseURL ?? DEEPSEEK_DEFAULT_BASE_URL,
    ...config.outbound === undefined ? {} : { outbound: config.outbound },
    // 池服务在请求期读取：池未装配、池规则为直连时都回落直连。
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), config.outbound ?? { mode: 'direct' }),
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/** Register the DeepSeek search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      if (value.baseURL !== undefined && !isSafeBaseUrl(value.baseURL)) {
        throw new TypeError('web-search-deepseek.baseURL must be an HTTPS URL without credentials, query, or fragment')
      }
      // 自定义地址必须是 http(s) 且不含凭据、查询串或片段，免得明文凭据写进设置。
      assertUsableOutbound('web-search-deepseek.outbound', value.outbound, isSafeProxyUrl)
      if (value.model !== undefined && value.model.trim().length === 0) {
        throw new TypeError('web-search-deepseek.model must not be blank')
      }
      credentialRef(value.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    },
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => resolveOptions(ctx, current())))
}
