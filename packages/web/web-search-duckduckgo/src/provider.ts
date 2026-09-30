/** 从 DuckDuckGo 公共 HTML 搜索页提取可引用的搜索结果，不依赖 API 密钥。 */
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
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

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) throw new WebError('DuckDuckGo returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = response.body.getReader()
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
    try {
      const response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'text/html', 'user-agent': USER_AGENT },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new WebError(`DuckDuckGo search failed (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('DuckDuckGo returned a non-HTML response', 'WEB_PROVIDER_ERROR')
      }
      return parseDuckDuckGoResults(await readBounded(response))
    } catch (error: unknown) {
      if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('DuckDuckGo search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
