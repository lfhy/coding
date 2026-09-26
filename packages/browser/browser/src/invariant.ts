/** 浏览器服务定义包的不变量注册。 @module @deepseek-ai/dsh-browser/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-browser'

/** Cordis 附属插件名称。 */
export const name = 'browser-invariant'
/** 注册包所有权前要求不变量服务就绪。 */
export const inject = ['invariants']

/** No runtime invariant: 抽象服务不持有页面状态；具体提供方负责会话及修订版检查。 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量附属插件。
 * @param ctx - 提供不变量服务的 Cordis context。
 * @returns 注册完成后的撤销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
