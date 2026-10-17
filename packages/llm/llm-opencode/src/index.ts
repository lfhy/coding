/**
 * Free 渠道插件：把本项目维护的免费模型注册成 harness 的一个原生 LLM 提供方路由
 * （`free`，显示名 `Free`）。
 *
 * 渠道名、端点、匿名凭据与模型目录都是包内事实（见 `channel.ts`），不挂载任何
 * 设置分节：设置 → 模型 里能直接看到这条渠道与它的模型，但没有改端点、换密钥、
 * 改名称或增删模型的入口，用户改不到连接事实。请求与官方 OpenCode CLI 同形——
 * 同一个 User-Agent、同一套按会话派生的关联头、同一个工具形状门——因此无需登录、
 * 无需注册即可使用该通道。接入更多免费上游见 `channel.ts` 的上游表。
 *
 * ```yaml
 * - id: llm-opencode
 *   name: 'coding-llm-opencode'
 * ```
 *
 * @module coding-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import { FreeChannelAdapter } from './adapter.ts'
import { PROVIDER_ID } from './channel.ts'

export { FreeChannelAdapter } from './adapter.ts'
export type { FreeChannelAdapterOptions } from './adapter.ts'
export {
  CHANNEL_NAME,
  CHANNEL_RETRY_POLICY,
  FREE_CHANNEL_MODELS,
  FREE_UPSTREAMS,
  freeChannelModel,
  PROVIDER_ID,
  REASONING_EFFORT_LEVELS,
  STREAM_IDLE_TIMEOUT_MS,
} from './channel.ts'
export type {
  FreeChannelModel,
  FreeUpstream,
  FreeUpstreamModel,
  ReasoningEffortLevel,
} from './channel.ts'
export { disguiseHeaders, deriveRequestIds, opencodeUserAgent } from './ids.ts'
export { ensureFreeLaneShape, FREE_LANE_GATE_TOOL_NAMES } from './free-lane.ts'

/** Cordis 插件名。 */
export const name = 'llm-opencode'
/** LLM 注册表是本插件唯一必需的服务。 */
export const inject = ['llm']

/**
 * 注册 Free 渠道。目录、端点与凭据都是包内事实，因此这里不安装设置分节，
 * 也没有随设置变化需要重建的注册级事实；路由本身随插件卸载撤销。
 * @param ctx - 持有适配器注册生命周期的插件上下文。
 * @returns 无返回值。
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER_ID], new FreeChannelAdapter({
    resolveAttachments: () => ctx.get('attachments'),
  }))
}
