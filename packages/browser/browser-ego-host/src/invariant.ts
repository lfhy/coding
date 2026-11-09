/** ego-lite Host 的进程外归属由 HTTP 边界测试而非持久化日志检查。 @module coding-browser-ego-host/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

export const name = 'browser-ego-host-invariant'
export const inject = ['invariants']
/** No runtime invariant: 浏览器空间、画面与 worker 不进入会话事件流。 */
const install: InvariantInstaller = () => {}

/** 登记包归属，不为跨进程短暂状态伪造持久事件断言。 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('coding-browser-ego-host', install))
