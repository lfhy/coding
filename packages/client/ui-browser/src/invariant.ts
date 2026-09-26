/** 浏览器画面插件的 invariant companion。 @module @deepseek-ai/dsh-client-ui-browser/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-browser'

/** Cordis companion 插件名。 */
export const name = 'client-ui-browser-invariant'
/** companion 注册前必须存在的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 请求修订版和 Blob URL 生命周期由控制器测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant companion。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 注册完成后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
