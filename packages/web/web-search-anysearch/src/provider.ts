/** AnySearch 结构化 JSON 搜索端点：匿名免费额度可用，配置 Bearer 密钥时提额。请求形状参考 MIT 许可的 omdsh-dev/dsh-free-search `searchAnysearch`，按本仓 provider 形态重写。 */
import { isIP } from 'node:net'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'
import type { OutboundConfig } from 'coding-proxy-pool'

/** 用户可选的稳定后端 id。 */
export const ANYSEARCH_PROVIDER_ID = 'anysearch'
/** AnySearch 官方端点基址；请求路径固定追加 `/v1/search`。 */
export const ANYSEARCH_DEFAULT_BASE_URL = 'https://api.anysearch.com'
const SEARCH_PATH = '/v1/search'
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_SOURCES = 20
/** 调用方未给条数时的默认上限；也直接作为端点的 `max_results`。 */
const DEFAULT_MAX_RESULTS = 10
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const MAX_ERROR_DETAIL_CHARS = 500
/** 单次搜索（含密钥被拒后的匿名重试）的超时毫秒数；超时按取消处理。 */
const REQUEST_TIMEOUT_MS = 12_000

/**
 * 校验代理地址；允许本机代理，但拒绝可能将明文凭据写进设置的 URL 成分。
 * @param raw - 候选 HTTP(S) 前向代理 URL。
 * @returns 地址可用于代理连接时为 true。
 */
export function isValidProxyURL(raw: string): boolean {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return false
    const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1]
    return raw.trim() === raw && authority !== undefined && !authority.includes('@')
      && !url.href.includes('?') && !url.href.includes('#')
  } catch {
    return false
  }
}

/**
 * 拒绝内网字面地址和会改变密钥投递目标解释的 URL 部分。
 * @param raw - 候选 AnySearch HTTPS 端点基址。
 * @returns 端点可安全接收本提供方密钥时为 true。
 */
export function isSafeBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const authority = raw.match(/^https?:[/\\]+([^/\\?#]*)/iu)?.[1]
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    return url.protocol === 'https:' && hostname.includes('.') && !hostname.split('.').includes('')
      && isIP(hostname.replace(/^\[|\]$/g, '')) === 0
      && hostname !== 'localhost' && !hostname.endsWith('.localhost')
      && !hostname.endsWith('.local') && !hostname.endsWith('.internal')
      && authority !== undefined && !authority.includes('@')
      && !url.username && !url.password && !raw.includes('?') && !raw.includes('#')
  } catch {
    return false
  }
}

/** 出站选择是否可用于一次搜索；自定义地址缺地址或形态不安全时返回 false。 */

/** 取消判定走函数调用：避免入口处的提前返回把 `signal.aborted` 收窄成常量。 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一化并校验端点返回的结果地址：仅保留 HTTP(S)、无 URL 用户信息且不超过 2048
 * 字符的绝对地址，并把会提前闭合 Markdown 链接目标的 `()`／`<>` 转义。
 * @param value - 结果条目的 `url` 字段。
 * @returns 可引用的 URL；不可用时为 `undefined`。
 */
function sourceUrl(value: string): string | undefined {
  try {
    if (value.includes('\\') || /[\s\p{Cc}]/u.test(value)) return undefined
    const url = new URL(value)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1]
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname.length === 0
      || authority === undefined || authority.includes('@') || url.username !== '' || url.password !== '') return undefined
    return url.href.replace(/[()<>]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  } catch {
    return undefined
  }
}

/**
 * 密钥被拒绝、本次改用匿名档时追加在结果里的诊断；模型可见故用英文，与工具文案一致。
 * @param status - 首次带密钥请求返回的 401 或 403。
 * @returns 一行诊断。
 */
function keyRejectedNote(status: number): string {
  return `The configured AnySearch API key was rejected (HTTP ${String(status)}), so this search used the anonymous free tier; the configured key was left unchanged.`
}

/**
 * 校验结构化响应并映射可引用来源。无 URL 或 URL 不可引用的条目被跳过，同一 URL 只返回一次；
 * 认为整个响应不可处理时抛错，不把半截数据交给模型。
 * @param payload - 未受信任的网络 JSON。
 * @returns 无生成答案、URL 去重且字段长度受限的来源。
 * @throws `WEB_PROVIDER_ERROR`，当响应不是对象、`code` 非 0 或缺少 `data.results` 数组。
 */
export function mapAnySearchResponse(payload: unknown): WebSearchResult {
  if (!isRecord(payload)) throw new WebError('AnySearch response must be a JSON object', 'WEB_PROVIDER_ERROR')
  if (payload.code !== 0) {
    const message = typeof payload.message === 'string' ? payload.message.trim().slice(0, MAX_ERROR_DETAIL_CHARS) : ''
    throw new WebError(`AnySearch API error: ${message === '' ? JSON.stringify(payload.code) : message}`, 'WEB_PROVIDER_ERROR')
  }
  const data = payload.data
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new WebError('AnySearch response must contain a data.results array', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of data.results) {
    if (sources.length >= MAX_SOURCES) break
    if (!isRecord(item) || typeof item.url !== 'string') continue
    const url = sourceUrl(item.url)
    if (url === undefined || url.length > MAX_URL_LENGTH || seen.has(url)) continue
    seen.add(url)
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS) : ''
    const snippet = typeof item.snippet === 'string' ? item.snippet.replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET_CHARS) : ''
    sources.push({ url, ...title !== '' ? { title } : {}, ...snippet !== '' ? { snippet } : {} })
  }
  return { sources, truncated: false }
}

/** 逐块按字节限制响应，解码时拒绝损坏的 UTF-8。 */
async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('AnySearch returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('AnySearch response exceeds the size limit', 'WEB_PROVIDER_ERROR')
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

/** 单次操作快照；设置变更只影响下一次搜索，密钥不会投递到上一版端点。 */
export interface AnySearchProviderOptions {
  /** Bearer 密钥；省略即走匿名免费额度。 */
  apiKey?: string
  /** 搜索端点基址；请求追加 `/v1/search`。 */
  baseURL: string
  /** 提供方自己的出站选择，只用于可用性判断；缺省直连。 */
  outbound?: OutboundConfig
  /** 本次搜索的出站地址（提供方选择 + 代理池规则）；返回 `undefined` 即直连。 */
  resolveProxyURL?: () => string | undefined
}

/** AnySearch 搜索后端；匿名可用，带密钥失败时只在本进程降级为一次匿名重试。 */
export class AnySearchProvider implements WebSearchProvider {
  readonly id = ANYSEARCH_PROVIDER_ID

  /**
   * @param resolveOptions - 每次操作开始时读取且只读取一次的设置投影。
   */
  constructor(private readonly resolveOptions: () => AnySearchProviderOptions | Promise<AnySearchProviderOptions>) {}

  /** @returns 端点与出站配置是否可用；匿名档可用，因此不要求密钥。 */
  available(): boolean {
    // 密钥现在按请求解析，可用性只看构造期的静态事实。
    return true
  }

  /**
   * 发送一次结构化搜索；带密钥的请求返回 401/403 时丢弃该密钥并匿名重试一次，
   * 结果里说明降级，配置与存储保持不变。
   * @param request - 查询词与可选的 `maxResults`（缺省 10，上限 20）。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源，以及密钥被拒时的诊断文本。
   * @throws `WEB_ABORTED` 或 `WEB_PROVIDER_ERROR`。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('AnySearch query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    if (isAborted(signal)) throw new WebError('AnySearch search aborted', 'WEB_ABORTED')
    const options = await this.resolveOptions()
    if (!isSafeBaseUrl(options.baseURL)) {
      throw new WebError('AnySearch search endpoint must be a public HTTPS URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    const endpoint = `${options.baseURL.replace(/\/+$/, '')}${SEARCH_PATH}`
    const limit = Math.max(1, Math.min(request.maxResults ?? DEFAULT_MAX_RESULTS, MAX_SOURCES))
    const body = JSON.stringify({ query: request.query, max_results: limit })
    let proxyURL: string | undefined
    try {
      proxyURL = options.resolveProxyURL?.()
    } catch (error: unknown) {
      throw new WebError('AnySearch search outbound proxy is unusable', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    const controller = new AbortController()
    // 单次搜索的超时覆盖带密钥请求与匿名重试；超时与调用方取消统一映射为 WEB_ABORTED。
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    let bodyConsumed = false
    try {
      const send = async (apiKey: string | undefined): Promise<Response | UndiciResponse> => {
        const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }
        if (apiKey !== undefined && apiKey !== '') headers.authorization = `Bearer ${apiKey}`
        const init = {
          method: 'POST',
          // 带凭据的请求不跟随跳转，避免密钥被转发到其他源。
          redirect: 'error',
          headers,
          body,
          signal: controller.signal,
        } as const
        return dispatcher === undefined ? await fetch(endpoint, init) : await undiciFetch(endpoint, { ...init, dispatcher })
      }
      const apiKey = options.apiKey
      let response = await send(apiKey)
      let rejectedStatus: number | undefined
      if ((response.status === 401 || response.status === 403) && apiKey !== undefined && apiKey !== '') {
        rejectedStatus = response.status
        // 首次响应的主体不再使用，主动取消以免占用连接。
        await response.body?.cancel().catch(() => {})
        response = await send(undefined)
      }
      if (response.status === 401 || response.status === 403) {
        throw new WebError(rejectedStatus === undefined
          ? `AnySearch search was not authorized (HTTP ${String(response.status)})`
          : `AnySearch rejected the API key (HTTP ${String(rejectedStatus)}) and the anonymous retry failed (HTTP ${String(response.status)})`,
        'WEB_PROVIDER_ERROR')
      }
      if (!response.ok) throw new WebError(`AnySearch search failed (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('AnySearch returned a non-JSON response', 'WEB_PROVIDER_ERROR')
      }
      const text = await readBounded(response)
      bodyConsumed = true
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error: unknown) {
        throw new WebError('AnySearch returned an unprocessable JSON body', 'WEB_PROVIDER_ERROR', { cause: error })
      }
      const result = mapAnySearchResponse(payload)
      return {
        ...rejectedStatus === undefined ? {} : { content: keyRejectedNote(rejectedStatus) },
        // 端点可能忽略 max_results；这里仍按本次预算截断，由 ctx.web 统一语义兜底。
        sources: result.sources.slice(0, limit),
        truncated: false,
      }
    } catch (error: unknown) {
      if (isAborted(signal) || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('AnySearch search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('AnySearch search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；close() 会等待它结束。
      if (!bodyConsumed || isAborted(signal)) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
