/**
 * 通过 Parallel 的官方 MCP 端点（JSON-RPC `tools/call` → `web_search`）检索网页。
 *
 * 无密钥时使用安装包内固定的匿名 `session_id` 走免费额度，配置密钥后请求头带
 * `Authorization: Bearer` 提额。请求形状与结果解析参考 MIT 许可的
 * `omdsh-dev/dsh-free-search`（`lib/index.js` 的 `searchParallelMCP` 与
 * `lib/mcp_adapter.js`），按本仓 provider 形态重写。
 * @module coding-web-search-parallel/provider
 */

import { randomBytes } from 'node:crypto'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'

/** 用户可选的稳定后端 id。 */
export const PARALLEL_PROVIDER_ID = 'parallel'
/** Parallel 的 MCP 端点；可用 `baseURL` 覆盖为自建网关。 */
export const PARALLEL_DEFAULT_BASE_URL = 'https://search.parallel.ai/mcp'
/** 没有请求上限时与面向模型的搜索工具一致的默认条数。 */
export const PARALLEL_DEFAULT_MAX_RESULTS = 10
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
export interface ParallelSearchProviderOptions {
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

/** 只保留日期形态的发布时间，过滤 MCP 结果里的占位符。 */
function publishedDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : undefined
}

/**
 * 取一条结果的摘要：优先非空 `excerpts[]` 元素（参考实现的字段），退回
 * `snippet`／`description`。
 */
function snippetOf(source: Readonly<Record<string, unknown>>): string | undefined {
  const excerpts = source.excerpts
  if (Array.isArray(excerpts)) {
    for (const excerpt of excerpts as readonly unknown[]) {
      const text = boundedText(excerpt, MAX_SNIPPET_CHARS)
      if (text !== undefined) return text
    }
  }
  return boundedText(source.snippet ?? source.description, MAX_SNIPPET_CHARS)
}

/** 把一条记录映射成来源；缺 URL 或 URL 不安全时返回 `undefined`。 */
function mapSource(source: Readonly<Record<string, unknown>>): WebSearchSource | undefined {
  const url = citationUrl(source.url)
  if (url === undefined) return undefined
  const title = boundedText(source.title, MAX_TITLE_CHARS)
  const snippet = snippetOf(source)
  const published = publishedDate(source.publish_date ?? source.publishedAt ?? source.published)
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
 * 把一次 MCP 响应解析成 Web 搜索词汇。
 *
 * MCP 的 `web_search` 工具以 text 块承载 JSON `{results: [...]}`；没有 text 块或
 * 没有任何块带 `results[]` 时整体失败，而不是把不可用响应当成 0 结果。
 * @param rawText - 有字节上限的响应体。
 * @param maxResults - 调用方的条数预算。
 * @returns 归一化来源。
 * @throws WebError `WEB_PROVIDER_ERROR`，消息说明响应里没有可解析的搜索结果。
 */
export function parseParallelResult(rawText: string, maxResults: number): WebSearchResult {
  const result = readMcpResult(rawText, 'Parallel')
  const limit = Math.max(1, Math.min(maxResults, MAX_SOURCES))
  for (const text of mcpContentTexts(result)) {
    const results = jsonResults(text)
    if (results !== undefined) return { sources: mapJsonResults(results).slice(0, limit), truncated: false }
  }
  throw new WebError('Parallel MCP response has no parsable search results', 'WEB_PROVIDER_ERROR')
}

/** 用 undici 的响应类型读取有字节上限的正文；直连时也接受原生 `Response`。 */
async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('Parallel returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('Parallel response exceeds the size limit', 'WEB_PROVIDER_ERROR')
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

/** Parallel MCP 搜索后端；匿名额度可用，配置密钥后提额。跳转不跟随，请求与结果均有界。 */
export class ParallelSearchProvider implements WebSearchProvider {
  readonly id = PARALLEL_PROVIDER_ID
  /** 匿名额度会话标识：每个提供方实例生成一次，服务端据此分配免费配额。 */
  private readonly sessionId = randomBytes(16).toString('hex')

  /**
   * @param options - 每次搜索开始时读取的密钥、端点与出站解析器；全部省略时匿名直连公共端点。
   */
  constructor(private readonly options: ParallelSearchProviderOptions = {}) {}

  /** 端点可用即可运行：匿名额度不依赖密钥，因此不做网络探测。 */
  available(): boolean {
    return isValidBaseURL(this.options.resolveBaseURL?.() ?? PARALLEL_DEFAULT_BASE_URL)
  }

  /**
   * 调用一次 Parallel MCP `tools/call`。
   * @param request - 一个搜索词与可选的 `maxResults`。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源。
   * @throws WebError `WEB_ABORTED`（取消或 12 秒超时）或 `WEB_PROVIDER_ERROR`（端点、协议、响应失败）。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('Parallel query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    const baseURL = this.options.resolveBaseURL?.() ?? PARALLEL_DEFAULT_BASE_URL
    if (!isValidBaseURL(baseURL)) {
      throw new WebError('Parallel baseURL must be an HTTPS URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
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
          params: {
            name: 'web_search',
            arguments: { objective: request.query, search_queries: [request.query], session_id: this.sessionId },
          },
        }),
        signal: controller.signal,
      } as const
      const response = dispatcher === undefined
        ? await fetch(baseURL, options)
        : await undiciFetch(baseURL, { ...options, dispatcher })
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? ' - check the Parallel API key' : ''
        throw new WebError(`Parallel MCP error (HTTP ${String(response.status)})${hint}`, 'WEB_PROVIDER_ERROR')
      }
      const rawText = await readBounded(response)
      bodyConsumed = true
      return parseParallelResult(rawText, request.maxResults ?? PARALLEL_DEFAULT_MAX_RESULTS)
    } catch (error: unknown) {
      if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('Parallel search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('Parallel search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；destroy 立即断开。
      if (!bodyConsumed || signal?.aborted === true) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
