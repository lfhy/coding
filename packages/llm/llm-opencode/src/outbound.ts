/**
 * Free 渠道的出站路径切换：把一次请求的 HTTP 传输指到代理池或自定义代理。
 *
 * pi-ai 的 openai-completions 线协议不暴露自定义 fetch/dispatcher，OpenAI SDK
 * 又只认全局 `fetch`；因此这里按请求替换 undici 的全局 dispatcher（Node 的
 * 全局 fetch 即 undici），请求结束或失败时恢复原值。同一进程内并发请求会
 * 各自保存/恢复：后进入的请求恢复的是它进入时看到的 dispatcher，嵌套时最外
 * 层的直连语义不会被内层破坏——但如果两条代理请求真正并发，后者的 dispatcher
 * 会覆盖前者的；Free 渠道的请求串行度由 agent loop 保证，这里不为并发场景
 * 引入队列。
 *
 * @module coding-llm-opencode/outbound
 */

import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import type { OutboundMode } from './adapter.ts'

/** 已创建代理的缓存：同地址复用同一个 ProxyAgent，连接池不随请求泄漏。 */
const agents = new Map<string, ProxyAgent>()

/** 取（或建）一个地址的 ProxyAgent。 */
function agentOf(url: string): ProxyAgent {
  const existing = agents.get(url)
  if (existing !== undefined) return existing
  const agent = new ProxyAgent({ uri: url })
  agents.set(url, agent)
  return agent
}

/**
 * 把全局 HTTP 出站切到给定模式。
 * @param mode - 本次请求的出站模式；`pool` 与 `custom` 都带代理地址。
 * @returns 恢复原 dispatcher 的函数；无论请求成败都必须调用一次。
 */
export function applyOutbound(mode: OutboundMode): () => void {
  if (mode.kind === 'direct') return () => {}
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(agentOf(mode.url))
  let restored = false
  return () => {
    if (restored) return
    restored = true
    setGlobalDispatcher(previous)
  }
}
