/** 浏览器技能包的运行时不变量登记。 @module @deepseek-ai/dsh-skill-browser-use/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-browser-use'

/** Cordis 配套插件名。 */
export const name = 'skill-browser-use-invariant'
/** 登记包所有权所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包仅登记一个固定技能；注册表负责名称唯一性和卸载撤销。 */
const install: InvariantInstaller = () => {}

/**
 * 登记浏览器技能包的不变量配套插件。
 * @param ctx - 提供不变量登记服务的 Cordis 上下文。
 * @returns 登记成功后的撤销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
