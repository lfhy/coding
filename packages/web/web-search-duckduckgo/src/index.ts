/** 注册无需凭据的 DuckDuckGo HTML 搜索提供方。 */
import type { Context } from '@deepseek-ai/cordis'
import { DuckDuckGoSearchProvider } from './provider.ts'

export { DuckDuckGoSearchProvider, DUCKDUCKGO_PROVIDER_ID } from './provider.ts'

/** Cordis 插件名称。 */
export const name = 'web-search-duckduckgo'
/** 注册到 Web 服务。 */
export const inject = ['web']

/**
 * 注册匿名搜索后端；随插件 fiber 卸载而撤销。
 * @param ctx - 提供 Web 服务的上下文。
 * @returns 无返回值。
 */
export function apply(ctx: Context): void {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider())
}
