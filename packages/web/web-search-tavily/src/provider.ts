/** Tavily `/search` 的 Host HTTP 适配器；响应在映射为 web 来源前逐字段校验。@module @deepseek-ai/dsh-web-search-tavily/provider */

import { isIP } from 'node:net'
import { fetch as proxyFetch, ProxyAgent } from 'undici'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** 稳定的搜索提供方 id。 */
export const TAVILY_PROVIDER_ID = 'tavily'
/** Tavily 官方搜索 API 的基址。 */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'
/** Tavily 单次搜索的最大结果数。 */
export const TAVILY_MAX_RESULTS = 20
/** 没有请求上限时与面向模型的搜索工具一致的默认值。 */
export const TAVILY_DEFAULT_MAX_RESULTS = 8
/** 包括错误响应在内，单个 JSON 响应最多读取 2 MiB。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_URL_LENGTH = 2_048
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const MAX_ERROR_DETAIL_CHARS = 500

/**
 * 拒绝内网字面地址和会改变密钥投递目标解释的 URL 部分。
 * @param raw - 候选 Tavily HTTPS 端点基址。
 * @returns 端点可安全接收此提供方密钥时为 true。
 */
export function isSafeBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    const authority = raw.match(/^https?:[/\\]+([^/\\?#]*)/iu)?.[1]
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

/**
 * 前向代理可位于 loopback 或 IP，但不可附带凭据和查询参数。
 * @param raw - 候选 HTTP(S) 前向代理地址。
 * @returns 代理地址符合无认证 URL 限制时为 true。
 */
export function isSafeProxyUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const authority = raw.match(/^https?:[/\\]+([^/\\?#]*)/iu)?.[1]
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0 && authority !== undefined && !authority.includes('@')
      && !url.username && !url.password
      && !raw.includes('?') && !raw.includes('#')
  } catch {
    return false
  }
}

/** 单次操作快照，配置变化不会让密钥被投递到下一版端点。 */
export interface TavilySearchProviderOptions {
  /** 非空密钥字面值优先于解析器。 */
  apiKey?: string
  /** 每次搜索独立解析凭据。 */
  resolveApiKey?: () => Promise<string | undefined>
  /** 缺失凭据的诊断名称。 */
  apiKeyEnv?: CredentialRef
  /** 搜索 API 基址。 */
  baseURL: string
  /** 本次搜索专用的 HTTP(S) 前向代理。 */
  proxyURL?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 将来源 URL 规范化为可安全放入 Markdown 链接目标的绝对地址。 */
function sourceUrl(value: string): string | undefined {
  try {
    if (value.includes('\\') || /[\s\p{Cc}]/u.test(value)) return undefined
    const url = new URL(value)
    const authority = value.match(/^https?:[/\\]+([^/\\?#]*)/iu)?.[1]
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0
      || authority === undefined || authority.includes('@') || url.username || url.password) return undefined
    // WHATWG URL 保留部分 Markdown 定界符；编码后链接目标不能提前闭合。
    return url.href.replace(/[()<>]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  } catch {
    return undefined
  }
}

/**
 * 校验官方搜索响应并映射最多 20 个可引用来源；第一条同 URL 结果优先。
 * @param payload - 未受信任的网络 JSON。
 * @returns 无生成答案、URL 去重且字段长度受限的来源。
 * @throws `WEB_PROVIDER_ERROR`，当 `results[]` 或被消费字段不合法。
 */
export function mapTavilyResponse(payload: unknown): WebSearchResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new WebError('Tavily response must contain a results array', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const [index, item] of payload.results.entries()) {
    if (!isRecord(item) || typeof item.url !== 'string') {
      throw new WebError(`Tavily results[${index}].url must be an HTTP(S) URL of at most 2048 characters`, 'WEB_PROVIDER_ERROR')
    }
    const url = sourceUrl(item.url)
    if (url === undefined || url.length > MAX_URL_LENGTH) {
      throw new WebError(`Tavily results[${index}].url must be an HTTP(S) URL of at most 2048 characters`, 'WEB_PROVIDER_ERROR')
    }
    for (const field of ['title', 'content', 'published_date'] as const) {
      if (item[field] !== undefined && item[field] !== null && typeof item[field] !== 'string') {
        throw new WebError(`Tavily results[${index}].${field} must be a string`, 'WEB_PROVIDER_ERROR')
      }
    }
    if (seen.has(url) || sources.length >= TAVILY_MAX_RESULTS) continue
    seen.add(url)
    const rawTitle = item.title as string | null | undefined
    const rawSnippet = item.content as string | null | undefined
    const title = rawTitle?.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS).replace(/[\[\]\\]/gu, '')
    const snippet = rawSnippet?.replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
    const publication = item.published_date as string | null | undefined
    const timestamp = publication !== undefined && publication !== null && publication.trim().length > 0
      ? Date.parse(publication) : NaN
    sources.push({
      url,
      ...title ? { title } : {},
      ...snippet ? { snippet } : {},
      ...Number.isFinite(timestamp) ? { publishedAt: new Date(timestamp).toISOString() } : {},
    })
  }
  return { sources, truncated: false }
}

function abortError(signal?: AbortSignal): WebError {
  return new WebError('Tavily search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : undefined,
  })
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function safeDetail(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.detail === 'string') return payload.detail
  if (isRecord(payload.detail) && typeof payload.detail.error === 'string') return payload.detail.error
  return undefined
}

/** 逐块按字节限制响应，解码时拒绝损坏的 UTF-8。 */
async function readJson(response: Response | Awaited<ReturnType<typeof proxyFetch>>): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new TypeError('empty JSON response')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let body = ''
  let complete = false
  try {
    while (true) {
      const result: unknown = await reader.read()
      if (!isRecord(result) || typeof result.done !== 'boolean') throw new TypeError('invalid JSON response stream')
      if (result.done) break
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) throw new TypeError('invalid JSON response chunk')
      bytes += chunk.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new WebError('Tavily response exceeds 2 MiB', 'WEB_PROVIDER_ERROR')
      body += decoder.decode(chunk, { stream: true })
    }
    body += decoder.decode()
    const parsed: unknown = JSON.parse(body)
    complete = true
    return parsed
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** 提供方使用一次请求的单独 dispatcher；重定向在转发密钥前失败。 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - 每次操作开始时读取且只读取一次的设置区投影。
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  /** @returns 配置在本地是否可用；不访问网络或预取凭据。 */
  available(): boolean {
    const options = this.resolveOptions()
    return (Boolean(options.apiKey) || options.resolveApiKey !== undefined)
      && isSafeBaseUrl(options.baseURL)
      && (options.proxyURL === undefined || isSafeProxyUrl(options.proxyURL))
  }

  /**
   * 发送 Tavily 基础搜索并校验响应。
   * @param request - 查询与可选的最大结果数。
   * @param signal - 取消本次解析和网络请求的信号。
   * @returns 不包含 Tavily 生成答案的规范化搜索来源。
   * @throws `WEB_ABORTED`、`WEB_PROVIDER_CREDENTIAL_MISSING` 或 `WEB_PROVIDER_ERROR`。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const options = this.resolveOptions()
    if (!isSafeBaseUrl(options.baseURL)) {
      throw new WebError('Tavily search endpoint must be a public HTTPS URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    if (options.proxyURL !== undefined && !isSafeProxyUrl(options.proxyURL)) {
      throw new WebError('Tavily search proxy must be an HTTP(S) URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    if (request.maxResults !== undefined && (!Number.isInteger(request.maxResults) || request.maxResults < 1)) {
      throw new WebError('Tavily maxResults must be a positive integer', 'WEB_PROVIDER_ERROR')
    }
    let apiKey = options.apiKey
    if (apiKey === undefined || apiKey.length === 0) {
      try {
        apiKey = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
      } catch (error: unknown) {
        if (isAbort(error, signal)) throw abortError(signal)
        throw new WebError('Tavily search credential resolution failed', 'WEB_PROVIDER_ERROR')
      }
    }
    throwIfAborted(signal)
    if (apiKey === undefined || apiKey.length === 0) {
      throw new WebError(`Tavily search has no API key for "${options.apiKeyEnv ?? 'TAVILY_API_KEY'}"; store it through credentials, export it in the launching environment, or set apiKey`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const endpoint = `${options.baseURL.replace(/\/+$/, '')}/search`
    const init = {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        query: request.query,
        max_results: Math.min(request.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS, TAVILY_MAX_RESULTS),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      ...signal !== undefined ? { signal } : {},
    } as const
    const agent = options.proxyURL === undefined ? undefined : new ProxyAgent(options.proxyURL)
    const destroyOnAbort = (): void => { void agent?.destroy() }
    signal?.addEventListener('abort', destroyOnAbort, { once: true })
    try {
      let response: Response | Awaited<ReturnType<typeof proxyFetch>>
      try {
        response = agent === undefined ? await fetch(endpoint, init) : await proxyFetch(endpoint, { ...init, dispatcher: agent })
      } catch (error: unknown) {
        if (isAbort(error, signal)) throw abortError(signal)
        throw new WebError(`Tavily search request failed: ${String(error).replaceAll(apiKey, '[redacted]')}`, 'WEB_PROVIDER_ERROR')
      }
      if (!response.ok) {
        let message = `Tavily API error (HTTP ${response.status})`
        try {
          const detail = safeDetail(await readJson(response))
          if (detail) message += `: ${detail.replaceAll(apiKey, '[redacted]').slice(0, MAX_ERROR_DETAIL_CHARS)}`
        } catch (error: unknown) {
          if (isAbort(error, signal)) throw abortError(signal)
          if (error instanceof WebError) throw new WebError(`Tavily API error (HTTP ${response.status}): response exceeds 2 MiB`, 'WEB_PROVIDER_ERROR')
        }
        throw new WebError(message, 'WEB_PROVIDER_ERROR')
      }
      try {
        return mapTavilyResponse(await readJson(response))
      } catch (error: unknown) {
        if (isAbort(error, signal)) throw abortError(signal)
        if (error instanceof WebError) throw error
        throw new WebError(`Tavily returned an unprocessable response body: ${String(error).replaceAll(apiKey, '[redacted]')}`, 'WEB_PROVIDER_ERROR')
      }
    } finally {
      try {
        if (signal?.aborted === true) await agent?.destroy()
        else await agent?.close()
      } finally {
        signal?.removeEventListener('abort', destroyOnAbort)
      }
    }
  }
}

/** 等待凭据期间让取消立即生效，仍观察原异步任务的后续结算。 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
