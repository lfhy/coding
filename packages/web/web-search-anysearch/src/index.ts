/** 注册 AnySearch 搜索提供方：匿名免费额度开箱可用，配置 Bearer 密钥时提额。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from 'coding-launch-environment'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import {
  ANYSEARCH_DEFAULT_BASE_URL,
  AnySearchProvider,
  isSafeBaseUrl,
  isValidProxyURL,
} from './provider.ts'
import type { AnySearchProviderOptions } from './provider.ts'

export { AnySearchProvider, ANYSEARCH_DEFAULT_BASE_URL, ANYSEARCH_PROVIDER_ID } from './provider.ts'
export type { AnySearchProviderOptions } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-anysearch'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** 未配置 `apiKey` 时读取的启动环境变量名；仍为空则按匿名档请求。 */
const API_KEY_ENV = 'ANYSEARCH_API_KEY'

/** AnySearch 搜索的配置：可选密钥、可选端点与共享出站选择。 */
export interface Config {
  /** Bearer 密钥字面值；省略时读 `$ANYSEARCH_API_KEY`，两者都为空则匿名请求。 */
  apiKey?: string
  /** 搜索端点基址，请求追加 `/v1/search`；缺省 AnySearch 官方端点。 */
  baseURL?: string
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  baseURL: z.string(),
  outbound: OutboundConfigSchema,
})

/** AnySearch 提供方的用户设置分节。 */
export const WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE = settingsNamespace('web-search-anysearch')

/**
 * 投影一次搜索使用的配置：密钥按「字面值 → 启动环境 → 匿名」的顺序解析，每次搜索重新读取。
 * @param ctx - 拥有设置与启动环境的上下文。
 * @param config - 当前设置分节快照。
 * @returns 同一次请求共用的端点、密钥与出站解析。
 */
function resolveOptions(ctx: Context, config: Config): AnySearchProviderOptions {
  const literal = config.apiKey?.trim()
  const ambient = launchEnvironmentOf(ctx).get(API_KEY_ENV)?.value.trim()
  const apiKey = literal !== undefined && literal !== ''
    ? literal
    : ambient !== undefined && ambient !== '' ? ambient : undefined
  return {
    ...apiKey === undefined ? {} : { apiKey },
    baseURL: config.baseURL ?? ANYSEARCH_DEFAULT_BASE_URL,
    ...config.outbound === undefined ? {} : { outbound: config.outbound },
    // 池服务在请求期读取：池未装配、池规则为直连时都回落直连。
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), config.outbound ?? { mode: 'direct' }),
  }
}

/**
 * 校验本提供方的端点与出站选择。端点会收到 Bearer 密钥，因此只接受不含凭据、
 * 查询串与片段的公网 HTTPS 地址；错误信息点名本提供方的配置项。
 * @param baseURL - 设置分节里的端点基址。
 * @param outbound - 设置分节里的出站选择。
 */
function checkConfig(baseURL: string | undefined, outbound: OutboundConfig | undefined): void {
  if (baseURL !== undefined && !isSafeBaseUrl(baseURL)) {
    throw new TypeError('web-search-anysearch.baseURL must be a public HTTPS URL without credentials, query, or fragment')
  }
  assertUsableOutbound('web-search-anysearch.outbound', outbound, isValidProxyURL)
}

/**
 * 注册搜索后端；每次搜索读取当前设置与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, Config, config, {
    validate: (value) => { checkConfig(value.baseURL, value.outbound) },
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new AnySearchProvider(() => resolveOptions(ctx, current())))
}
