/** `coding-file-library` 的包归属与持久域验证入口。@module coding-file-library/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-file-library'
export const name = 'file-library-invariant'
export const inject = ['invariants']
/** No runtime invariant: 持久记录由领域校验，本地文件身份在读取时重新检查。 */
const install: InvariantInstaller = () => {}
/**
 * 注册包不变量的所有权。
 * @param ctx - 已安装不变量服务的上下文。
 * @returns 取消注册的函数。
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
