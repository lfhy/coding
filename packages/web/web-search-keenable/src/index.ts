/** 注册 Keenable 搜索提供方：MCP JSON-RPC 调用，匿名额度可用，配置密钥后提额。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from 'coding-launch-environment'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { KEENABLE_DEFAULT_BASE_URL, KeenableSearchProvider, isValidBaseURL, isValidProxyURL } from './provider.ts'

export { KeenableSearchProvider, KEENABLE_DEFAULT_BASE_URL, KEENABLE_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-keenable'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** Keenable 搜索的配置：可选密钥与端点，加上共享出站选择。 */
export interface Config {
  /** Keenable API key；省略时读取 `$KEENABLE_API_KEY`，两者都没有或为空时使用匿名额度。 */
  apiKey?: string
  /** MCP 端点；默认 `https://api.keenable.ai/mcp`，必须是不带凭据、查询串与片段的 HTTPS 地址。 */
  baseURL?: string
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  baseURL: z.string(),
  outbound: OutboundConfigSchema,
})

/** Keenable 提供方的用户设置分节。 */
export const WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE = settingsNamespace('web-search-keenable')

/**
 * 校验本提供方的配置：端点必须能安全承载密钥，出站选择复用共享契约并额外要求
 * 代理 URL 不携带凭据、查询串或片段。错误信息点名本提供方的配置项。
 * @param config - 设置分节或组合条目里的配置。
 */
function checkConfig(config: Config): void {
  if (config.baseURL !== undefined && !isValidBaseURL(config.baseURL)) {
    throw new TypeError('web-search-keenable.baseURL must be an HTTPS URL without credentials, query, or fragment')
  }
  assertUsableOutbound('web-search-keenable.outbound', config.outbound, isValidProxyURL)
}

/**
 * 注册 Keenable 搜索后端；每次搜索读取当前设置、密钥与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  checkConfig(config)
  const environment = launchEnvironmentOf(ctx)
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE, Config, config, {
    validate: checkConfig,
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new KeenableSearchProvider({
    resolveApiKey: () => current().apiKey ?? environment.get('KEENABLE_API_KEY')?.value ?? '',
    resolveBaseURL: () => current().baseURL ?? KEENABLE_DEFAULT_BASE_URL,
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  }))
}
