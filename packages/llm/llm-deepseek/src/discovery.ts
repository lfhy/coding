/** DeepSeek 模型列表探测：草稿端点与凭据只用于本次请求，不写入设置。 */
import { assertUsableApiKey, attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions } from './adapter.ts'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 10_000

function endpoint(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LlmError('DeepSeek model discovery needs a valid HTTP(S) baseURL', 'INVALID_DISCOVERY')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash) {
    throw new LlmError('DeepSeek model discovery baseURL must be HTTP(S) without credentials, query, or fragment', 'INVALID_DISCOVERY')
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
  const tooLarge = (): LlmError => new LlmError('DeepSeek model listing exceeds 4 MiB', 'DISCOVERY_FAILED')
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
    throw new LlmError('DeepSeek model listing has no data array', 'DISCOVERY_FAILED')
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
    return reason instanceof Error ? reason : new Error('DeepSeek discovery aborted', { cause: reason })
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
        reject(error instanceof Error ? error : new Error('DeepSeek discovery operation failed', { cause: error }))
      },
    )
  })
}

/**
 * 读取草稿端点的官方模型列表；改动端点时绝不复用原端点存储的密钥。
 * @param request - 本次发现的草稿地址、可选临时密钥与取消信号。
 * @param connection - 同一有效设置快照中的端点和凭据引用。
 * @param resolveApiKey - 从该快照解析受管理的凭据。
 * @returns 端点报告的有效模型条目。
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  connection: DeepSeekConnectionOptions,
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>,
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.provider !== undefined && request.provider !== 'deepseek-official') {
    throw new LlmError(`DeepSeek discovery cannot query provider "${request.provider}"`, 'INVALID_DISCOVERY')
  }
  const base = endpoint(request.baseURL ?? connection.baseURL)
  const url = listingUrl(base)
  const storedBase = endpoint(connection.baseURL)
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(request.signal === undefined ? [] : [request.signal]),
  ])
  try {
    if (signal.aborted) throw signal.reason
    const key = request.apiKey === undefined
      ? base.href === storedBase.href
        ? await awaitWithSignal(signal, () => resolveApiKey(connection)) : undefined
      : assertUsableApiKey(request.apiKey, 'llm-deepseek discovery', connection.apiKeyEnv)
    const response = await awaitWithSignal(signal, () => fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        ...attributionHeaders(),
        ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      },
      signal,
    }))
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError(`DeepSeek model listing answered HTTP ${response.status}`, 'DISCOVERY_FAILED')
    }
    const body = await awaitWithSignal(signal, () => readBounded(response, signal))
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      throw new LlmError('DeepSeek model listing is not JSON', 'DISCOVERY_FAILED', { cause: error })
    }
    return parseListing(parsed)
  } catch (error) {
    if (request.signal?.aborted) throw new LlmError('DeepSeek model discovery aborted', 'ABORTED', { cause: error })
    if (signal.aborted) throw new LlmError('DeepSeek model discovery timed out', 'DISCOVERY_FAILED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError(`DeepSeek model discovery failed for ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
}
