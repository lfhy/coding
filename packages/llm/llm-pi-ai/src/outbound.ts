/** 将渠道的出站选择解析为单次请求的 HTTP 传输。 */

import { LlmError } from 'coding-llm'
import { resolveOutboundURL, toProxyMode } from 'coding-proxy-pool'
import type { OutboundConfig, ProxyPoolService } from 'coding-proxy-pool'
import { ProxyAgent, fetch as proxyFetch } from 'undici'

const outboundModes = new Set<string>(['direct', 'pool', 'custom'] satisfies OutboundConfig['mode'][])

/**
 * 校验并复制一条渠道的出站配置。代理模式不接受可能升级到 WebSocket 的传输。
 * @param provider - 渠道路由，用于诊断。
 * @param selection - 原始渠道出站配置。
 * @param transport - 渠道配置的传输偏好。
 * @returns 与原始配置分离的出站选择，默认直连。
 */
export function resolveOutboundConfig(
  provider: string,
  selection: OutboundConfig | undefined,
  transport: string | undefined,
): OutboundConfig {
  const config = selection ?? { mode: 'direct' }
  if (!outboundModes.has(config.mode)) {
    throw new TypeError(`llm-pi-ai: provider "${provider}" outbound.mode must be direct, pool, or custom`)
  }
  if (config.mode !== 'direct' && transport !== undefined && transport !== 'sse') {
    throw new TypeError(`llm-pi-ai: provider "${provider}" outbound requires transport "sse" or no transport override`)
  }
  if (config.mode !== 'custom') return { mode: config.mode }
  try {
    const mode = toProxyMode(config)
    if (mode.kind === 'custom') return { mode: 'custom', customUrl: new URL(mode.url).href }
  } catch {
    // 不在错误消息里回显可能带代理凭据的 URL。
  }
  throw new TypeError(`llm-pi-ai: provider "${provider}" outbound.customUrl must be a valid HTTP(S) proxy URL`)
}

/**
 * 请求开始时解析代理，并把连接池绑定到此次传输；直连时不注入传输。
 * @param provider - 渠道路由，用于诊断。
 * @param selection - 与请求配置同代取得的渠道选择。
 * @param pool - 当前代理池服务，选用代理池时必须存在。
 * @returns 请求专用的代理 Fetch，或显式直连时的 undefined。
 */
export function outboundFetch(
  provider: string,
  selection: Readonly<OutboundConfig>,
  pool: Pick<ProxyPoolService, 'proxyURL'> | undefined,
): typeof fetch | undefined {
  if (selection.mode === 'pool' && pool === undefined) {
    throw new LlmError(`llm-pi-ai: provider "${provider}" selected an unavailable proxy pool`, 'TRANSPORT')
  }
  const url = resolveOutboundURL(pool, selection)
  if (url === undefined) return undefined
  let dispatcher = agents.get(url)
  if (dispatcher === undefined) {
    dispatcher = new ProxyAgent({ uri: url })
    agents.set(url, dispatcher)
  }
  // 独立 Undici 的 Fetch 和 dispatcher 必须来自同一版本。
  return (input, init) => proxyFetch(input as Parameters<typeof proxyFetch>[0], {
    ...init as Parameters<typeof proxyFetch>[1], dispatcher,
  }) as unknown as Promise<Response>
}

const agents = new Map<string, ProxyAgent>()

/**
 * HTTP 流不跟随重定向，避免将凭据或自定义标头转发给新目标。
 * @param requestFetch - 绑定了代理的 Fetch；缺省使用未包装的直连 Fetch。
 * @returns 对重定向一律报错的传输函数。
 */
export function streamFetch(requestFetch: typeof fetch | undefined): typeof fetch {
  const underlying = requestFetch ?? globalThis.fetch
  return (input, init) => underlying(input, { ...init, redirect: 'error' })
}
