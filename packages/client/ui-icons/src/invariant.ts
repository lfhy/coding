/** 图标包只渲染 React 组件，没有独立的 Cordis 状态。 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-icons'

/** Cordis companion 插件名。 */
export const name = 'client-ui-icons-invariant'
/** 注册包归属所需的服务。 */
export const inject = ['invariants']

/** No runtime invariant: 纯展示组件没有 Cordis 状态；渲染行为由组件测试约束。 */
const install: InvariantInstaller = () => {}

/**
 * 注册图标包的 invariant companion。
 * @param ctx - 包含 invariant 注册服务的 Context。
 * @returns 注册项的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
