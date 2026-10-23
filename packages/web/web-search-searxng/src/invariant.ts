/** SearXNG 提供方没有独立于 Web 注册表的事件或可变数据关系。 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-web-search-searxng'
/** Cordis companion 插件名称。 */
export const name = 'web-search-searxng-invariant'
/** 注册不变量时需要的服务。 */
export const inject = ['invariants']
/** No runtime invariant: 实例列表与出站选择都在每次搜索开始时解析，无跨请求状态。 */
const install: InvariantInstaller = () => {}
/**
 * 登记包的不变量 companion。
 * @param ctx - 含不变量服务的上下文。
 * @returns 卸载登记的函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
