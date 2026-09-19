/** Host 事实与进程适配器的测试 seam；生产环境保留空默认值。 */

import type { OpenInAppInternals } from './resolver.ts'

/** 插件激活前供源码级测试注入的 catalog 事实。 */
export const internals: { catalog: OpenInAppInternals } = { catalog: {} }
