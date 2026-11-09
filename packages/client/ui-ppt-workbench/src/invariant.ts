/**
 * `coding-client-ui-ppt-workbench` 的包级不变量伴生插件。
 * @module coding-client-ui-ppt-workbench/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-ppt-workbench'

/** Cordis 伴生插件的名字。 */
export const name = 'client-ui-ppt-workbench-invariant'
/** 认领包归属前需要的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 面板状态只经注入的快照与控制器动作流转，
 * 会话隔离与标签释放由本包的注册测试覆盖。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量伴生插件。
 * @param ctx - 携带 invariants 服务的 Cordis 上下文。
 * @returns 安装成功后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
