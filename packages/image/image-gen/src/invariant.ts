/** 图像服务的包级不变量登记。@module coding-image-gen/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-image-gen'
/** 伴随插件名称。 */
export const name = 'image-gen-invariant'
/** 不变量服务是安装依赖。 */
export const inject = ['invariants']
/** No runtime invariant: 图像与画布只写同一 Session 日志，校验在写入入口完成。 */
const install: InvariantInstaller = () => {}
/** @param ctx - 持有不变量服务的上下文。 @returns 注册的释放函数。 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
