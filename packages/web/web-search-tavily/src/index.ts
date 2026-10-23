/** 将 Tavily 的专用搜索端点注册为 `ctx.web` 搜索提供方。@module coding-web-search-tavily */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from 'coding-credentials'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import type {} from 'coding-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  isSafeBaseUrl,
  isSafeProxyUrl,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_PROVIDER_ID } from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'

/** Cordis 插件名。 */
export const name = 'web-search-tavily'
/** 此插件向既有 web 服务登记提供方。 */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** 可保存的 Tavily 搜索配置；密钥引用每次请求重新解析。 */
export interface Config {
  /** 密钥字面值；非空时优先于凭据引用。 */
  apiKey?: string
  /** 凭据引用，默认 `TAVILY_API_KEY`。 */
  apiKeyEnv?: string
  /** 搜索端点基址，追加 `/search`。 */
  baseURL?: string
  /** 只作用于此提供方的出站：直连（缺省）、内置代理池或自定义代理。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  outbound: OutboundConfigSchema,
})

/** 本提供方独立的持久设置区。 */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-tavily')

/**
 * 投影一次搜索使用的配置和凭据解析器。
 * @param ctx - 拥有设置、凭据和启动环境的上下文。
 * @param config - 当前设置区快照。
 * @returns 同一次请求共用的端点、出站解析与密钥解析器。
 */
function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    // 密钥按字面值 → 凭据服务解析；不读取进程环境变量。
    resolveApiKey: async () => literal ?? (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value,
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    ...config.outbound === undefined ? {} : { outbound: config.outbound },
    // 池服务在请求期读取：池未装配、池规则为直连时都回落直连。
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), config.outbound ?? { mode: 'direct' }),
  }
}

/**
 * 将 Tavily 提供方及其可更新设置区注册到 `ctx.web`。
 * @param ctx - 拥有 web 服务的插件上下文。
 * @param config - 组合文件中的初始配置。
 * @returns 无返回值；Cordis fiber 负责撤销登记。
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      if (value.baseURL !== undefined && !isSafeBaseUrl(value.baseURL)) {
        throw new TypeError('web-search-tavily.baseURL must be an HTTPS public URL without credentials, query, or fragment')
      }
      // 自定义地址必须是 http(s) 且不含凭据、查询串或片段，免得明文凭据写进设置。
      assertUsableOutbound('web-search-tavily.outbound', value.outbound, isSafeProxyUrl)
      credentialRef(value.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}
