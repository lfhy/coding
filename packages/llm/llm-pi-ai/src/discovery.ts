/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * 仅向当前草稿明确指定、或已配置路由保存的端点发送 GET /models。
 * 已安装目录仅提供缺省端点，不充当网络查询结果。
 *
 * 查询不会刷新服务目录：草稿与候选结果都不写入 settings.yaml。
 *
 * 仅探测具有 OpenAI 兼容 GET /models 格式的协议，其余协议要求手工录入。
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'

/**
 * Protocols whose model listing this module can read: the two that speak
 * OpenAI's `GET /models` shape with bearer auth. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 * pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DISCOVERY_TIMEOUT_MS = 10_000

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
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
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
 * 读取草稿端点公布的模型，不保存候选结果。
 * @param request - 草稿端点、协议、一次性凭据及取消信号。
 * @param storedRoute - 已保存的端点及其凭据解析器，仅在草稿端点与之相同时读取凭据。
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
  const timeout = setTimeout(() => { controller.abort(new Error('model discovery timed out')) }, DISCOVERY_TIMEOUT_MS)
  try {
    let supplied = request.apiKey
    if (supplied === undefined && saved !== undefined) {
      let rejectOnAbort: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => {
          reject(controller.signal.reason instanceof Error
            ? controller.signal.reason : new Error('model discovery aborted'))
        }
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
        if (controller.signal.aborted) rejectOnAbort()
      })
      try {
        // 凭据服务没有取消信号；race 会处理其迟到的拒绝，超时后不会发出请求。
        supplied = await Promise.race([Promise.resolve().then(saved.apiKey), aborted])
      } finally {
        controller.signal.removeEventListener('abort', rejectOnAbort)
      }
    }
    controller.signal.throwIfAborted()
    const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      signal: controller.signal,
    })
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
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    if (controller.signal.aborted) {
      throw new LlmError(`${url} model discovery timed out`, 'DISCOVERY_FAILED', { cause: error })
    }
    if (error instanceof LlmError) throw error
    throw new LlmError(`could not read ${url}`, 'DISCOVERY_FAILED', { cause: error })
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
