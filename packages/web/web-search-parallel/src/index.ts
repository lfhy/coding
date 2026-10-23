/** 注册 Parallel 搜索提供方：MCP JSON-RPC 调用，匿名额度可用，配置密钥后提额。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableOutbound, OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { credentialRef } from 'coding-credentials'
import { PARALLEL_DEFAULT_BASE_URL, ParallelSearchProvider, isValidBaseURL, isValidProxyURL } from './provider.ts'

export { ParallelSearchProvider, PARALLEL_DEFAULT_BASE_URL, PARALLEL_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-parallel'
/** 注册到 Web 服务。 */
export const inject = ['web']

/** Parallel 搜索的配置：可选密钥与端点，加上共享出站选择。 */
export interface Config {
  /** 密钥字面值（部署层）；页面与设置文件用 `apiKeyEnv` 指向凭据服务。 */
  apiKey?: string
  /** 凭据引用，默认 `PARALLEL_API_KEY`；密钥只存在凭据服务里，由设置页写入。 */
  apiKeyEnv?: string
  /** MCP 端点；默认 `https://search.parallel.ai/mcp`，必须是不带凭据、查询串与片段的 HTTPS 地址。 */
  baseURL?: string
  /** 下次搜索的出站；缺省直连，选择内置代理池时按池自己的出站规则走。 */
  outbound?: OutboundConfig
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default('PARALLEL_API_KEY'),
  baseURL: z.string(),
  outbound: OutboundConfigSchema,
})

/** Parallel 提供方的用户设置分节。 */
export const WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE = settingsNamespace('web-search-parallel')

/**
 * 校验本提供方的配置：端点必须能安全承载密钥，出站选择复用共享契约并额外要求
 * 代理 URL 不携带凭据、查询串或片段。错误信息点名本提供方的配置项。
 * @param config - 设置分节或组合条目里的配置。
 */
function checkConfig(config: Config): void {
  if (config.baseURL !== undefined && !isValidBaseURL(config.baseURL)) {
    throw new TypeError('web-search-parallel.baseURL must be an HTTPS URL without credentials, query, or fragment')
  }
  assertUsableOutbound('web-search-parallel.outbound', config.outbound, isValidProxyURL)
}

/**
 * 注册 Parallel 搜索后端；每次搜索读取当前设置、密钥与池规则，随插件 fiber 卸载而撤销。
 *
 * 代理池是可选的：`ctx.get('proxyPool')` 在请求期读取，池未装配或池规则为直连
 * 时回落直连；因此不写进 `inject`，池缺席不影响本提供方启动。
 * @param ctx - 提供 Web 服务的上下文。
 * @param config - 组合配置，在设置服务不存在时继续生效。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  checkConfig(config)
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE, Config, config, {
    validate: checkConfig,
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new ParallelSearchProvider({
    // 密钥按字面值 → 凭据服务解析；两者都没有时按匿名额度请求。
    resolveApiKey: async () => {
      const config = current()
      const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
      if (literal !== undefined) return literal
      const apiKeyEnv = credentialRef(config.apiKeyEnv ?? 'PARALLEL_API_KEY')
      return (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value
    },
    resolveBaseURL: () => current().baseURL ?? PARALLEL_DEFAULT_BASE_URL,
    resolveProxyURL: () => resolveOutboundURL(ctx.get('proxyPool'), current().outbound ?? { mode: 'direct' }),
  }))
}
