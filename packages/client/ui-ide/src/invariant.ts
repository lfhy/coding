/** @module coding-client-ui-ide/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-ide'

/** Cordis companion 插件名。 */
export const name = 'client-ui-ide-invariant'
/** 不变量注册服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包只组合现有界面能力，不维护持久状态；工作区与会话准入由所属能力负责。 */
const install: InvariantInstaller = () => {}

/**
 * 注册代码工作区界面的空 companion。
 * @param ctx - 带不变量注册服务的 Context。
 * @returns 注销句柄。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
