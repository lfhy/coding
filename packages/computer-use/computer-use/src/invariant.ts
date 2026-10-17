/** computer-use 服务包的不变量登记。 @module coding-computer-use/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-computer-use'

/** Cordis 附属插件名称。 */
export const name = 'computer-use-invariant'
/** 登记所有权前要求不变量服务就绪。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 提供方只通过 native helper 的固定 argv 协议持有状态，
 * 观察缓存、租约与确认令牌的生命周期由 `service.spec.ts` 与 `native-helper.spec.ts` 覆盖；
 * 面向模型的可见性不变量属于 `coding-tool-computer-use`。
 */
const install: InvariantInstaller = () => {}

/**
 * 登记本包的不变量附属插件。
 * @param ctx - 提供不变量服务的 Cordis context。
 * @returns 登记完成后的撤销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
