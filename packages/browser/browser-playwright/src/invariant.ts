/** Playwright 提供方的会话资源不变量登记。 @module @deepseek-ai/dsh-browser-playwright/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'browser-playwright-invariant'
export const inject = ['invariants']
/** No runtime invariant: 页面、截图与资源归属只存于提供方进程内，不进入持久事件流。 */
const install: InvariantInstaller = () => {}

/**
 * 登记此包的运行时不变量。
 * @param ctx - 拥有不变量注册器的 Cordis 上下文。
 * @returns 可撤销登记的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-browser-playwright', install))
