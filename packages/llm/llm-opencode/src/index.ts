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
 * 或自定义代理地址。选择只影响传输，不改渠道目录与请求形状。
 *
 * ```yaml
 * - id: llm-opencode
 *   name: 'coding-llm-opencode'
 * ```
 *
 * @module coding-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProxyPoolService } from 'coding-proxy-pool'
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
/** LLM 注册表是本插件必需的服务；代理池可选，缺席时代理池模式给出明确错误。 */
export const inject = ['llm']

/** Free 渠道出站选择的设置命名空间。 */
export const FREE_OUTBOUND_SETTINGS_NAMESPACE = settingsNamespace('llm-opencode')

/** 设置分节里可持久化的出站选择。 */
export interface FreeOutboundSettings {
  /** 出站模式：`direct`（缺省）、`pool` 或 `custom`。 */
  mode: 'direct' | 'pool' | 'custom'
  /** 自定义模式的代理地址（`http://` 开头）。 */
  customUrl?: string
}

/** 出站设置的 schema；自定义地址只在 custom 模式下有意义。 */
const FREE_OUTBOUND_SCHEMA: z<FreeOutboundSettings> = z.object({
  mode: z.union([z.const('direct'), z.const('pool'), z.const('custom')]).required(),
  customUrl: z.string(),
})

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
  const entry: FreeOutboundSettings = { mode: 'direct' }
  const outboundRef: { current: () => FreeOutboundSettings } = { current: () => entry }
  installSettingsSection(ctx, FREE_OUTBOUND_SETTINGS_NAMESPACE, FREE_OUTBOUND_SCHEMA, entry, {
    setSource: (source) => { outboundRef.current = source },
    onChange: () => {},
  })
  ctx.llm.registerAdapter([PROVIDER_ID], new FreeChannelAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    resolveOutbound: () => {
      const settings = outboundRef.current()
      if (settings.mode === 'pool') {
        const pool: ProxyPoolService | undefined = ctx.get('proxyPool')
        const url = pool?.proxyURL({ kind: 'pool' })
        // 池规则为直连、池前端未运行或池服务缺席：渠道选择内置池也走直连。
        if (url === undefined) return { kind: 'direct' } satisfies OutboundMode
        return { kind: 'pool', url } satisfies OutboundMode
      }
      if (settings.mode === 'custom') {
        if (settings.customUrl === undefined || !/^https?:\/\//.test(settings.customUrl)) {
          throw new Error('the Free channel custom outbound requires an http(s) proxy URL')
        }
        return { kind: 'custom', url: settings.customUrl } satisfies OutboundMode
      }
      return { kind: 'direct' } satisfies OutboundMode
    },
  }))
}
