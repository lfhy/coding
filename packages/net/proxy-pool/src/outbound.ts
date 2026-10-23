/**
 * 渠道级出站契约：模型渠道与搜索提供方各自保存一份「直连／内置代理池／自定义代理」
 * 的选择，并语义统一地解析成一次请求的代理地址。
 *
 * 选择属于消费方（渠道设置分节、搜索提供方设置分节），规则属于池：消费方选 `pool`
 * 时用的是**池自己的出站规则**——池为直连则回落直连，池为自定义代理则用池配置的
 * 地址，池为本地池则用本地入站地址。消费方选 `custom` 时只用自己保存的地址，不受
 * 池规则影响。池服务缺席时按直连处理，不让请求失败。
 *
 * @module coding-proxy-pool/outbound
 */

import z from '@deepseek-ai/schemastery'
import type { ProxyMode, ProxyPoolService } from './index.ts'

/** 渠道级出站的三种选择。 */
export type OutboundMode = 'direct' | 'pool' | 'custom'

/**
 * 消费方保存的出站选择。
 *
 * 这份选择由消费方（模型渠道、搜索提供方）自己持有并持久化，池只负责把它翻译成
 * 实际地址；`pool` 表示「按池自己的出站规则」而不是「一定经本地入站」。
 */
export interface OutboundConfig {
  /** 直连、内置代理池或自定义代理；缺省为直连。 */
  mode: OutboundMode
  /** `custom` 模式的 http(s) 代理地址；其余模式省略。 */
  customUrl?: string
}

/** 渠道级出站选择的 schema，与池出站分节同形：`mode` 缺省 `direct`。 */
export const OutboundConfigSchema: z<OutboundConfig> = z.object({
  mode: z.union([z.const('direct'), z.const('pool'), z.const('custom')]).default('direct'),
  customUrl: z.string(),
})

/**
 * 把消费方的出站选择映射成池的出站模式。
 * @param config - 消费方保存的出站选择。
 * @returns 供 `ProxyPoolService.proxyURL` 使用的池模式。
 * @throws 当 `custom` 缺少 http(s) 代理地址时；错误信息不点名具体消费方，由调用方
 *   在自身诊断里补充上下文。
 */
export function toProxyMode(config: OutboundConfig): ProxyMode {
  if (config.mode === 'direct') return { kind: 'direct' }
  if (config.mode === 'pool') return { kind: 'pool' }
  if (config.customUrl === undefined || !/^https?:\/\//.test(config.customUrl)) {
    throw new Error('custom outbound requires an http(s) proxy URL')
  }
  return { kind: 'custom', url: config.customUrl }
}

/**
 * 校验消费方自己的出站选择，失败时抛出点名叫该消费方配置项的 `TypeError`。
 *
 * 每个消费方在设置写入或装载时调用它一次：`custom` 缺地址由共享规则拒绝，各消费方
 * 额外的地址约束（例如搜索提供方要求代理 URL 不携带凭据、查询串或片段）经
 * `isSafeCustomUrl` 传入，避免把校验规则抄成多份。
 * @param owner - 消费方配置前缀，例如 `web-search-tavily.outbound`。
 * @param config - 消费方的出站选择；`undefined` 视为直连。
 * @param isSafeCustomUrl - 消费方对 `custom` 地址的额外约束；省略时只要求 http(s)。
 * @throws 当选择不合法时；错误信息点名 `owner`。
 */
export function assertUsableOutbound(
  owner: string,
  config: OutboundConfig | undefined,
  isSafeCustomUrl?: (url: string) => boolean,
): void {
  try {
    toProxyMode(config ?? { mode: 'direct' })
  } catch (error) {
    throw new TypeError(`${owner}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const customUrl = config?.mode === 'custom' ? config.customUrl : undefined
  if (customUrl !== undefined && isSafeCustomUrl !== undefined && !isSafeCustomUrl(customUrl)) {
    throw new TypeError(`${owner}.customUrl must be an HTTP(S) URL without credentials, query, or fragment`)
  }
}

/**
 * 解析一次请求实际使用的代理地址。
 *
 * 池缺席即回落直连；`direct` 返回 `undefined`；`custom` 返回消费方自己的地址且不受
 * 池规则影响；`pool` 返回 `pool.proxyURL({ kind: 'pool' })` 的结果（池为直连规则时
 * 仍是 `undefined`，即回落直连）。
 * @param pool - 当前进程的池服务；未装配时传入 `undefined`。
 * @param config - 消费方本次请求的出站选择。
 * @returns 可注入 undici `ProxyAgent` 的地址，或直连时的 `undefined`。
 * @throws 当 `custom` 缺少 http(s) 代理地址时（见 {@link toProxyMode}）。
 */
export function resolveOutboundURL(
  pool: Pick<ProxyPoolService, 'proxyURL'> | undefined,
  config: OutboundConfig,
): string | undefined {
  const mode = toProxyMode(config)
  if (mode.kind === 'custom') return mode.url
  if (mode.kind === 'direct' || pool === undefined) return undefined
  return pool.proxyURL(mode)
}
