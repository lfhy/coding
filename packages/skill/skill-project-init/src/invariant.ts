/** 项目初始化技能包的运行时不变量登记。 @module coding-skill-project-init/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-skill-project-init'

/** Cordis 配套插件名。 */
export const name = 'skill-project-init-invariant'
/** 登记包所有权所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包仅登记一个固定技能，名称唯一性与卸载撤销由注册表负责。 */
const install: InvariantInstaller = () => {}

/**
 * 登记项目初始化技能包的不变量配套插件。
 * @param ctx - 提供不变量登记服务的 Cordis 上下文。
 * @returns 登记成功后的撤销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
