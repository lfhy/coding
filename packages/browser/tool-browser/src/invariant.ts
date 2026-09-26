/** 浏览器工具包的不变量登记。 @module @deepseek-ai/dsh-tool-browser/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis 插件名称。 */
export const name = 'tool-browser-invariant'
/** 不变量服务是登记时的必需依赖。 */
export const inject = ['invariants']

/** No runtime invariant: browser resource and observation lifetimes belong to the browser provider. */
const install: InvariantInstaller = () => {}

/**
 * 登记工具包身份；浏览器资源自身由服务提供方检查。
 * @param ctx - 提供不变量登记服务的上下文。
 * @returns 登记的释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-browser', install))
