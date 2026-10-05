/** Tavily 搜索提供方的包级不变量登记。@module @deepseek-ai/dsh-web-search-tavily/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-tavily'

/** Cordis 伴随插件名称。 */
export const name = 'web-search-tavily-invariant'
/** 登记前需要的不变量服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本提供方没有独立的事件序列或可变数据关系。 */
const install: InvariantInstaller = () => {}

/**
 * 登记本包的不变量伴随插件。
 * @param ctx - 提供不变量服务的 Cordis 上下文。
 * @returns 登记完成后的释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
