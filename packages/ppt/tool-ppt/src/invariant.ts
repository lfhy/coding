/**
 * `coding-tool-ppt` 的包级不变量伴生插件。
 * @module coding-tool-ppt/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-tool-ppt'

/** Cordis 伴生插件的名字。 */
export const name = 'tool-ppt-invariant'
/** 认领包归属前需要的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包只把工具参数转给工程服务，接受与否由
 * `coding-ppt-workbench` 的存储与校验决定，工具面行为由包内测试覆盖。
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
