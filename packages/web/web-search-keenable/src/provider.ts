/**
 * 通过 Keenable 的 MCP 端点（JSON-RPC `tools/call` → `search_web_pages`）检索网页。
 *
 * 无密钥时使用 Keenable 的匿名额度，配置密钥后请求头带 `Authorization: Bearer`，
 * 由 Keenable 据此提高额度。MCP 请求形状、结果文本格式与错误分层参考 MIT 许可的
 * `omdsh-dev/dsh-free-search`（`lib/index.js` 的 `searchKeenableMCP` 与
 * `lib/mcp_adapter.js`），按本仓 provider 形态重写。
 * @module coding-web-search-keenable/provider
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'

/** 用户可选的稳定后端 id。 */
export const KEENABLE_PROVIDER_ID = 'keenable'
/** Keenable 的 MCP 端点；可用 `baseURL` 覆盖为自建网关。 */
export const KEENABLE_DEFAULT_BASE_URL = 'https://api.keenable.ai/mcp'
/** 没有请求上限时与面向模型的搜索工具一致的默认条数。 */
export const KEENABLE_DEFAULT_MAX_RESULTS = 10
/** 单次搜索最多返回的来源条数，也是 `maxResults` 的上限。 */
const MAX_SOURCES = 20
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const MAX_DIAGNOSTIC_CHARS = 200
/** 单次 MCP 请求的超时毫秒数；超时按取消处理。 */
const REQUEST_TIMEOUT_MS = 12_000
/** 出站归属标识；MCP 网关常按 UA 区分客户端。 */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** 本提供方在每次搜索开始时读取的配置来源。 */
export interface KeenableSearchProviderOptions {
  /** 本次搜索的密钥；空串表示匿名访问。 */
  /** 每次搜索开始时解析的密钥；返回空即按匿名额度请求。 */
  resolveApiKey?: () => string | Promise<string | undefined>
  /** 本次搜索的 MCP 端点；必须是通过校验的 HTTPS 地址。 */
  resolveBaseURL?: () => string
  /** 本次搜索的出站地址（提供方选择 + 代理池规则）；返回 `undefined` 即直连。 */
  resolveProxyURL?: () => string | undefined
}

/**
 * 校验 MCP 端点：只接受绝对 HTTPS 地址，且不得携带 URL 用户信息、查询串或片段，
 * 避免把 `Authorization` 头发给未预期的目标或绕过网关路由。
 * @param raw - 候选端点地址。
 * @returns 地址可用于承载密钥时为 true。
 */
export function isValidBaseURL(raw: string): boolean {
  try {
    const url = new URL(raw)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1]
    return url.protocol === 'https:' && url.hostname.length > 0
      && authority !== undefined && !authority.includes('@')
      && url.username === '' && url.password === ''
      && url.search === '' && url.hash === ''
      && raw.trim() === raw && raw.length <= MAX_URL_LENGTH
  } catch {
    return false
  }
}

/**
 * 校验代理地址；允许本机代理，但拒绝可能将明文凭据写进设置的 URL 成分。
 * @param raw - 候选 HTTP(S) 前向代理 URL。
 * @returns 地址可用于代理连接时为 true。
 */
export function isValidProxyURL(raw: string): boolean {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0) return false
    const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1]
    return raw.trim() === raw && authority !== undefined && !authority.includes('@')
      && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

/**
 * 归一化并校验结果 URL：仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的绝对地址。
 * @param raw - 搜索结果里的 URL 字段。
 * @returns 可引用的 URL；不可用时为 `undefined`。
 */
export function citationUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.href.length > MAX_URL_LENGTH) return undefined
  return url.href
}

/** 判断 JSON 解析出的值是否是普通对象（排除数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把诊断里可能出现的任意 JSON 值转成字符串，避免 `String()` 落到 `[object Object]`。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** 截断诊断细节，避免把整个响应体写进错误消息。 */
function clip(text: string): string {
  return text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : text
}

/** 解析一段文本里的 JSON 对象；不是 JSON 对象时返回 `undefined`。 */
function parseObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

/**
 * 解析 MCP 响应体：先按纯 JSON 解析，失败再按 SSE 帧提取。
 *
 * SSE 帧按空行切事件、事件内以 `\n` 拼接 `data:` 行；同时兼容“每行独立一个完整
 * JSON-RPC 信封”的服务端实现。多种候选里优先带 `result`／`error` 的信封。
 * @param rawText - 有字节上限的响应体。
 * @returns JSON-RPC 信封；既不是 JSON 也不是 SSE 时返回 `undefined`。
 */
export function parseMcpResponseText(rawText: string): Record<string, unknown> | undefined {
  if (rawText.length === 0) return undefined
  const direct = parseObject(rawText)
  if (direct !== undefined) return direct
  let fallback: Record<string, unknown> | undefined
  for (const event of rawText.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = []
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    // 规范要求同一事件的多条 data 行以换行拼接后再解析；没有空行分隔的实现每行
    // 都是完整信封，因此单独的行也作为候选，二者取先解析出的有效信封。
    for (const payload of dataLines.length > 1 ? [dataLines.join('\n'), ...dataLines] : dataLines) {
      const parsed = parseObject(payload)
      if (parsed === undefined) continue
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed
      fallback ??= parsed
    }
  }
  return fallback
}

/** 取 `CallToolResult.content` 里的 text 块正文；非 text 块与缺失的 content 都跳过。 */
function mcpContentTexts(result: Record<string, unknown>): string[] {
  const content = result.content
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const item of content as readonly unknown[]) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue
    texts.push(item.text)
  }
  return texts
}

/**
 * 逐层校验 MCP 信封并返回 `tools/call` 的结果对象。
 *
 * 非 2xx 由调用方先行处理；这里区分三类可读失败：响应体既不是 JSON 也不是 SSE、
 * JSON-RPC 层 `error`、工具层 `isError`。任何失败都整体抛错，不返回部分结果。
 * @param rawText - 有字节上限的响应体。
 * @param label - 错误消息前缀（本包固定为提供方名称）。
 * @returns `CallToolResult` 形状的结果对象。
 * @throws WebError `WEB_PROVIDER_ERROR`，消息点名失败层级与原始细节片段。
 */
function readMcpResult(rawText: string, label: string): Record<string, unknown> {
  const envelope = parseMcpResponseText(rawText)
  if (envelope === undefined) {
    throw new WebError(`${label} MCP response is not valid JSON or SSE: ${clip(rawText)}`, 'WEB_PROVIDER_ERROR')
  }
  const error = envelope.error
  if (isRecord(error)) {
    const code = error.code === undefined ? '?' : textOf(error.code)
    const message = error.message === undefined ? textOf(error) : textOf(error.message)
    throw new WebError(`${label} MCP error ${code}: ${clip(message)}`, 'WEB_PROVIDER_ERROR')
  }
  const result = envelope.result
  if (!isRecord(result)) {
    throw new WebError(`${label} MCP result missing or malformed: ${clip(textOf(envelope))}`, 'WEB_PROVIDER_ERROR')
  }
  if (result.isError === true) {
    throw new WebError(`${label} MCP tool error: ${clip(mcpContentTexts(result).join('\n'))}`, 'WEB_PROVIDER_ERROR')
  }
  return result
}

/** 从一段文本里解析 `results[]`；不是带结果数组的 JSON 时返回 `undefined`。 */
function jsonResults(text: string): readonly unknown[] | undefined {
  const parsed = parseObject(text)
  if (parsed === undefined) return undefined
  const results = parsed.results
  return Array.isArray(results) ? results as readonly unknown[] : undefined
}

/** 保留非空文本并截断到给定长度，供模型可见字段使用。 */
function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text.slice(0, maxChars)
}

/** 只保留日期形态的发布时间，过滤 MCP 文本里的 `N/A` 之类占位符。 */
function publishedDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : undefined
}

/** 把一条记录映射成来源；缺 URL 或 URL 不安全时返回 `undefined`。 */
function mapSource(source: Readonly<Record<string, unknown>>): WebSearchSource | undefined {
  const url = citationUrl(source.url)
  if (url === undefined) return undefined
  const title = boundedText(source.title, MAX_TITLE_CHARS)
  const snippet = boundedText(source.snippet ?? source.description, MAX_SNIPPET_CHARS)
  const published = publishedDate(source.published_at ?? source.publishedAt ?? source.published)
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...published === undefined ? {} : { publishedAt: published },
  }
}

/** 映射 JSON `results[]`，按 URL 去重并保持服务端顺序。 */
function mapJsonResults(results: readonly unknown[]): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const entry of results) {
    if (!isRecord(entry)) continue
    const source = mapSource(entry)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return sources
}

/**
 * 解析 Keenable MCP 的文本结果：`Title:`／`URL:`／`Published:`／`Snippets:` 分块。
 * 这是参考实现使用的原生格式；无 `URL:` 的块与重复 URL 跳过。
 * @param text - 所有 text 块拼接后的正文。
 * @returns 归一化来源列表。
 */
export function textBlockSources(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const block of text.split(/\n(?=Title:)/)) {
    const url = citationUrl(/^URL: (\S+)$/m.exec(block)?.[1])
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = boundedText(/^Title: (.+)$/m.exec(block)?.[1], MAX_TITLE_CHARS)
    const published = publishedDate(/^Published: (.+)$/m.exec(block)?.[1] ?? /^Acquired: (.+)$/m.exec(block)?.[1])
    const snippetLines = block.split(/^Snippets:$/m)[1]?.split('\n').filter(line => line.trim().length > 0) ?? []
    const snippet = boundedText(snippetLines.slice(0, 3).join(' '), MAX_SNIPPET_CHARS)
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...published === undefined ? {} : { publishedAt: published },
    })
  }
  return sources
}

/**
 * 把一次 MCP 响应解析成 Web 搜索词汇。
 *
 * 优先接受 JSON `results[]`（`snippet` 或 `description`），否则解析参考实现使用的
 * 文本分块格式；同一 URL 只返回一次，条数按调用方预算截断，重试与截断语义由
 * `ctx.web` 保留。
 * @param rawText - 有字节上限的响应体。
 * @param maxResults - 调用方的条数预算。
 * @returns 归一化来源；服务端没有结果时是空列表。
 */
export function parseKeenableResult(rawText: string, maxResults: number): WebSearchResult {
  const result = readMcpResult(rawText, 'Keenable')
  const texts = mcpContentTexts(result)
  const limit = Math.max(1, Math.min(maxResults, MAX_SOURCES))
  for (const text of texts) {
    const results = jsonResults(text)
    if (results !== undefined) return { sources: mapJsonResults(results).slice(0, limit), truncated: false }
  }
  return { sources: textBlockSources(texts.join('\n')).slice(0, limit), truncated: false }
}

/** 用 undici 的响应类型读取有字节上限的正文；直连时也接受原生 `Response`。 */
async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('Keenable returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('Keenable response exceeds the size limit', 'WEB_PROVIDER_ERROR')
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    complete = true
    return text
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Keenable MCP 搜索后端；匿名可用，配置密钥后提额。跳转不跟随，请求与结果均有界。 */
export class KeenableSearchProvider implements WebSearchProvider {
  readonly id = KEENABLE_PROVIDER_ID

  /**
   * @param options - 每次搜索开始时读取的密钥、端点与出站解析器；全部省略时匿名直连公共端点。
   */
  constructor(private readonly options: KeenableSearchProviderOptions = {}) {}

  /** 端点可用即可运行：匿名额度不依赖密钥，因此不做网络探测。 */
  available(): boolean {
    return isValidBaseURL(this.options.resolveBaseURL?.() ?? KEENABLE_DEFAULT_BASE_URL)
  }

  /**
   * 调用一次 Keenable MCP `tools/call`。
   * @param request - 一个搜索词与可选的 `maxResults`。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源。
   * @throws WebError `WEB_ABORTED`（取消或 12 秒超时）或 `WEB_PROVIDER_ERROR`（端点、协议、响应失败）。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('Keenable query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    const baseURL = this.options.resolveBaseURL?.() ?? KEENABLE_DEFAULT_BASE_URL
    if (!isValidBaseURL(baseURL)) {
      throw new WebError('Keenable baseURL must be an HTTPS URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    const apiKey = ((await this.options.resolveApiKey?.()) ?? '').trim()
    // 出站地址由共享契约解析（提供方选择 + 池规则）；直连时保留原生 fetch 传输。
    const proxyURL = this.options.resolveProxyURL?.()
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    const controller = new AbortController()
    // 单次请求 12 秒超时；超时与调用方取消统一映射为 WEB_ABORTED。
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    let bodyConsumed = false
    try {
      const options = {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'user-agent': USER_AGENT,
          ...apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: 'search_web_pages', arguments: { query: request.query } },
        }),
        signal: controller.signal,
      } as const
      const response = dispatcher === undefined
        ? await fetch(baseURL, options)
        : await undiciFetch(baseURL, { ...options, dispatcher })
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? ' - check the Keenable API key' : ''
        throw new WebError(`Keenable MCP error (HTTP ${String(response.status)})${hint}`, 'WEB_PROVIDER_ERROR')
      }
      const rawText = await readBounded(response)
      bodyConsumed = true
      return parseKeenableResult(rawText, request.maxResults ?? KEENABLE_DEFAULT_MAX_RESULTS)
    } catch (error: unknown) {
      if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('Keenable search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('Keenable search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；destroy 立即断开。
      if (!bodyConsumed || signal?.aborted === true) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
