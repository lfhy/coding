/** Agent 浏览器面板的 invariant companion。 @module coding-client-ui-browser-ego/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-browser-ego'

/** companion 插件名。 */
export const name = 'client-ui-browser-ego-invariant'
/** invariant 注册服务。 */
export const inject = ['invariants']

/** No runtime invariant: 会话隔离与槽位释放由本包的 wire 与注册测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 记录本包的不变量归属。
 * @param ctx - 包含不变量注册服务的上下文。
 * @returns 注销登记的函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
