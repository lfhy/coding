/**
 * `coding-web-search-exa`: registers an Exa-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `coding-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `coding-web`.
 *
 * @module coding-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from 'coding-credentials'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import type {} from 'coding-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** 密钥字面值（部署层）；页面与设置文件用 `apiKeyEnv` 指向凭据服务。 */
  apiKey?: string
  /** 凭据引用，默认 `EXA_API_KEY`；密钥只存在凭据服务里，由设置页写入。 */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
  /** Outbound path: direct (default), the built-in proxy pool, or a custom proxy. */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default('EXA_API_KEY'),
  baseURL: z.string(),
  searchType: z.union(['auto', 'keyword', 'neural'] as const),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
  outbound: OutboundConfigSchema,
})

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // 出站选择在装载时先判一次，坏配置立即失败而不是等到第一次搜索。
  assertUsableOutbound('web-search-exa.outbound', config.outbound)
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? 'EXA_API_KEY')
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  ctx.web.registerSearchProvider(new ExaSearchProvider({
    // 密钥按字面值 → 凭据服务解析；不再读取进程环境变量。
    resolveApiKey: async () => literal ?? (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value,
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
    ...config.outbound === undefined ? {} : { outbound: config.outbound },
    // 池服务在请求期读取：池未装配、池规则为直连时都回落直连。
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), config.outbound ?? { mode: 'direct' }),
  }))
}
