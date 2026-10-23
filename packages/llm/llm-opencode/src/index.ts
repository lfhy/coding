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
 * 出站路径可经设置分节选择：直连（缺省）、代理池（`ctx.proxyPool` 的本地入站）
 * 或自定义代理地址。选择只影响传输，不改渠道目录与请求形状；类型与解析规则来自
 * `coding-proxy-pool` 的渠道级出站契约。
 *
 * ```yaml
 * - id: llm-opencode
 *   name: 'coding-llm-opencode'
 * ```
 *
 * @module coding-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import { OutboundConfigSchema, resolveOutboundURL } from 'coding-proxy-pool'
import type { OutboundConfig } from 'coding-proxy-pool'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { FreeChannelAdapter } from './adapter.ts'
import { PROVIDER_ID } from './channel.ts'
import type { OutboundMode } from './adapter.ts'

export { FreeChannelAdapter } from './adapter.ts'
export type { FreeChannelAdapterOptions, OutboundMode } from './adapter.ts'
export {
  AUTO_MODEL_CANDIDATES,
  AUTO_MODEL_ID,
  AUTO_MODEL_NAME,
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
export { isFailoverError, isFailoverCode, FAILOVER_CODES } from './stream.ts'

/** Cordis 插件名。 */
export const name = 'llm-opencode'
/** LLM 注册表是本插件必需的服务；代理池可选，缺席时选择内置池回落直连。 */
export const inject = ['llm']

/** Free 渠道出站选择的设置命名空间。 */
export const FREE_OUTBOUND_SETTINGS_NAMESPACE = settingsNamespace('llm-opencode')

/** 设置分节里可持久化的出站选择：共享契约的渠道级形态。 */
export type { OutboundConfig as FreeOutboundSettings } from 'coding-proxy-pool'

/**
 * 注册 Free 渠道并安装该渠道自己的出站选择分节。目录与凭据是包内事实；出站
 * 路径是渠道级用户设置（直连／内置代理池／自定义代理），经 `resolveOutbound`
 * 在每次请求时读取，设置变化不需要重建注册。
 *
 * 选择内置代理池时使用池自己的出站控制（`proxy-pool` 分节）：池为直连时
 * `proxyURL({ kind: 'pool' })` 返回 undefined，本渠道随之回落直连；池为自定义
 * 代理时返回池配置的地址；池服务缺席时同样按直连处理，不让请求失败。
 * @param ctx - 持有适配器注册生命周期的插件上下文。
 * @returns 无返回值。
 */
export function apply(ctx: Context): void {
  const entry: OutboundConfig = { mode: 'direct' }
  const outboundRef: { current: () => OutboundConfig } = { current: () => entry }
  installSettingsSection(ctx, FREE_OUTBOUND_SETTINGS_NAMESPACE, OutboundConfigSchema, entry, {
    setSource: (source) => { outboundRef.current = source },
    onChange: () => {},
  })
  ctx.llm.registerAdapter([PROVIDER_ID], new FreeChannelAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    // 出站逐请求解析：池服务缺席、池规则为直连或池前端未运行时都回落直连。
    resolveOutbound: () => {
      const settings = outboundRef.current()
      let url: string | undefined
      try {
        url = resolveOutboundURL(ctx.get('proxyPool'), settings)
      } catch {
        throw new Error('the Free channel custom outbound requires an http(s) proxy URL')
      }
      if (url === undefined) return { kind: 'direct' } satisfies OutboundMode
      if (settings.mode === 'custom') return { kind: 'custom', url } satisfies OutboundMode
      return { kind: 'pool', url } satisfies OutboundMode
    },
  }))
}
