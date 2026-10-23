/** 从 SearXNG 元搜索的 JSON 接口提取可引用的搜索结果：免费、无需密钥，按实例列表顺序自动切换。请求形状参考 MIT 许可的 omdsh-dev/dsh-free-search `searchSearxng`，按本仓 provider 形态重写。 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'

/** 用户可选的稳定后端 id。 */
export const SEARXNG_PROVIDER_ID = 'searxng'
/**
 * 省略 `instances` 时按此顺序尝试的公共实例。公共实例由志愿者维护，可能限流、
 * 关闭 JSON 接口或整体下线，因此它们只是缺省起点，不是可用性承诺。
 */
export const SEARXNG_INSTANCES: readonly string[] = [
  'https://opnxng.com',
  'https://priv.au',
  'https://searx.be',
  'https://searx.tiekoetter.com',
  'https://search.inetol.net',
  'https://paulgo.io',
]
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_SOURCES = 20
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
/** 单个实例的请求超时毫秒数；超时按该实例失败处理，继续尝试下一个实例。 */
const INSTANCE_TIMEOUT_MS = 8_000
/** 全部实例失败时的原因汇总上限：错误会进入模型可见的工具结果，避免六实例全挂时刷屏。 */
const MAX_FAILURE_DETAIL_CHARS = 300
/** 公共实例对脚本 UA 更易返回 403；使用常量桌面 UA，不随请求变化。 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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
 * 校验 SearXNG 实例基址：仅接受不带用户信息、查询串与片段的 http(s) 绝对地址。
 * 实例可以挂在子路径下（如 `https://host/searxng`），末尾斜杠在请求前归一化。
 * @param raw - 设置或组合配置里的实例地址。
 * @returns 地址可作为实例基址时为 true。
 */
export function isValidInstanceURL(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return raw.trim() === raw && url.hostname !== '' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

/**
 * 把实例地址归一化成不带末尾斜杠的基址，供 `{base}/search` 拼接。
 * @param raw - 设置或组合配置里的实例地址。
 * @returns 可用基址；地址不可用时为 `undefined`，由调用方计入该实例的失败原因。
 */
export function normalizeInstanceBase(raw: string): string | undefined {
  if (!isValidInstanceURL(raw)) return undefined
  return raw.replace(/\/+$/, '')
}

/**
 * 归一化并校验结果 URL：仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的绝对地址。
 * @param value - JSON 结果条目里的 `url` 字段，来源不可信。
 * @returns 可引用的 URL；不可用时为 `undefined`。
 */
function citationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username !== '' || url.password !== '' || url.href.length > MAX_URL_LENGTH) return undefined
  return url.href
}

/**
 * 读取 JSON 响应里的 `results` 数组：`format=json` 的接口响应是外部数据，
 * 形状不对时整条响应作废，不猜测字段。
 * @param payload - `JSON.parse` 的结果。
 * @returns 结果数组；形状不符时为 `undefined`。
 */
function readResults(payload: unknown): readonly unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const results = (payload as { results?: unknown }).results
  return Array.isArray(results) ? results : undefined
}

/**
 * 解析 SearXNG 的 `format=json` 响应：提取 `results[].{url,title,content}`，
 * 去重、剔除非 http(s) 来源并按上限截断标题与摘要。
 *
 * 抛出的 `WebError` 消息是失败原因片段（如 `returned invalid JSON`），由调用方
 * 拼上实例地址后进入汇总错误。
 * @param text - 有字节上限的 JSON 响应体。
 * @returns 标准化的来源列表；0 条结果是正常返回值，由调用方决定是否切下一个实例。
 */
export function parseSearxngResults(text: string): WebSearchResult {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new WebError('returned invalid JSON', 'WEB_PROVIDER_ERROR')
  }
  const results = readResults(payload)
  if (results === undefined) throw new WebError('returned an unexpected JSON shape', 'WEB_PROVIDER_ERROR')
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const entry of results) {
    if (sources.length >= MAX_SOURCES) break
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { url?: unknown; title?: unknown; content?: unknown }
    const url = citationUrl(record.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE_CHARS) : ''
    const snippet = typeof record.content === 'string' ? record.content.trim().slice(0, MAX_SNIPPET_CHARS) : ''
    sources.push({ url, ...title !== '' ? { title } : {}, ...snippet !== '' ? { snippet } : {} })
  }
  return { sources, truncated: false }
}

/**
 * 调用方是否已取消。每次调用都重新读取 `aborted`，因为取消可能发生在任意 await
 * 之间；写成函数而不是就地比较，避免把早先的判断当成后续时刻的事实。
 * @param signal - 调用方的取消信号。
 * @returns 已取消时为 true。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * 把一次实例尝试的失败压缩成进入汇总错误的短句；原始异常留在 `cause` 里。
 * @param error - `fetch`、响应校验或解析抛出的异常。
 * @returns 形如 `HTTP 429`、`timed out` 的单行原因。
 */
function describeFailure(error: unknown): string {
  if (error instanceof WebError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return 'timed out'
  if (error instanceof Error) return error.message
  return 'unknown error'
}

async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('response exceeds the size limit', 'WEB_PROVIDER_ERROR')
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

/** 免费元搜索后端：无凭据，按实例顺序尝试，HTTP 跳转不跟随，请求与响应均有界。 */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  /**
   * @param resolveInstances - 单次搜索开始时读取当前生效的实例列表；返回空数组表示没有可用实例，直接失败。
   * @param resolveProxyURL - 单次搜索开始时解析出站（提供方选择 + 池规则）；返回 `undefined` 即直连。
   */
  constructor(
    private readonly resolveInstances: () => readonly string[] = () => SEARXNG_INSTANCES,
    private readonly resolveProxyURL: () => string | undefined = () => undefined,
  ) {}

  available(): boolean { return true }

  /**
   * 依次请求各实例的 `{base}/search?q=…&format=json`，返回第一个有结果的实例的
   * 已截断来源列表。单实例超时、HTTP 错误或响应不合规只记为一条失败原因并继续；
   * 若某实例给出了合法的空结果，最终按 0 结果返回而不是报错；全部失败时抛出汇总错误。
   * @param request - 一个搜索词与可选的 `maxResults`。
   * @param signal - 调用方的取消信号；取消立即终止剩余实例的尝试。
   * @returns 标准化的可引用来源。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('SearXNG query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    // 已取消的调用方不该再打出任何实例请求。
    if (isAborted(signal)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED')
    const instances = this.resolveInstances()
    if (instances.length === 0) throw new WebError('SearXNG has no configured instance', 'WEB_PROVIDER_ERROR')
    // 出站地址由共享契约解析（提供方选择 + 池规则）；同一搜索的所有实例尝试共用同一个值。
    const proxyURL = this.resolveProxyURL()
    const failures: string[] = []
    let emptyAnswer = false
    for (const [index, instance] of instances.entries()) {
      const base = normalizeInstanceBase(instance)
      if (base === undefined) {
        // 不回显原始地址：不可用的地址可能带着用户误填的凭据。
        failures.push(`instance ${String(index + 1)}: unusable instance URL`)
        continue
      }
      try {
        const result = await this.searchInstance(base, request, signal, proxyURL)
        if (result.sources.length > 0) return result
        // 合法但为空：换个实例再试，同时记住这个实例确实给出了答复。
        emptyAnswer = true
      } catch (error) {
        if (isAborted(signal)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        failures.push(`${base}: ${describeFailure(error)}`)
      }
    }
    if (emptyAnswer) return { sources: [], truncated: false }
    const detail = failures.join(', ').slice(0, MAX_FAILURE_DETAIL_CHARS)
    throw new WebError(`all SearXNG instances failed: ${detail}`, 'WEB_PROVIDER_ERROR')
  }

  /**
   * 向一个实例发起一次有界请求。每实例一个 dispatcher：请求结束或取消后释放连接，
   * 且某个实例的失败不会污染后续实例的连接复用。
   * @param base - 归一化后的实例基址。
   * @param request - 原始搜索请求。
   * @param signal - 调用方的取消信号。
   * @param proxyURL - 本次搜索的出站代理地址；`undefined` 表示直连。
   * @returns 该实例的结果；可能是合法但为空的来源列表。
   */
  private async searchInstance(
    base: string,
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
    proxyURL: string | undefined,
  ): Promise<WebSearchResult> {
    const url = new URL(`${base}/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    const controller = new AbortController()
    // 单实例 8 秒超时；超时与调用方取消都落到同一个 controller 上。
    const timer = setTimeout(() => { controller.abort() }, INSTANCE_TIMEOUT_MS)
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    let bodyConsumed = false
    try {
      const options = {
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      } as const
      const response = dispatcher === undefined
        ? await fetch(url, options)
        : await undiciFetch(url, { ...options, dispatcher })
      if (!response.ok) throw new WebError(`HTTP ${String(response.status)}`, 'WEB_PROVIDER_ERROR')
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('returned a non-JSON response', 'WEB_PROVIDER_ERROR')
      }
      const text = await readBounded(response)
      bodyConsumed = true
      const result = parseSearxngResults(text)
      // 尊重调用方的条数预算（默认 10）；上限内不额外标记 truncated，由 ctx.web 统一截断语义兜底。
      const limit = Math.max(1, Math.min(request.maxResults ?? 10, MAX_SOURCES))
      return { sources: result.sources.slice(0, limit), truncated: false }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；close() 会等待它结束。
      if (!bodyConsumed || isAborted(signal)) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }
}
