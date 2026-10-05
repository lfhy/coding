/** 将 Tavily 的专用搜索端点注册为 `ctx.web` 搜索提供方。@module @deepseek-ai/dsh-web-search-tavily */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
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
  /** 只作用于此提供方的 HTTP(S) 前向代理。 */
  proxyURL?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  proxyURL: z.string(),
})

/** 本提供方独立的持久设置区。 */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-tavily')

/**
 * 投影一次搜索使用的配置和凭据解析器。
 * @param ctx - 拥有设置、凭据和启动环境的上下文。
 * @param config - 当前设置区快照。
 * @returns 同一次请求共用的端点、代理及密钥解析器。
 */
function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    ...config.proxyURL === undefined ? {} : { proxyURL: config.proxyURL },
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
      if (value.proxyURL !== undefined && !isSafeProxyUrl(value.proxyURL)) {
        throw new TypeError('web-search-tavily.proxyURL must be an HTTP(S) URL without credentials, query, or fragment')
      }
      credentialRef(value.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}
