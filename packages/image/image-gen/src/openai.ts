/** OpenAI Images generations/edits 适配：只接受有界图片，下载跳转不得转发提供方凭据。@module coding-image-gen/openai */
import type { ImageMediaType, SaveImageAttachment } from 'coding-attachment'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const MAX_ERROR_BYTES = 1024
const IMAGE_TYPES = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOWNLOAD_TIMEOUT_MS = 15_000
const MAX_DOWNLOAD_REDIRECTS = 3

function imageUrl(raw: string, base?: URL): URL {
  let url: URL
  try { url = new URL(raw, base) }
  catch { throw new Error('图片服务返回无效图片地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('图片服务返回不受信任的图片地址')
  }
  return url
}

async function downloadImage(location: URL, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  let current = location
  for (let redirect = 0; redirect <= MAX_DOWNLOAD_REDIRECTS; redirect++) {
    const response = await downloadResponse(current, combined)
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (redirect === MAX_DOWNLOAD_REDIRECTS || typeof response.headers.location !== 'string') {
          throw new Error('图片下载跳转过多或缺少目标')
        }
        current = imageUrl(response.headers.location, current)
        continue
      }
      if (response.statusCode !== 200) throw new Error(`图片下载失败（HTTP ${response.statusCode ?? 0}）`)
      const length = Number(response.headers['content-length'])
      if (Number.isFinite(length) && length > maxBytes) throw new Error('图片服务返回的数据超过允许大小')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for await (const chunk of response) {
          size += (chunk as Buffer).byteLength
          if (size > maxBytes) throw new Error('图片服务返回的数据超过允许大小')
          chunks.push(chunk as Buffer)
        }
      } catch (error) {
        if (error instanceof Error && error.message === '图片服务返回的数据超过允许大小') throw error
        throw new Error('图片下载失败')
      }
      return Buffer.concat(chunks, size)
    } finally {
      response.destroy()
    }
  }
  throw new Error('图片下载跳转过多')
}

async function downloadResponse(location: URL, signal: AbortSignal): Promise<import('node:http').IncomingMessage> {
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (location.protocol === 'https:' ? httpsRequest : httpRequest)(location, {
      method: 'GET', agent: false, signal,
    }, resolve)
    request.on('error', reject)
    request.end()
  }).catch(() => { throw new Error('图片下载失败') })
  return response
}

/** 设置中的端点是含 `/v1` 的 API 根；HTTP(S) 主机由使用者自行选择与信任。 */
export function imageEndpoint(base: string, kind: 'generations' | 'edits'): string {
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname === '' || url.username || url.password
    || url.search || url.hash) {
    throw new TypeError('图像端点必须是主机非空且不带凭据、查询参数或片段的 HTTP(S) 地址')
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

async function parseResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<SaveImageAttachment> {
  // 兼容 data/images 等多个编码副本，但仍为 JSON 整体设定上限。
  const maxJsonBytes = Math.ceil(maxBytes / 3) * 16 + 4096
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
  } else if (typeof first.url === 'string' && first.url.toLowerCase().startsWith('data:')) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/=]*)$/i.exec(first.url)
    if (!match) throw new Error('图片服务返回无效图像数据地址')
    bytes = decodeImage(match[1] ?? '', maxBytes)
  } else if (typeof first.url === 'string') {
    const location = imageUrl(first.url)
    bytes = await downloadImage(location, maxBytes, signal)
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
  size?: string
  quality?: string
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
    body = JSON.stringify({ model: options.model, prompt: options.prompt, n: 1, response_format: 'b64_json',
      ...options.size === undefined ? {} : { size: options.size },
      ...options.quality === undefined ? {} : { quality: options.quality } })
  } else {
    const form = new FormData()
    form.append('model', options.model)
    form.append('prompt', options.prompt)
    form.append('response_format', 'b64_json')
    if (options.size !== undefined) form.append('size', options.size)
    if (options.quality !== undefined) form.append('quality', options.quality)
    for (const [index, source] of options.sources.entries()) {
      form.append(options.sources.length > 1 ? 'image[]' : 'image',
        new Blob([Buffer.from(source.data)], { type: source.mediaType }), `reference-${index + 1}.${source.mediaType.slice(6)}`)
    }
    body = form
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: options.signal })
  return parseResponse(response, options.maxBytes, options.signal)
}
