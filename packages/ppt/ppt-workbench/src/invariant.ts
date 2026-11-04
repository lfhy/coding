/**
 * `coding-ppt-workbench` 的包级不变量伴生插件。
 * @module coding-ppt-workbench/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-ppt-workbench'

/** Cordis 伴生插件的名字。 */
export const name = 'ppt-workbench-invariant'
/** 认领包归属前需要的服务。 */
export const inject = ['invariants']

/**
 * 没有运行时不变量要检查：`deck.json` 与 `history.json` 只有本包的存储层写，
 * 版本号从历史游标派生，版本接受规则由包内存储测试覆盖。
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
