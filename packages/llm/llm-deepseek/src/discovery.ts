/** 将既有 DeepSeek 的模型清单 URL 接到通用端点探测；凭据只留在原端点。 */
import { LlmError } from 'coding-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from 'coding-llm'
import { queryModelListing } from 'coding-llm-pi-ai'
import type { DeepSeekConnectionOptions } from './adapter.ts'
import { fetchForOutbound } from './outbound.ts'
import type { DeepSeekOutbound, DeepSeekOutboundConfig } from './outbound.ts'

function endpoint(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LlmError('Model discovery needs a valid HTTP(S) baseURL', 'INVALID_DISCOVERY')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || /[?#\u0000-\u001f\u007f]/.test(raw) || raw !== raw.trim()) {
    throw new LlmError('Model discovery baseURL must be HTTP(S) without credentials, query, or fragment', 'INVALID_DISCOVERY')
  }
  return url
}

/**
 * 读取草稿端点的模型清单；即使会话配置了其他协议，此存量渠道仍使用 OpenAI 兼容清单。
 * @param request - 草稿地址、可选临时密钥与取消信号。
 * @param connection - 同一代已保存端点、凭据引用与出站。
 * @param resolveApiKey - 从该快照解析凭据，只用于原端点。
 * @param resolveOutbound - 渠道出站的解析钩子；缺省按直连。
 * @returns 端点报告的有效模型条目；草稿和结果不写入设置。
 */
export function discoverModels(
  request: LlmModelDiscoveryRequest,
  connection: DeepSeekConnectionOptions,
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>,
  resolveOutbound?: (selection: DeepSeekOutboundConfig) => DeepSeekOutbound,
): Promise<readonly LlmDiscoveredModel[]> {
  const base = endpoint(request.baseURL ?? connection.baseURL)
  const stored = endpoint(connection.baseURL)
  const path = base.pathname.replace(/\/+$/, '')
  // 公共 API 的对话端点位于根路径，模型列表则位于 /v1/models。
  const prefix = base.origin === 'https://api.deepseek.com' && path === '' ? '/v1' : path
  const requestFetch = fetchForOutbound(resolveOutbound?.(connection.outbound) ?? { kind: 'direct' })
  return queryModelListing(`${base.origin}${prefix}/models`, request, connection.userAgent,
    base.href === stored.href ? () => resolveApiKey(connection) : undefined, requestFetch)
}
