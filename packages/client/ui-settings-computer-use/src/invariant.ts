/** @module coding-client-ui-settings-computer-use/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-settings-computer-use'

/** Cordis companion 插件名。 */
export const name = 'client-ui-settings-computer-use-invariant'
/** 运行时所有权注册所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包只呈现设置；开关、授权与写入校验由 Host 的电脑控制服务约束。 */
const install: InvariantInstaller = () => {}

/**
 * 注册空的浏览器界面 companion。
 * @param ctx - 带不变量注册服务的 Context。
 * @returns 注册完成后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
