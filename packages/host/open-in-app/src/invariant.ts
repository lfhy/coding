/**
 * `@deepseek-ai/dsh-host-open-in-app` 的包级 invariant companion。
 * @module @deepseek-ai/dsh-host-open-in-app/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-open-in-app'

/** Cordis companion 插件名。 */
export const name = 'host-open-in-app-invariant'
/** companion 注册前必须存在的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 路由所有权、Session 绑定与终端清理由组合测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant companion。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 注册完成后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
