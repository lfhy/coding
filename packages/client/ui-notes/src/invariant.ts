/** 笔记界面的包级不变量伴生入口。 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-notes'

/** 不变量伴生插件名。 */
export const name = 'client-ui-notes-invariant'
/** 注册所需的不变量服务。 */
export const inject = ['invariants']

/** No runtime invariant: 笔记读写与路径安全由文件库服务在 Host 侧验证，界面注册的释放由测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 注册笔记界面的包级归属。
 * @param ctx - 提供不变量服务的上下文。
 * @returns 注销句柄。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
