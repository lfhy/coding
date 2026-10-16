/** macOS Computer Use 服务提供方：可访问性观察、语义元素动作、定向指针输入与截图产物。 @module @deepseek-ai/dsh-computer-use */

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import { MacOSComputerUseProvider } from './providers/macos.ts'

export { Config, readComputerUseConfig, resolveConfig } from './config.ts'
export type { ComputerUseConfig, ResolvedComputerUseConfig } from './config.ts'
export * from './errors.ts'
export * from './service.ts'
export * from './types.ts'
export type * from './backend.ts'

/**
 * 宿主层单例提供方。模型可见的 Skill、引导工具与执行工具属于
 * [`dsh-tool-computer-use`](../../tool-computer-use/README.md)，在 agent 层按预设装配；
 * 本包只持有跨会话共享的 helper 进程、观察缓存与租约。
 */
export default MacOSComputerUseProvider
