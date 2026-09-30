/** @module @deepseek-ai/dsh-client-ui-settings-search/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-search'

/** Cordis companion 插件名。 */
export const name = 'client-ui-settings-search-invariant'
/** 运行时所有权注册所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包只呈现设置；持久写入与凭据拒绝由 Host 服务约束。 */
const install: InvariantInstaller = () => {}

/**
 * 注册空的浏览器界面 companion。
 * @param ctx - 带不变量注册服务的 Context。
 * @returns 注册完成后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
