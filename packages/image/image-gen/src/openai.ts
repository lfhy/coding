/** OpenAI Images generations/edits 适配：只接受有界图片，不跟随重定向或转发凭据。@module coding-image-gen/openai */
import type { ImageMediaType, SaveImageAttachment } from 'coding-attachment'
import { isIP } from 'node:net'

const MAX_ERROR_BYTES = 1024
const IMAGE_TYPES = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 设置中的端点是含 `/v1` 的 API 根；无鉴权本地 HTTP 仅允许回环字面量。 */
export function imageEndpoint(base: string, kind: 'generations' | 'edits'): string {
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('图像端点必须是不带凭据与参数的 HTTP(S) 地址')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  // 字面量私网地址和单标签主机不作为公共 HTTPS 端点；本地只支持明确的回环名称。
  if ((url.protocol === 'http:' && !loopback) || (!loopback && (isIP(url.hostname) !== 0 || !url.hostname.includes('.')))) {
    throw new TypeError('图像端点必须使用公开 HTTPS 或本机回环 HTTP(S) 地址')
  }
  const root = url.toString().replace(/\/+$/, '')
  return `${root}/images/${kind}`
}

/** 受限读取响应体；头部声明不可信，流读取也在每块后累计检查。 */
async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body === null) throw new Error('图片服务返回空响应')
  for await (const raw of response.body) {
    const chunk = raw as Uint8Array
    size += chunk.byteLength
    if (size > maxBytes) {
      throw new Error('图片服务返回的数据超过允许大小')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function imageType(data: Uint8Array): ImageMediaType {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg'
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a') return 'image/gif'
  throw new Error('图片服务返回不支持的格式')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function decodeImage(value: string, maxBytes: number): Uint8Array {
  if (value.length < 1 || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('图片服务返回无效或过大的图像编码')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== value) {
    throw new Error('图片服务返回无效或过大的图像编码')
  }
  return bytes
}

async function parseResponse(response: Response, endpoint: string, maxBytes: number, signal: AbortSignal): Promise<SaveImageAttachment> {
  const maxJsonBytes = Math.ceil(maxBytes / 3) * 4 + 4096
  const payload = await boundedBody(response, response.ok ? maxJsonBytes : MAX_ERROR_BYTES)
  if (!response.ok) throw new Error(`图片服务请求失败（HTTP ${response.status}）`)
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as unknown }
  catch { throw new Error('图片服务返回无效响应') }
  const list = record(parsed)?.data
  const first = Array.isArray(list) ? record(list[0]) : null
  if (first === null) throw new Error('图片服务没有返回图像')
  let bytes: Uint8Array
  if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    bytes = decodeImage(first.b64_json, maxBytes)
  } else if (typeof first.url === 'string') {
    const location = new URL(first.url)
    const origin = new URL(endpoint)
    if (location.origin !== origin.origin || location.username || location.password || location.hash) {
      throw new Error('图片服务返回了不受信任的图片地址')
    }
    const download = await fetch(location, { redirect: 'error', signal })
    if (!download.ok) throw new Error(`图片下载失败（HTTP ${download.status}）`)
    bytes = await boundedBody(download, maxBytes)
  } else {
    throw new Error('图片服务没有返回图像')
  }
  const mediaType = imageType(bytes)
  if (!IMAGE_TYPES.has(mediaType)) throw new Error('图片服务返回不支持的格式')
  return { data: bytes, mediaType }
}

/** 每次请求绑定设置快照和单次解析出的密钥，空密钥不发送 Authorization。 */
export async function requestImage(options: {
  endpoint: string
  model: string
  key?: string
  prompt: string
  sources: readonly SaveImageAttachment[]
  maxBytes: number
  signal: AbortSignal
}): Promise<SaveImageAttachment> {
  const kind = options.sources.length > 0 ? 'edits' : 'generations'
  const endpoint = imageEndpoint(options.endpoint, kind)
  const headers: Record<string, string> = {}
  if (options.key) headers.authorization = `Bearer ${options.key}`
  let body: BodyInit
  if (kind === 'generations') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify({ model: options.model, prompt: options.prompt, n: 1, response_format: 'b64_json' })
  } else {
    const form = new FormData()
    form.append('model', options.model)
    form.append('prompt', options.prompt)
    form.append('response_format', 'b64_json')
    for (const [index, source] of options.sources.entries()) {
      form.append(options.sources.length > 1 ? 'image[]' : 'image',
        new Blob([Buffer.from(source.data)], { type: source.mediaType }), `reference-${index + 1}.${source.mediaType.slice(6)}`)
    }
    body = form
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: options.signal })
  return parseResponse(response, endpoint, options.maxBytes, options.signal)
}
