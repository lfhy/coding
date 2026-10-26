/** DeepSeek 模型列表探测：草稿端点与凭据只用于本次请求，不写入设置。 */
import { assertUsableApiKey, errorChain, LlmError } from 'coding-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from 'coding-llm'
import type { DeepSeekConnectionOptions } from './adapter.ts'
import { dispatcherOf } from './outbound.ts'
import type { DeepSeekOutbound, DeepSeekOutboundConfig } from './outbound.ts'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * 每次尝试的沉默上限。端点通常毫秒级回答，但网关冷启动、DNS 答到不可达地址、
 * 中间设备丢弃闲置连接都会长时间没有响应，所以按次计时而不是给整个动作一个
 * 总上限：故障在第二次尝试上消失时，用户仍能拿到清单。
 */
const ATTEMPT_TIMEOUT_MS = 10_000
/** `{@link ATTEMPT_TIMEOUT_MS}` 之上的尝试次数：一次重试覆盖一次性故障。 */
const DISCOVERY_ATTEMPTS = 2

/** 一次尝试的窗口：调用方取消与本次上限合并，并记下本次上限是否到期。 */
interface AttemptWindow {
  /** 这次尝试使用的信号。 */
  signal: AbortSignal
  /** 本次自己的上限是否到期（调用方取消不算）。 */
  expired: () => boolean
}

/**
 * 开一次尝试的窗口。
 * @param caller - 调用方的取消信号；省略时只有本次上限生效。
 * @returns 窗口信号与到期判定。
 */
function attemptWindow(caller: AbortSignal | undefined): AttemptWindow {
  const deadline = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
  return {
    signal: caller === undefined ? deadline : AbortSignal.any([caller, deadline]),
    expired: () => deadline.aborted,
  }
}

function endpoint(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LlmError('Model discovery needs a valid HTTP(S) baseURL', 'INVALID_DISCOVERY')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash) {
    throw new LlmError('Model discovery baseURL must be HTTP(S) without credentials, query, or fragment', 'INVALID_DISCOVERY')
  }
  return url
}

function listingUrl(base: URL): string {
  const path = base.pathname.replace(/\/+$/, '')
  // 公共 API 的对话端点位于根路径，模型列表则位于 /v1/models。
  const prefix = base.origin === 'https://api.deepseek.com' && path === '' ? '/v1' : path
  return `${base.origin}${prefix}/models`
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const tooLarge = (): LlmError => new LlmError('Model listing exceeds 4 MiB', 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw tooLarge()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw tooLarge()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

function parseListing(value: unknown): LlmDiscoveredModel[] {
  if (value === null || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) {
    throw new LlmError('Model listing has no data array', 'DISCOVERY_FAILED')
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of value.data) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as { id?: unknown; name?: unknown; context_window?: unknown; max_output_tokens?: unknown }
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) continue
    models.push({
      id: entry.id,
      ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
      ...Number.isSafeInteger(entry.context_window) && Number(entry.context_window) > 0
        ? { contextWindow: entry.context_window as number } : {},
      ...Number.isSafeInteger(entry.max_output_tokens) && Number(entry.max_output_tokens) > 0
        ? { maxTokens: entry.max_output_tokens as number } : {},
    })
  }
  return models
}

/** 即使操作本身不接受 signal，也及时结束等待并消费其迟到的拒绝。 */
function awaitWithSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const abortReason = (): Error => {
    const reason: unknown = signal.reason
    return reason instanceof Error ? reason : new Error('Model discovery aborted', { cause: reason })
  }
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason()
      return operation()
    }).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('Model discovery operation failed', { cause: error }))
      },
    )
  })
}

/**
 * 发出一次探测请求并解析清单。端点已经给出的答复（状态码、非 JSON、清单结构）
 * 以 {@link LlmError} 抛出；传输层失败原样抛出，由调用方决定是否重试。
 * @param url - GET /models 地址。
 * @param signal - 本次尝试的窗口信号（调用方取消与本次上限的合并）。
 * @param key - 本次探测的密钥；没有时为 undefined。
 * @param userAgent - 与对话请求同源的 User-Agent。
 * @param dispatcher - 渠道出站解析出的 dispatcher；直连时 undefined。
 * @returns 端点报告的有效模型条目。
 */
async function requestListing(
  url: string,
  signal: AbortSignal,
  key: string | undefined,
  userAgent: string,
  dispatcher: ReturnType<typeof dispatcherOf>,
): Promise<readonly LlmDiscoveredModel[]> {
  const response = await awaitWithSignal(signal, () => fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      // 与对话请求取自同一份快照，因此发现请求不会跑在另一个 UA 上。
      'user-agent': userAgent,
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
    },
    signal,
    ...dispatcher === undefined ? {} : { dispatcher },
  }))
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`Model listing answered HTTP ${response.status}`, 'DISCOVERY_FAILED')
  }
  const body = await awaitWithSignal(signal, () => readBounded(response, signal))
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new LlmError('Model listing is not JSON', 'DISCOVERY_FAILED', { cause: error })
  }
  return parseListing(parsed)
}

/**
 * 读取草稿端点的官方模型列表；改动端点时绝不复用原端点存储的密钥。
 *
 * 传输失败与本次上限到期会换连接重试一次；两次都失败时，失败说明区分「一直没响应」
 * 与「连接直接失败」，后者带上 `cause` 链里的底层原因。
 * @param request - 本次发现的草稿地址、可选临时密钥与取消信号。
 * @param connection - 同一有效设置快照中的端点、凭据引用与 User-Agent。
 * @param resolveApiKey - 从该快照解析受管理的凭据。
 * @param resolveOutbound - 渠道出站的解析钩子；缺省按直连。
 * @returns 端点报告的有效模型条目。
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  connection: DeepSeekConnectionOptions,
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>,
  resolveOutbound?: (selection: DeepSeekOutboundConfig) => DeepSeekOutbound,
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.provider !== undefined && request.provider !== 'deepseek-official') {
    throw new LlmError(`Model discovery cannot query provider "${request.provider}"`, 'INVALID_DISCOVERY')
  }
  const base = endpoint(request.baseURL ?? connection.baseURL)
  const url = listingUrl(base)
  const storedBase = endpoint(connection.baseURL)
  let key: string | undefined
  if (request.apiKey !== undefined) {
    key = assertUsableApiKey(request.apiKey, 'llm-deepseek discovery', connection.apiKeyEnv)
  } else if (base.href === storedBase.href) {
    // 凭据读取同样受一次尝试的上限约束，并且不随重试重放：读本地凭据不是网络动作。
    const window = attemptWindow(request.signal)
    try {
      key = await awaitWithSignal(window.signal, () => resolveApiKey(connection))
    } catch (error) {
      if (request.signal?.aborted === true) throw new LlmError('Model discovery aborted', 'ABORTED', { cause: error })
      if (window.expired()) {
        throw new LlmError(
          `${url} did not answer within ${String(ATTEMPT_TIMEOUT_MS / 1000)}s while reading this route's stored API key`,
          'DISCOVERY_FAILED',
          { cause: error },
        )
      }
      throw error instanceof LlmError
        ? error
        : new LlmError(`could not read this route's stored API key for ${url}`, 'DISCOVERY_FAILED', { cause: error })
    }
  }
  // 目录探测与对话请求走同一条渠道出站：自定义代理或内置代理池同样生效。
  const dispatcher = dispatcherOf(resolveOutbound?.(connection.outbound) ?? { kind: 'direct' })
  // 只有超时与传输失败进入下一次尝试：端点已经给出的答案重试只会重复同一结果。
  let stalled = false
  let lastError: unknown
  for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt++) {
    const window = attemptWindow(request.signal)
    try {
      return await requestListing(url, window.signal, key, connection.userAgent, dispatcher)
    } catch (error) {
      if (request.signal?.aborted === true) throw new LlmError('Model discovery aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      lastError = error
      stalled = window.expired()
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
}
