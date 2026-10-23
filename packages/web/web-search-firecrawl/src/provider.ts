/**
 * Firecrawl `/v2/search` 的 Host 适配器：有 API key 走账号档，无 key 走官方 keyless 匿名额度。
 * 请求形状与 keyless 拒绝判定参考 MIT 许可的 omdsh-dev/dsh-free-search `searchFirecrawl`，按本仓 provider 形态重写。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Response as UndiciResponse } from 'undici'
import { WebError } from 'coding-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from 'coding-web'

/** 用户可选的稳定后端 id。 */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl'
/** Firecrawl 官方 API 基址；请求追加 `/v2/search`。 */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'
/**
 * keyless 档被出口 IP 拒绝后的进程内冷却时长。
 * 该判定只取决于出口 IP、不随查询变化，因此冷却一次，避免每次搜索都白等一次往返。
 */
export const FIRECRAWL_KEYLESS_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 本次搜索被 keyless 出口拒绝时的诊断：说明原因与恢复方式。 */
const FIRECRAWL_KEYLESS_REFUSAL_MESSAGE = 'Firecrawl keyless tier refused this request: the anonymous tier is decided by egress IP, so VPN/proxy egress is rejected (HTTP 403). Keyless searches from this outbound are paused for 6 hours; configure an API key to search now, or switch the outbound proxy for a new keyless attempt.'
/** 冷却期内直接失败时的诊断；措辞与上一次拒绝保持一致，便于模型和用户定位原因。 */
const FIRECRAWL_KEYLESS_COOLDOWN_MESSAGE = 'Firecrawl keyless searches are cooling down: the anonymous tier is decided by egress IP and a previous request from this outbound was refused (HTTP 403, VPN/proxy egress). No request was sent; the pause lasts 6 hours for this outbound. Configure an API key to search now, or switch the outbound proxy for a new keyless attempt.'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_SOURCES = 20
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 500
const MAX_ERROR_DETAIL_CHARS = 500
/** 请求未指定条数时与面向模型的搜索工具一致的默认值。 */
const DEFAULT_MAX_RESULTS = 10
/** 单次搜索请求的超时毫秒数；超时按取消处理。 */
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
 * 校验搜索端点基址：必须是绝对 HTTP(S) 地址，且不把凭据、查询串或片段拼进请求路径。
 * 自带部署的 Firecrawl 常在本机明文端口上，因此不要求 HTTPS；携带 API key 时应自行使用 HTTPS。
 * @param raw - 候选端点基址（不含 `/v2/search`）。
 * @returns 基址可用于拼接本次请求时为 true。
 */
export function isSafeBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1]
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0 && raw.trim() === raw
      && authority !== undefined && !authority.includes('@')
      && !url.username && !url.password
      && !raw.includes('?') && !raw.includes('#')
  } catch {
    return false
  }
}

/**
 * 该响应是不是 Firecrawl 对 keyless 档的出口 IP 拒绝，而非 key 失效或限流。
 * @param status - HTTP 状态码。
 * @param body - 有字节上限的响应体文本。
 * @returns 403 且文案点名 VPN、代理或「没有 API key」的拒绝时为 true。
 */
export function isFirecrawlKeylessRefusal(status: number, body: string): boolean {
  if (status !== 403) return false
  return /vpn|proxy|without an api key|api key from here/i.test(body)
}

/** keyless 冷却记录：只保留最近一次被拒的出口，换出口即视为新的判定周期。 */
interface KeylessCooldown {
  /** 当前出站解析出的代理地址；直连记为 `direct`。 */
  readonly egress: string
  /** 冷却截止时间（毫秒时间戳）。 */
  readonly until: number
}

/**
 * 出口指纹：冷却只对同一出口生效，换了代理就是另一个出口 IP。
 * @param proxyURL - 本次搜索解析出的代理地址；`undefined` 表示直连。
 * @returns 用于比对冷却记录的出口标识。
 */
function egressFingerprint(proxyURL: string | undefined): string {
  return proxyURL ?? 'direct'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一化并校验来源 URL：仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的绝对地址。
 * @param value - Firecrawl 结果里的 `url`。
 * @returns 可引用的 URL；不可用时为 `undefined`。
 */
function sourceUrl(value: string): string | undefined {
  if (value.includes('\\') || /[\s\p{Cc}]/u.test(value)) return undefined
  try {
    const url = new URL(value)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1]
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || authority === undefined
      || authority.includes('@') || url.username || url.password || url.href.length > MAX_URL_LENGTH) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/**
 * 把 Firecrawl 搜索响应映射为可引用来源：`data.web[]`（v2 形状，也接受 `data[]` 数组）逐条取 url/title/description。
 * 顶层结构不符时抛错；单条结果缺 URL 或 URL 不安全时跳过，不因一条坏数据丢掉整批结果。
 * @param payload - 未受信任的网络 JSON。
 * @returns 去重、字段有长度上限且不含生成答案的来源列表。
 * @throws `WEB_PROVIDER_ERROR`，当响应不是对象或缺少结果数组。
 */
export function mapFirecrawlResponse(payload: unknown): WebSearchResult {
  if (!isRecord(payload)) throw new WebError('Firecrawl response must be a JSON object', 'WEB_PROVIDER_ERROR')
  const data = payload.data
  const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.web) ? data.web : undefined
  if (items === undefined) throw new WebError('Firecrawl response must contain a data.web array', 'WEB_PROVIDER_ERROR')
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of items) {
    if (sources.length >= MAX_SOURCES) break
    if (!isRecord(item) || typeof item.url !== 'string') continue
    const url = sourceUrl(item.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const rawTitle = typeof item.title === 'string' ? item.title : ''
    const rawSnippet = typeof item.description === 'string' ? item.description : ''
    // 标题会进入 Markdown 链接的标签位置，去掉可能提前闭合链接目标的字符。
    const title = rawTitle.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS).replace(/[\[\]\\]/gu, '')
    const snippet = rawSnippet.replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
    sources.push({ url, ...title !== '' ? { title } : {}, ...snippet !== '' ? { snippet } : {} })
  }
  return { sources, truncated: false }
}

/**
 * 组装 HTTP 失败诊断：区分 key 失效、限流与通用错误，并保留有限长度的服务端说明。
 * 服务端可能在错误体里回显密钥，因此先抹掉本次请求携带的 key，再进入面向模型的消息。
 * @param status - HTTP 状态码。
 * @param detail - 有字节上限的响应体文本。
 * @param apiKey - 本次请求携带的密钥；空串表示 keyless。
 * @returns 面向模型与用户的错误消息。
 */
function httpErrorMessage(status: number, detail: string, apiKey: string): string {
  if (status === 401) {
    return apiKey === ''
      ? 'Firecrawl refused the keyless request (HTTP 401); configure an API key'
      : 'Firecrawl rejected the API key (HTTP 401)'
  }
  if (status === 429) {
    return apiKey === ''
      ? 'Firecrawl keyless rate limit exceeded (HTTP 429); configure an API key for a higher quota'
      : 'Firecrawl rate limit exceeded (HTTP 429)'
  }
  const redacted = apiKey === '' ? detail : detail.replaceAll(apiKey, '[redacted]')
  const excerpt = redacted.replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_DETAIL_CHARS)
  const suffix = excerpt === '' ? '' : `: ${excerpt}`
  return `Firecrawl search failed (HTTP ${String(status)})${suffix}`
}

/**
 * 读取调用方信号当前状态。封装成函数，避免搜索开始时的一次判断把后续比较收窄成常量
 * （信号可以在 await 期间被取消）。
 * @param signal - 调用方信号。
 * @returns 已取消时为 true。
 */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** 逐块按字节限制响应并拒绝损坏的 UTF-8；HTTP 错误体同样经过这个上限。 */
async function readBounded(response: Response | UndiciResponse): Promise<string> {
  // Undici 与 DOM 的 stream 类型声明不同，运行时均交付 Uint8Array 字节块。
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body === null) throw new WebError('Firecrawl returned an empty response body', 'WEB_PROVIDER_ERROR')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new WebError('Firecrawl response exceeds the size limit', 'WEB_PROVIDER_ERROR')
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

/** Firecrawl 搜索后端；重定向不跟随，请求与响应均有界，keyless 拒绝按出口记账冷却。 */
export class FirecrawlSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_PROVIDER_ID
  /** 最近一次 keyless 被拒的出口与截止时间；同一实例只保留一条记录。 */
  private cooldown: KeylessCooldown | undefined

  /**
   * @param resolveApiKey - 单次搜索开始时读取当前生效的密钥；返回 `undefined` 或空串时走 keyless 匿名档。
   * @param resolveBaseURL - 单次搜索开始时读取端点基址（不含 `/v2/search`）。
   * @param resolveProxyURL - 单次搜索开始时解析出站（提供方选择 + 池规则）；返回 `undefined` 即直连，同时作为冷却的出口指纹。
   */
  constructor(
    private readonly resolveApiKey: () => string | undefined = () => undefined,
    private readonly resolveBaseURL: () => string = () => FIRECRAWL_DEFAULT_BASE_URL,
    private readonly resolveProxyURL: () => string | undefined = () => undefined,
  ) {}

  /** @returns 端点基址本地可用时为 true；不访问网络，冷却不参与可用性判断。 */
  available(): boolean {
    return isSafeBaseUrl(this.resolveBaseURL())
  }

  /**
   * 调用 Firecrawl `/v2/search`：有 key 时携带 Bearer，无 key 时不发 `authorization` 头。
   * @param request - 一个搜索词与可选的 `maxResults`（默认 10，上限 20）。
   * @param signal - 调用方的取消信号。
   * @returns 标准化的可引用来源；keyless 冷却期内不发请求，直接失败。
   * @throws `WEB_ABORTED` 或 `WEB_PROVIDER_ERROR`（含 keyless 出口拒绝与冷却）。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 已取消的调用不再读取配置或等待网络，也不进入 keyless 冷却判断。
    if (signalAborted(signal)) throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: signal?.reason })
    if (request.query.trim().length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      throw new WebError('Firecrawl query must contain 1–2000 characters', 'WEB_PROVIDER_ERROR')
    }
    const baseURL = this.resolveBaseURL()
    if (!isSafeBaseUrl(baseURL)) {
      throw new WebError('Firecrawl base URL must be an absolute HTTP(S) URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
    const apiKey = this.resolveApiKey()?.trim() ?? ''
    const proxyURL = this.resolveProxyURL()
    const egress = egressFingerprint(proxyURL)
    // keyless 档按出口 IP 判定：本出口已被拒时直接给诊断，不再白等一次往返。
    if (apiKey === '' && this.isCoolingDown(egress)) {
      throw new WebError(FIRECRAWL_KEYLESS_COOLDOWN_MESSAGE, 'WEB_PROVIDER_ERROR')
    }
    const endpoint = `${baseURL.replace(/\/+$/, '')}/v2/search`
    const limit = Math.max(1, Math.min(request.maxResults ?? DEFAULT_MAX_RESULTS, MAX_SOURCES))
    // 出站地址由共享契约解析（提供方选择 + 池规则）；直连时保留原生 fetch 传输。
    const dispatcher = proxyURL === undefined ? undefined : new ProxyAgent(proxyURL)
    const controller = new AbortController()
    // 单次请求 12 秒超时；超时与调用方取消统一映射为 WEB_ABORTED。
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    // 调用方取消会同时取消本次请求；取消后即使网络层给出别的错误，也要报告 WEB_ABORTED。
    const onAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onAbort)
    let bodyConsumed = false
    try {
      const options = {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // keyless 请求不带 Authorization：带上空值会被当作无效密钥。
          ...apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
        },
        body: JSON.stringify({ query: request.query, limit }),
        signal: controller.signal,
      } as const
      const response = dispatcher === undefined
        ? await fetch(endpoint, options)
        : await undiciFetch(endpoint, { ...options, dispatcher })
      const text = await readBounded(response)
      bodyConsumed = true
      if (!response.ok) {
        if (apiKey === '' && isFirecrawlKeylessRefusal(response.status, text)) {
          this.rememberKeylessRefusal(egress)
          throw new WebError(FIRECRAWL_KEYLESS_REFUSAL_MESSAGE, 'WEB_PROVIDER_ERROR')
        }
        throw new WebError(httpErrorMessage(response.status, text, apiKey), 'WEB_PROVIDER_ERROR')
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new WebError('Firecrawl returned a non-JSON response', 'WEB_PROVIDER_ERROR')
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error: unknown) {
        throw new WebError('Firecrawl returned an unprocessable JSON body', 'WEB_PROVIDER_ERROR', { cause: error })
      }
      const result = mapFirecrawlResponse(payload)
      // 尊重调用方的条数预算（默认 10）；上限内不额外标记 truncated，由 ctx.web 统一截断语义兜底。
      return { sources: result.sources.slice(0, limit), truncated: false }
    } catch (error: unknown) {
      if (signalAborted(signal) || error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('Firecrawl search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError('Firecrawl search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 拒绝响应或读取中断时，未完成的主体仍占用连接；destroy() 会立即断开。
      if (!bodyConsumed || signalAborted(signal)) await dispatcher?.destroy()
      else await dispatcher?.close()
    }
  }

  /**
   * 判断该出口是否仍在 keyless 冷却期内；记录过期或出口变化时清除旧记录。
   * @param egress - 本次搜索的出口指纹。
   * @returns 该出口仍在冷却期内时为 true。
   */
  private isCoolingDown(egress: string): boolean {
    const cooldown = this.cooldown
    if (cooldown === undefined) return false
    if (cooldown.egress !== egress || Date.now() >= cooldown.until) {
      this.cooldown = undefined
      return false
    }
    return true
  }

  /**
   * 记录本次 keyless 出口拒绝，冷却期从此刻开始计算。
   * @param egress - 被拒绝的出口指纹。
   * @returns 无返回值。
   */
  private rememberKeylessRefusal(egress: string): void {
    this.cooldown = { egress, until: Date.now() + FIRECRAWL_KEYLESS_COOLDOWN_MS }
  }
}
