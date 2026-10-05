/** 从 DuckDuckGo 公共 HTML 搜索页提取可引用的搜索结果，不依赖 API 密钥。 */
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** 用户可选的稳定后端 id。 */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'
const SEARCH_ORIGIN = 'https://html.duckduckgo.com'
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_SOURCES = 20
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const USER_AGENT = 'deepseek-harness/0.0.1'
type Node = DefaultTreeAdapterMap['node']

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

function element(node: Node): node is DefaultTreeAdapterMap['element'] {
  return 'tagName' in node
}

function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : []
}

function attribute(node: DefaultTreeAdapterMap['element'], name: string): string | undefined {
  return node.attrs.find(attr => attr.name === name)?.value
}

function hasClass(node: DefaultTreeAdapterMap['element'], name: string): boolean {
  return attribute(node, 'class')?.split(/\s+/).includes(name) ?? false
}

function find(node: Node, predicate: (element: DefaultTreeAdapterMap['element']) => boolean): DefaultTreeAdapterMap['element'] | undefined {
  if (element(node) && predicate(node)) return node
  for (const child of children(node)) {
    const match = find(child, predicate)
    if (match !== undefined) return match
  }
  return undefined
}

function collect(node: Node, predicate: (element: DefaultTreeAdapterMap['element']) => boolean, result: DefaultTreeAdapterMap['element'][]): void {
  if (element(node) && predicate(node)) result.push(node)
  for (const child of children(node)) collect(child, predicate, result)
}

function textOf(node: Node): string {
  if ('value' in node) return node.value
  return children(node).map(textOf).join('')
}

function citationUrl(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(href, SEARCH_ORIGIN)
    if (url.hostname === 'duckduckgo.com' || url.hostname === 'html.duckduckgo.com') {
      const target = url.searchParams.get('uddg')
      if (target === null) return undefined
      url = new URL(target)
    }
  } catch {
    return undefined
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > MAX_URL_LENGTH) return undefined
  return url.href
}

/**
 * 解析 HTML 搜索结果；遇到验证页或未知页面格式时失败，不把空结果伪装为成功。
 * @param html - 有字节上限的 DuckDuckGo HTML 响应。
 * @returns 带原始目标 URL 的来源列表。
 */
export function parseDuckDuckGoResults(html: string): WebSearchResult {
  const document = parse(html)
  const rows: DefaultTreeAdapterMap['element'][] = []
  collect(document, node => hasClass(node, 'result'), rows)
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (sources.length >= MAX_SOURCES) break
    const anchor = find(row, node => node.tagName === 'a' && hasClass(node, 'result__a'))
    if (anchor === undefined) continue
    const url = citationUrl(attribute(anchor, 'href') ?? '')
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = textOf(anchor).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
    const snippetNode = find(row, node => hasClass(node, 'result__snippet'))
    const snippet = snippetNode === undefined ? '' : textOf(snippetNode).replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
    sources.push({ url, ...title ? { title } : {}, ...snippet ? { snippet } : {} })
  }
  if (sources.length === 0 && !/no results found|no results\./i.test(html)) {
    throw new WebError('DuckDuckGo returned no recognizable search results', 'WEB_PROVIDER_ERROR')
  }
  return { sources, truncated: false }
}

async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('DuckDuckGo returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('DuckDuckGo response exceeds the size limit', 'WEB_PROVIDER_ERROR')
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    complete = true
    return html
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** 公共 HTML 搜索后端。请求与页面解析均有界，HTTP 跳转不跟随。 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  /** @param resolveProxyURL - 单次搜索开始时读取最新设置；缺省时直连。 */
  constructor(private readonly resolveProxyURL: () => string | undefined = () => undefined) {}

  available(): boolean { return true }

  /**
   * 搜索公共 HTML 页面；验证码、HTTP 失败及格式变化都显式失败。
   * @param request - 一个搜索词。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('DuckDuckGo query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    const url = new URL('/html/', SEARCH_ORIGIN)
    url.searchParams.set('q', request.query)
    const proxyURL = this.resolveProxyURL()
    if (proxyURL !== undefined && !isValidProxyURL(proxyURL)) {
      throw new WebError('DuckDuckGo proxy URL must be an HTTP(S) URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    let bodyConsumed = false
    try {
      const options = {
        redirect: 'error',
        headers: { accept: 'text/html', 'user-agent': USER_AGENT },
        ...signal === undefined ? {} : { signal },
      } as const
      const response = dispatcher === undefined
        ? await fetch(url, options)
        : await undiciFetch(url, { ...options, dispatcher })
      if (!response.ok) throw new WebError(`DuckDuckGo search failed (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('DuckDuckGo returned a non-HTML response', 'WEB_PROVIDER_ERROR')
      }
      const html = await readBounded(response)
      bodyConsumed = true
      return parseDuckDuckGoResults(html)
    } catch (error: unknown) {
      if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('DuckDuckGo search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；close() 会等待它结束。
      if (!bodyConsumed || signal?.aborted === true) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
