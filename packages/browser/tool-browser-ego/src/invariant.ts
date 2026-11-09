/** 浏览器消费方的包级不变量登记；宿主资源归宿主服务检查。 @module coding-tool-browser-ego/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

/** 插件名称。 */
export const name = 'tool-browser-ego-invariant'
/** 不变量服务是登记时的必需依赖。 */
export const inject = ['invariants']

/** No runtime invariant: 工具注册与文件访问在各自执行边界复核。 */
const install: InvariantInstaller = () => {}

/**
 * 在诊断目录登记该包；会话权限在每次工具执行时判断。
 * @param ctx 拥有不变量登记服务的上下文。
 * @returns 注册项的释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('coding-tool-browser-ego', install))
