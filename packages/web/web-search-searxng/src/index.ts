/** 注册无需密钥的 SearXNG 元搜索提供方。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { isValidInstanceURL, isValidProxyURL, SEARXNG_INSTANCES, SearxngSearchProvider } from './provider.ts'

export { SEARXNG_INSTANCES, SearxngSearchProvider, SEARXNG_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-searxng'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** SearXNG 搜索的配置：可选的实例列表与共享出站选择。 */
export interface Config {
  /**
   * 自定义实例基址，按顺序尝试；省略或为空数组时使用内置的 6 个公共实例。
   * 每项必须是 http(s) 绝对地址，且不带凭据、查询串与片段。
   */
  instances?: string[]
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  instances: z.array(z.string()),
  outbound: OutboundConfigSchema,
})

/** SearXNG 提供方的用户设置分节。 */
export const WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE = settingsNamespace('web-search-searxng')

/**
 * 校验自定义实例列表：拒绝非 http(s)、带凭据、带查询串或片段的地址，避免把任意
 * 字符串拼进请求 URL；错误信息不回显地址本身。
 * @param instances - 设置分节里的实例列表。
 */
function assertUsableInstances(instances: readonly string[] | undefined): void {
  for (const instance of instances ?? []) {
    if (!isValidInstanceURL(instance)) {
      throw new TypeError('web-search-searxng.instances must be http(s) URLs without credentials, query or fragment')
    }
  }
}

/**
 * 校验本提供方的出站选择：复用共享契约，额外的地址约束要求代理 URL 不携带
 * 凭据、查询串或片段。错误信息点名本提供方的配置项。
 * @param outbound - 设置分节里的出站选择。
 */
function checkOutbound(outbound: OutboundConfig | undefined): void {
  assertUsableOutbound('web-search-searxng.outbound', outbound, isValidProxyURL)
}

/**
 * 注册元搜索后端；每次搜索读取当前设置与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      assertUsableInstances(value.instances)
      checkOutbound(value.outbound)
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new SearxngSearchProvider(
    () => {
      // 空列表与省略等价：都按内置公共实例尝试。
      const configured = current().instances ?? []
      return configured.length > 0 ? configured : SEARXNG_INSTANCES
    },
    () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  ))
}
