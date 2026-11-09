/** @module coding-client-ui-files/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-files'

/** Cordis companion 插件名。 */
export const name = 'client-ui-files-invariant'
/** 不变量注册服务。 */
export const inject = ['invariants']

/** No runtime invariant: 本包不维护文件系统状态；准入与目录限制由 Host 执行。 */
const install: InvariantInstaller = () => {}

/**
 * 注册文件管理界面的空 companion。
 * @param ctx - 带不变量注册服务的 Context。
 * @returns 注销句柄。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
