/** 注册无需凭据的 DuckDuckGo HTML 搜索提供方。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { DuckDuckGoSearchProvider } from './provider.ts'
import { isValidProxyURL } from './provider.ts'

export { DuckDuckGoSearchProvider, DUCKDUCKGO_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-duckduckgo'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** DuckDuckGo 搜索的出站选择：直连（缺省）、内置代理池或自定义代理。 */
export interface Config {
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({ outbound: OutboundConfigSchema })

/** DuckDuckGo 提供方的用户设置分节。 */
export const WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE = settingsNamespace('web-search-duckduckgo')

/**
 * 注册匿名搜索后端；每次搜索读取当前设置与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, Config, config, {
    // 自定义地址必须是 http(s) 且不含凭据、查询串或片段，免得明文凭据写进设置。
    validate: (value) => { assertUsableOutbound('web-search-duckduckgo.outbound', value.outbound, isValidProxyURL) },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider(
    () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  ))
}
