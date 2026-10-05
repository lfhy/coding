/** Electron 提供方的会话资源不变量登记。 @module @deepseek-ai/dsh-browser-electron/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'browser-electron-invariant'
export const inject = ['invariants']
/** No runtime invariant: 页面、截图及租约只在桌面进程和 Host 内存持有，跨进程时序由定向测试验证。 */
const install: InvariantInstaller = () => {}

/**
 * 登记包归属；此包没有可从会话持久事件同步断言的状态。
 * @param ctx - 拥有不变量注册器的 Cordis 上下文。
 * @returns 可撤销登记的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-browser-electron', install))
