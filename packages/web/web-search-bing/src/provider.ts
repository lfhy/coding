/** 从 Bing 公共 SERP 页提取可引用的搜索结果，不依赖 API 密钥。请求形状参考 MIT 许可的 omdsh-dev/dsh-free-search `searchBing`，按本仓 provider 形态重写。 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'

/** 用户可选的稳定后端 id。 */
export const BING_PROVIDER_ID = 'bing'
const SEARCH_ORIGIN = 'https://www.bing.com'
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_SOURCES = 20
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
/** 单次 SERP 请求的超时毫秒数；超时按取消处理。 */
const REQUEST_TIMEOUT_MS = 12_000
/** Bing 对非浏览器 UA 返回降级页面；使用常量桌面 UA，不随请求变化。 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/** 未配置 market 时的 Accept-Language；Bing 会据此自行本地化结果。 */
const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,en;q=0.8'
/** market → Accept-Language：显式配置 market 时反推，避免默认中文 header 污染其他市场。 */
const MARKET_ACCEPT_LANGUAGE: Readonly<Record<string, string>> = {
  'zh-CN': 'zh-CN,zh;q=0.9,en;q=0.8',
  'zh-TW': 'zh-TW,zh;q=0.9,en;q=0.8',
  'en-US': 'en-US,en;q=0.9',
  'en-GB': 'en-GB,en;q=0.9',
  'ja-JP': 'ja-JP,ja;q=0.9,en;q=0.8',
  'ko-KR': 'ko-KR,ko;q=0.9,en;q=0.8',
  'de-DE': 'de-DE,de;q=0.9,en;q=0.8',
  'fr-FR': 'fr-FR,fr;q=0.9,en;q=0.8',
  'es-ES': 'es-ES,es;q=0.9,en;q=0.8',
  'ru-RU': 'ru-RU,ru;q=0.9,en;q=0.8',
}

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
 * 解析单个 HTML 实体；数字引用用 `String.fromCharCode`，覆盖 Bing 页面常见的 `&#39;`、`&amp;` 等。
 * @param text - 待解码的 HTML 文本片段。
 * @returns 解码后的明文。
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * 剥掉 HTML 标签并折叠空白，再做实体解码。
 * @param html - SERP 片段的原始 HTML。
 * @returns 单行明文。
 */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * 从查询词提取用于相关性判定的 token：CJK 取一至二字组合（二元组），拉丁/数字取长度不小于 2 的词。
 * @param query - 原始查询词。
 * @returns token 列表；纯符号查询返回空。
 */
export function queryOverlapTokens(query: string): string[] {
  const tokens = new Set<string>()
  for (const run of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) tokens.add(run)
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2))
  }
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2) tokens.add(word)
  }
  return [...tokens]
}

/**
 * 判定结果页是否与查询词面相关：Bing 在查询无结果或拦截时会返回一张完全无关的缓存 SERP（`b_algo` 块照常存在），直接返回等于把垃圾结果喂给模型。
 * @param query - 原始查询词。
 * @param sources - 已解析出的来源列表。
 * @returns 任一结果的标题/摘要/URL 与查询 token 重叠（或查询无可比对 token）时为 true。
 */
export function looksRelevant(query: string, sources: readonly WebSearchSource[]): boolean {
  const tokens = queryOverlapTokens(query)
  if (tokens.length === 0) return true
  return sources.some((source) => {
    const hay = `${source.title ?? ''} ${source.snippet ?? ''} ${source.url}`.toLowerCase()
    return tokens.some(token => hay.includes(token))
  })
}

/**
 * 还原 Bing 的 `bing.com/ck/a` 跳转链接：真实地址在 `u` 参数（base64url，`a1` 前缀）。
 * @param href - SERP 里的原始 `href`。
 * @returns 还原出的目标 URL；无法还原时原样返回。
 */
export function extractBingUrl(href: string): string {
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(href)) return href
  try {
    const u = new URL(href).searchParams.get('u')
    if (u === null) return href
    const b64 = (u.startsWith('a1') ? u.slice(2) : u).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

/**
 * 归一化并校验结果 URL：仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的绝对地址。
 * @param href - `b_algo` 块里首个锚点的 `href`。
 * @returns 可引用的 URL；不可用时为 `undefined`。
 */
function citationUrl(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(extractBingUrl(href), SEARCH_ORIGIN)
  } catch {
    return undefined
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > MAX_URL_LENGTH) return undefined
  return url.href
}

const RESULT_BLOCK = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/g

/**
 * 解析 Bing SERP：提取 `b_algo` 块里的 url/title/snippet，去重并按上限截断。
 * 0 结果时视为正常空结果，由调用方结合 `looksRelevant` 处理无关缓存页。
 * @param html - 有字节上限的 Bing HTML 响应。
 * @returns 带原始目标 URL 的来源列表。
 */
export function parseBingResults(html: string): WebSearchResult {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const block of html.match(RESULT_BLOCK) ?? []) {
    if (sources.length >= MAX_SOURCES) break
    const hrefMatch = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block)
    const href = hrefMatch?.[1]
    if (href === undefined) continue
    const url = citationUrl(decodeEntities(href))
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const titleMatch = /<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/.exec(block)
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const title = titleMatch?.[1] === undefined ? '' : stripTags(titleMatch[1]).slice(0, MAX_TITLE_CHARS)
    const snippet = snippetMatch?.[1] === undefined ? '' : stripTags(snippetMatch[1]).slice(0, MAX_SNIPPET_CHARS)
    sources.push({ url, ...title !== '' ? { title } : {}, ...snippet !== '' ? { snippet } : {} })
  }
  return { sources, truncated: false }
}

async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('Bing returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('Bing response exceeds the size limit', 'WEB_PROVIDER_ERROR')
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

/** 公共 SERP 搜索后端；无凭据，HTTP 跳转不跟随，请求与页面解析均有界。 */
export class BingSearchProvider implements WebSearchProvider {
  readonly id = BING_PROVIDER_ID

  /**
   * @param resolveMarket - 单次搜索开始时读取当前生效的 market 配置（`zh-CN` 形态）；未配置或空白时返回 `undefined`，此时不发 `mkt` 参数。
   * @param resolveProxyURL - 单次搜索开始时解析出站（提供方选择 + 池规则）；返回 `undefined` 即直连。
   */
  constructor(
    private readonly resolveMarket: () => string | undefined = () => undefined,
    private readonly resolveProxyURL: () => string | undefined = () => undefined,
  ) {}

  available(): boolean { return true }

  /**
   * 搜索 Bing 公共 SERP；`mkt` 只在显式配置 market 时发送（实测部分地区 `mkt=zh-CN` 返回空 SERP），否则由 Bing 按 Accept-Language 自行本地化。
   * @param request - 一个搜索词与可选的 `maxResults`。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源；0 结果或无关缓存页返回空列表。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('Bing query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    const market = this.resolveMarket()?.trim()
    const url = new URL('/search', SEARCH_ORIGIN)
    url.searchParams.set('q', request.query)
    // 仅显式配置 market 时发送；省略时让 Bing 按 Accept-Language 自行本地化。
    if (market !== undefined && market !== '') url.searchParams.set('mkt', market)
    const acceptLanguage = market === undefined || market === ''
      ? DEFAULT_ACCEPT_LANGUAGE
      : MARKET_ACCEPT_LANGUAGE[market] ?? DEFAULT_ACCEPT_LANGUAGE
    // 出站地址由共享契约解析（提供方选择 + 池规则）；直连时保留原生 fetch 传输。
    const proxyURL = this.resolveProxyURL()
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    const controller = new AbortController()
    // 单次请求 12 秒超时；超时与调用方取消统一映射为 WEB_ABORTED。
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    let bodyConsumed = false
    try {
      const options = {
        redirect: 'error',
        headers: {
          accept: 'text/html',
          'user-agent': USER_AGENT,
          'accept-language': acceptLanguage,
        },
        signal: controller.signal,
      } as const
      const response = dispatcher === undefined
        ? await fetch(url, options)
        : await undiciFetch(url, { ...options, dispatcher })
      if (!response.ok) throw new WebError(`Bing search failed (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('Bing returned a non-HTML response', 'WEB_PROVIDER_ERROR')
      }
      const html = await readBounded(response)
      bodyConsumed = true
      const result = parseBingResults(html)
      // Bing 无结果时会返回无关的缓存 SERP：判为 0 结果，不把垃圾喂给模型。
      if (result.sources.length > 0 && !looksRelevant(request.query, result.sources)) {
        return { sources: [], truncated: false }
      }
      // 尊重调用方的条数预算（默认 10）；上限内不额外标记 truncated，由 ctx.web 统一截断语义兜底。
      const limit = Math.max(1, Math.min(request.maxResults ?? 10, MAX_SOURCES))
      return { sources: result.sources.slice(0, limit), truncated: false }
    } catch (error: unknown) {
      if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('Bing search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('Bing search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；close() 会等待它结束。
      if (!bodyConsumed || signal?.aborted === true) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
