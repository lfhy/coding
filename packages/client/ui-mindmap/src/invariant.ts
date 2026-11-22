/** `coding-client-ui-mindmap` 的包级不变量伴生插件。 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-mindmap'

/** Cordis 伴生插件名称。 */
export const name = 'client-ui-mindmap-invariant'
/** 注册依赖的不变量服务。 */
export const inject = ['invariants']

/** No runtime invariant: 浏览器局部请求不产生会话事件；路径切换、轮询和冲突由组件测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量伴生插件。
 * @param ctx - 携带不变量服务的上下文。
 * @returns 安装成功后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
