/** 注册 Firecrawl 搜索提供方：有 API key 走账号档，无 key 走官方 keyless 匿名额度。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from 'coding-launch-environment'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { FIRECRAWL_DEFAULT_BASE_URL, FirecrawlSearchProvider, isSafeBaseUrl, isValidProxyURL } from './provider.ts'

export { FIRECRAWL_DEFAULT_BASE_URL, FIRECRAWL_PROVIDER_ID, FirecrawlSearchProvider } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-firecrawl'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** 省略 `apiKey` 时读取的环境变量名；仍为空则走 keyless 匿名额度。 */
const API_KEY_ENV = 'FIRECRAWL_API_KEY'

/** Firecrawl 搜索的配置：可选密钥、可选端点基址与共享出站选择。 */
export interface Config {
  /** Firecrawl API key；省略时读 `FIRECRAWL_API_KEY`，再为空则走 keyless 匿名额度。 */
  apiKey?: string
  /** 搜索端点基址（追加 `/v2/search`）；缺省为官方 API。 */
  baseURL?: string
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  baseURL: z.string(),
  outbound: OutboundConfigSchema,
})

/** Firecrawl 提供方的用户设置分节。 */
export const WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE = settingsNamespace('web-search-firecrawl')

/**
 * 解析本次搜索使用的 API key：配置里的字面值优先，其次启动环境里的 `FIRECRAWL_API_KEY`，
 * 两者都为空时返回 `undefined` 表示 keyless。
 * @param ctx - 拥有启动环境快照的上下文。
 * @param literal - 设置分节里的 `apiKey`。
 * @returns 非空密钥，或表示 keyless 的 `undefined`。
 */
function resolveApiKey(ctx: Context, literal: string | undefined): string | undefined {
  const explicit = literal?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const ambient = launchEnvironmentOf(ctx).get(API_KEY_ENV)?.value.trim()
  return ambient === undefined || ambient === '' ? undefined : ambient
}

/**
 * 注册 Firecrawl 搜索后端；每次搜索读取当前设置与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。keyless 冷却记录在
 * 提供方实例上，只按当前出站解析出的代理地址记账，换出口即视为新的判定周期。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => {
      if (value.baseURL !== undefined && !isSafeBaseUrl(value.baseURL)) {
        throw new TypeError('web-search-firecrawl.baseURL must be an absolute HTTP(S) URL without credentials, query, or fragment')
      }
      assertUsableOutbound('web-search-firecrawl.outbound', value.outbound, isValidProxyURL)
    },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new FirecrawlSearchProvider(
    () => resolveApiKey(ctx, current().apiKey),
    () => current().baseURL ?? FIRECRAWL_DEFAULT_BASE_URL,
    () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  ))
}
