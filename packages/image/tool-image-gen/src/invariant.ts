/** 模型图像工具包级不变量。@module coding-tool-image-gen/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-tool-image-gen'
/** 伴随插件名称。 */
export const name = 'tool-image-gen-invariant'
/** 不变量服务是安装依赖。 */
export const inject = ['invariants']
/** No runtime invariant: 工具注册效果由 coding-tools 管理，本包没有独立持久状态。 */
const install: InvariantInstaller = () => {}
/** @param ctx - 持有不变量服务的上下文。 @returns 注册的释放函数。 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
