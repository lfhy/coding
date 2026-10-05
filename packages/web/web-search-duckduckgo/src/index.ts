/** 注册无需凭据的 DuckDuckGo HTML 搜索提供方。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DuckDuckGoSearchProvider } from './provider.ts'
import { isValidProxyURL } from './provider.ts'

export { DuckDuckGoSearchProvider, DUCKDUCKGO_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-duckduckgo'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** DuckDuckGo 搜索的可选 HTTP(S) 前向代理配置。 */
export interface Config {
  /** 下次搜索使用的代理 URL；缺省时直连。 */
  proxyURL?: string
}

export const Config: z<Config> = z.object({ proxyURL: z.string() })

/** DuckDuckGo 提供方的用户设置分节。 */
export const WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE = settingsNamespace('web-search-duckduckgo')

/**
 * 注册匿名搜索后端；每次搜索读取当前设置，随插件 fiber 卸载而撤销。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      if (value.proxyURL !== undefined && !isValidProxyURL(value.proxyURL)) {
        throw new TypeError('web-search-duckduckgo.proxyURL must be an HTTP(S) URL without credentials, query, or fragment')
      }
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider(() => current().proxyURL))
}
