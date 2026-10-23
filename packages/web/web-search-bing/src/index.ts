/** 注册无需凭据的 Bing SERP 搜索提供方。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { BingSearchProvider } from './provider.ts'
import { isValidProxyURL } from './provider.ts'

export { BingSearchProvider, BING_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-bing'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** Bing 搜索的配置：一个可选的 market 与共享出站选择。 */
export interface Config {
  /** Bing 市场（如 `zh-CN`）；省略时不发 `mkt` 参数，由 Bing 按 Accept-Language 自行本地化。 */
  market?: string
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  market: z.string(),
  outbound: OutboundConfigSchema,
})

/** Bing 提供方的用户设置分节。 */
export const WEB_SEARCH_BING_SETTINGS_NAMESPACE = settingsNamespace('web-search-bing')

/**
 * 校验本提供方的 market 配置：仅接受 `ll-CC` 形态的语言区域标签，拒绝空白与其他格式，避免把任意字符串拼进查询参数。
 * @param market - 设置分节里的 market。
 */
function assertUsableMarket(market: string | undefined): void {
  if (market === undefined || market.trim() === '') return
  if (!/^[a-z]{2,3}-[a-z0-9]{2,8}$/i.test(market.trim())) {
    throw new TypeError('web-search-bing.market must be a language-region tag like zh-CN')
  }
}

/**
 * 校验本提供方的出站选择：复用共享契约，额外的地址约束要求代理 URL 不携带
 * 凭据、查询串或片段。错误信息点名本提供方的配置项。
 * @param outbound - 设置分节里的出站选择。
 */
function checkOutbound(outbound: OutboundConfig | undefined): void {
  assertUsableOutbound('web-search-bing.outbound', outbound, isValidProxyURL)
}

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
  installSettingsSection(ctx, WEB_SEARCH_BING_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      assertUsableMarket(value.market)
      checkOutbound(value.outbound)
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new BingSearchProvider(
    () => current().market,
    () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  ))
}
