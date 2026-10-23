/**
 * DeepSeek 渠道的出站传输：把渠道级选择解析成一次请求的 undici dispatcher。
 *
 * 选择属于渠道自己的设置分节（`llm-deepseek.outbound`），与代理池规则分开：
 * 渠道选择「内置代理池」时由插件在请求期向 `ctx.proxyPool` 取地址，池规则为
 * 直连或池服务缺席时回落直连。直连不注入 dispatcher；代理池与自定义代理按
 * 地址复用 `ProxyAgent`，避免每条请求新建连接池。
 *
 * 出站选择的类型与解析规则归 `coding-proxy-pool`：这里只保留渠道自己的
 * dispatcher 生命周期，`DeepSeekOutboundConfig` 是对共享 `OutboundConfig` 的
 * 重命名导出，供本包既有消费者继续使用。
 *
 * @module coding-llm-deepseek/outbound
 */

import { ProxyAgent } from 'undici'

export type { OutboundConfig as DeepSeekOutboundConfig } from 'coding-proxy-pool'

/** 一次请求实际使用的出站。 */
export type DeepSeekOutbound =
  | { kind: 'direct' }
  | { kind: 'proxy'; url: string }

/** 同地址复用同一个 ProxyAgent：连接池不随请求泄漏。 */
const agents = new Map<string, ProxyAgent>()

/**
 * 取或建一个代理地址的 dispatcher。
 * @param url - http(s) 代理地址。
 * @returns 该地址的 ProxyAgent。
 */
export function proxyDispatcher(url: string): ProxyAgent {
  const existing = agents.get(url)
  if (existing !== undefined) return existing
  const agent = new ProxyAgent({ uri: url })
  agents.set(url, agent)
  return agent
}

/**
 * 出站对应的 dispatcher；直连返回 undefined，fetch 因此保持默认传输。
 * @param outbound - 本次请求解析出的出站。
 * @returns 代理 dispatcher 或 undefined。
 */
export function dispatcherOf(outbound: DeepSeekOutbound): ProxyAgent | undefined {
  return outbound.kind === 'proxy' ? proxyDispatcher(outbound.url) : undefined
}
