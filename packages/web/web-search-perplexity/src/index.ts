/**
 * `coding-web-search-perplexity`: registers a Perplexity-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `coding-llm-deepseek` registers an adapter into `ctx.llm`.
 *
 * @module coding-web-search-perplexity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from 'coding-credentials'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import type {} from 'coding-web'
import { PerplexitySearchProvider, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL } from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from './provider.ts'
export type { PerplexityRecency, PerplexitySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-perplexity'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** 密钥字面值（部署层）；页面与设置文件用 `apiKeyEnv` 指向凭据服务。 */
  apiKey?: string
  /** 凭据引用，默认 `PERPLEXITY_API_KEY`；密钥只存在凭据服务里，由设置页写入。 */
  apiKeyEnv?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to 1024. */
  maxTokens?: number
  /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
  /** Outbound path: direct (default), the built-in proxy pool, or a custom proxy. */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default('PERPLEXITY_API_KEY'),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
  outbound: OutboundConfigSchema,
})

/** Register the Perplexity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // 出站选择在装载时先判一次，坏配置立即失败而不是等到第一次搜索。
  assertUsableOutbound('web-search-perplexity.outbound', config.outbound)
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? 'PERPLEXITY_API_KEY')
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  ctx.web.registerSearchProvider(new PerplexitySearchProvider({
    // 密钥按字面值 → 凭据服务解析；不再读取进程环境变量。
    resolveApiKey: async () => literal ?? (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value,
    baseURL: config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
    model: config.model ?? PERPLEXITY_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
    ...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
    ...config.outbound === undefined ? {} : { outbound: config.outbound },
    // 池服务在请求期读取：池未装配、池规则为直连时都回落直连。
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), config.outbound ?? { mode: 'direct' }),
  }))
}
