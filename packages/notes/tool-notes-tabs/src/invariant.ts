/**
 * `coding-tool-notes-tabs` 的不变量伴随插件。
 * @module coding-tool-notes-tabs/invariant
 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-tool-notes-tabs'

/** Cordis 插件名。 */
export const name = 'tool-notes-tabs-invariant'
/** 注册前要求不变量服务存在。 */
export const inject = ['invariants']

/** No runtime invariant: 标签快照只在进程内，发布版本和会话权限在路由与工具测试中校验。 */
const install: InvariantInstaller = () => {}

/** 注册包名并在伴随插件卸载时移除。
 * @param ctx - 包不变量服务的上下文。
 * @returns 注册释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
