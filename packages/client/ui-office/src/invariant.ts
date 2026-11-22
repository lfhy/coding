/** `coding-client-ui-office` 的包级不变量伴生插件。 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-client-ui-office'

/** Cordis 伴生插件名称。 */
export const name = 'client-ui-office-invariant'
/** 注册依赖的不变量服务。 */
export const inject = ['invariants']

/** No runtime invariant: 编辑草稿和请求只在浏览器内使用；修订保护由文件库执行，时序由本包测试覆盖。 */
const install: InvariantInstaller = () => {}

/**
 * 安装本包的不变量声明。
 * @param ctx - 提供不变量注册表的上下文。
 * @returns 用于卸载该声明的回调。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
