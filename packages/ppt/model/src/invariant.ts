/**
 * `coding-ppt-model` 的包级不变量伴生插件。
 * @module coding-ppt-model/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-ppt-model'

/** Cordis 伴生插件的名字。 */
export const name = 'ppt-model-invariant'
/** 认领包归属前需要的服务。 */
export const inject = ['invariants']

/**
 * 没有运行时不变量要检查：本包只有纯函数式的模型校验，输入即输出，
 * 不存在需要跨事件核对的状态。
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
