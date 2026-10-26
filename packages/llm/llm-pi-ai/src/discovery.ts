/**
 * 回答配置界面「获取可用模型」动作提出的问题：这个提供方能服务哪些模型。
 *
 * 仅向当前草稿明确指定、或已配置路由保存的端点发送 GET /models。
 * 已安装目录仅提供缺省端点，不充当网络查询结果。
 *
 * 查询不会刷新服务目录：草稿与候选结果都不写入 settings.yaml。
 *
 * 仅探测具有 OpenAI 兼容 GET /models 格式的协议，其余协议要求手工录入。
 *
 * 一次探测最多尝试两次：闲置连接被中间设备丢弃、DNS 首次答到不可达地址这类
 * 一次性故障在换连接后通常就消失。失败说明带上传输原因码，否则界面上只剩
 * 「超时」，用户无从判断是地址、证书还是网络的问题。
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from 'coding-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from 'coding-llm'
import { errorChain, userAgent } from 'coding-llm'
import { catalogProvider } from './catalog.ts'

/**
 * 本模块能读取模型清单的协议：以 bearer 认证说 OpenAI `GET /models` 的那两种。
 * Azure 虽出身 OpenAI 也被排除——它用 `api-key` 标头认证并要求 `api-version`
 * 查询参数——Codex 则走 OAuth；对这两者靠猜只会把认证失败报成一个没有模型的
 * 提供方。pi-ai 其余的协议同理缺席。
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * 超过这个字节数的回复一律拒绝。端点地址由用户填写，因此上限落在实际读到的
 * 字节上，而不是服务端声明的长度——这与 `dsh-web-fetch` 处理调用方给出地址的
 * 两段结构一致，区别在于被截断的模型清单无法解析，所以溢出是拒绝而不是截断。
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * 每次尝试的沉默上限。端点本身通常毫秒级回答，但网关冷启动、DNS 答到不可达
 * 地址、中间设备丢弃闲置连接都会长时间没有响应，所以按次计时而不是给整个动作
 * 一个总上限：故障在第二次尝试上消失时，用户仍能拿到清单。
 */
const ATTEMPT_TIMEOUT_MS = 10_000
/** `{@link ATTEMPT_TIMEOUT_MS}` 之上的尝试次数：一次重试覆盖一次性故障。 */
const DISCOVERY_ATTEMPTS = 2

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  let base: URL
  try {
    base = new URL(baseURL)
  } catch {
    throw new LlmError('model discovery needs a valid HTTP(S) baseURL', 'DISCOVERY_FAILED')
  }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:')
    || base.username !== '' || base.password !== '' || /[?#\u0000-\u001f\u007f]/.test(baseURL)
    || baseURL !== baseURL.trim()) {
    throw new LlmError('model discovery baseURL must be HTTP(S) without credentials, query, or fragment', 'DISCOVERY_FAILED')
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/models`
  return base.href
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working endpoint's catalog.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * 校验一个探测密钥，不合格时在构造标头之前拒绝。缺了这一步，下面的 `fetch`
 * 会抛 ByteString `TypeError`，被当成「读不到端点」，把本地确定的错误说成网络问题。
 * @param raw - 表单里输入或从存储读到的一次性密钥。
 * @returns 去掉首尾空白后可直接使用的密钥。
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * 一次尝试自己的窗口：调用方取消与本次超时合并成一个信号，并记下是哪一个到期。
 */
interface ProbeWindow {
  /** 这次尝试使用的信号。 */
  signal: AbortSignal
  /** 本次自己的超时是否到期（调用方取消不算）。 */
  expired: () => boolean
  /** 停表并解除调用方监听。 */
  close: () => void
}

/**
 * 开一个受限窗口。
 * @param caller - 已接上调用方取消的信号。
 * @param timeoutMs - 本次窗口的上限。
 * @returns 窗口信号、到期判定与清理函数。
 */
function probeWindow(caller: AbortSignal, timeoutMs: number): ProbeWindow {
  const controller = new AbortController()
  let expired = false
  const onAbort = (): void => { controller.abort(caller.reason) }
  caller.addEventListener('abort', onAbort, { once: true })
  if (caller.aborted) onAbort()
  const timer = setTimeout(() => {
    expired = true
    controller.abort(new Error('model discovery attempt expired'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    expired: () => expired,
    close: () => {
      clearTimeout(timer)
      caller.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 发出一次探测请求并解析清单。端点已经给出的答案（状态码、非 JSON、清单结构）
 * 以 {@link LlmError} 抛出，传输层失败原样抛出，由调用方决定是否重试。
 * @param url - GET /models 地址。
 * @param headers - 本次探测的请求标头。
 * @param signal - 本次尝试的窗口信号（调用方取消与本次超时的合并）。
 * @returns 端点返回顺序的候选模型。
 */
async function attemptListing(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  const response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal })
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  const text = await readBounded(response, url)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}

/**
 * 把取消信号变成一次拒绝，用来与非取消式的 Promise（凭据读取）竞速。
 * @param signal - 本次尝试的窗口信号。
 * @returns 信号生效时以它的原因为由拒绝的 Promise。
 */
function windowAborted(signal: AbortSignal): Promise<never> {
  const reason = (): Error => signal.reason instanceof Error ? signal.reason : new Error('model discovery aborted')
  if (signal.aborted) return Promise.reject(reason())
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(reason()) }, { once: true })
  })
}

/**
 * 读取已保存路由的密钥，并让读取同样受一次尝试的上限约束。凭据服务没有取消信号，
 * race 会丢弃它迟到的结果，因此窗口结束后绝不会再发出请求。
 * @param url - 本次探测地址，只用于失败说明。
 * @param saved - 已保存路由的凭据解析器。
 * @param callerSignal - 已接上调用方取消的探测信号。
 * @param caller - 调用方原始信号，用来区分「用户取消」与「本地超时」。
 * @returns 存储的密钥；没有存储时为 undefined。
 * @throws LlmError 调用方取消、读取超时或读取失败时抛出。
 */
async function storedProbeKey(
  url: string,
  saved: { apiKey: () => Promise<string | undefined> },
  callerSignal: AbortSignal,
  caller: AbortSignal | undefined,
): Promise<string | undefined> {
  const window = probeWindow(callerSignal, ATTEMPT_TIMEOUT_MS)
  try {
    return await Promise.race([Promise.resolve().then(saved.apiKey), windowAborted(window.signal)])
  } catch (error: unknown) {
    if (caller?.aborted === true) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    // 读本地凭据超时不是网络问题：重试只会在同一个地方再等一次。
    if (window.expired()) {
      throw new LlmError(
        `${url} model discovery timed out after ${String(ATTEMPT_TIMEOUT_MS / 1000)}s while reading this provider's stored API key`,
        'DISCOVERY_FAILED',
        { cause: error },
      )
    }
    if (error instanceof LlmError) throw error
    throw new LlmError(
      `could not read this provider's stored API key for ${url}`,
      'DISCOVERY_FAILED',
      { cause: error },
    )
  } finally {
    window.close()
  }
}

/**
 * 读取草稿端点公布的模型，不保存候选结果。
 *
 * 传输失败与超时会换连接重试一次；两次都失败时，失败说明区分「一直没响应」
 * 与「连接直接失败」，后者用 `errorChain` 带上 `cause` 链里的底层原因。
 * @param request - 草稿端点、协议、一次性凭据及取消信号。
 * @param storedRoute - 已保存的端点及其凭据解析器，仅在草稿端点与之相同时读取凭据。
 * @param requestUserAgent - 本次请求的 User-Agent；调用方的渠道级配置解析在这里，
 *   缺省用产品默认值。
 * @returns 端点返回顺序的候选模型。
 * @throws LlmError 协议不支持、端点无效或失败、响应无效、超时及调用方取消时抛出。
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedRoute?: () => {
    baseURL: string
    api?: string
    hasStoredKey: boolean
    apiKey: () => Promise<string | undefined>
  } | undefined,
  requestUserAgent: string = userAgent(),
): Promise<readonly LlmDiscoveredModel[]> {
  const saved = storedRoute?.()
  const baseURL = request.baseURL ?? saved?.baseURL ?? (
    request.provider === undefined ? undefined : catalogProvider(request.provider)?.baseUrl
  )
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `no model listing endpoint for provider "${request.provider ?? ''}"; set a baseURL or enter its models by hand`,
      'DISCOVERY_FAILED',
    )
  }
  // 未声明协议的全新草稿按 OpenAI Chat Completions 探测；不支持此格式时需手工录入。
  const api = request.api ?? saved?.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(baseURL)
  // 不将旧路由的密钥发送至正在编辑的新端点；草稿自带一次性密钥仍可探测。
  if (request.apiKey === undefined && saved?.hasStoredKey && listingUrl(saved.baseURL) !== url) {
    throw new LlmError(`${url} differs from the saved endpoint; enter an API key for this probe`, 'DISCOVERY_FAILED')
  }
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort(request.signal?.reason) }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  if (request.signal?.aborted) onAbort()
  try {
    let supplied = request.apiKey
    if (supplied === undefined && saved !== undefined) {
      supplied = await storedProbeKey(url, saved, controller.signal, request.signal)
    }
    controller.signal.throwIfAborted()
    const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      'user-agent': requestUserAgent,
    }
    // 只有超时与传输失败进入下一次尝试：端点已经给出的答案（状态码、非 JSON、
    // 清单结构）重试只会重复同一结果。
    let stalled = false
    let lastError: unknown
    for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt++) {
      const window = probeWindow(controller.signal, ATTEMPT_TIMEOUT_MS)
      try {
        return await attemptListing(url, headers, window.signal)
      } catch (error: unknown) {
        if (request.signal?.aborted === true) {
          throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        lastError = error
        stalled = window.expired()
      } finally {
        window.close()
      }
    }
    if (stalled) {
      throw new LlmError(
        `${url} did not answer within ${String(ATTEMPT_TIMEOUT_MS * DISCOVERY_ATTEMPTS / 1000)}s`
        + ` (${String(DISCOVERY_ATTEMPTS)} attempts); check the endpoint, and the network or VPN this machine is on`,
        'DISCOVERY_FAILED',
        { cause: lastError },
      )
    }
    throw new LlmError(`could not read ${url}: ${errorChain(lastError)}`, 'DISCOVERY_FAILED', { cause: lastError })
  } catch (error: unknown) {
    if (request.signal?.aborted === true) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
  }
}
