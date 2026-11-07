/** 回环同源图像路由：先校验连接与会话，再读取 body、附件或调用提供方。@module coding-image-gen/routes */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import { SessionId } from 'coding-session/types'
import { isImageAdmissionError, type ImageMediaType } from 'coding-attachment'
import { CanvasConflictError, galleryItems, parseCanvasState } from './gallery.ts'
import type { ImageGeneration } from './index.ts'
import { ImageGenerationUnavailableError } from './index.ts'

const PREFIX = '/api/image-gen'
const BODY_LIMIT = 64 * 1024
const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}
function fail(res: ServerResponse, code: number, message: string): void { json(res, code, { error: message }) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function fields(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}

/** 避免外部页面、DNS 重绑定和局域网调用访问私有图像及发起出站请求。 */
function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejected = ctx.connection.requestRejection(req)
  if (rejected !== undefined) { res.writeHead(rejected); res.end(); return false }
  const port = ctx.webServer.port
  const host = req.headers.host
  if (ctx.webServer.host !== '127.0.0.1'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')
    || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
    res.writeHead(403); res.end(); return false
  }
  return true
}

function sessionId(value: unknown): SessionId | undefined {
  return typeof value === 'string' && SESSION_ID.test(value) ? SessionId(value) : undefined
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new TypeError('请求必须为 JSON')
  }
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += (part as Buffer).byteLength
    if (size > BODY_LIMIT) { req.resume(); throw new TypeError('请求数据过大') }
    parts.push(Buffer.from(part as Uint8Array))
  }
  try { return JSON.parse(Buffer.concat(parts, size).toString('utf8')) as unknown }
  catch { throw new TypeError('请求 JSON 无效') }
}

/** 上传原图的字节预算来自附件服务，不复用 JSON 文档的 64 KiB 上限。 */
async function imageBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += (part as Buffer).byteLength
    if (size > maxBytes) { req.resume(); throw new TypeError('参考图片超过服务端单张字节限额') }
    parts.push(Buffer.from(part as Uint8Array))
  }
  if (size === 0) throw new TypeError('参考图片不能为空')
  return Buffer.concat(parts, size)
}

/** 为每个明确的路径装载可释放路由；不占用共享 /api 前缀。 */
export function installImageRoutes(ctx: Context, service: ImageGeneration): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const handlers = new Map<string, Map<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>>>()
    const route = (path: string, method: string, handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>): void => {
      let methods = handlers.get(path)
      if (!methods) {
        methods = new Map()
        handlers.set(path, methods)
        const registered = methods
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: `${PREFIX}/${path}`, handler: async (req, res) => {
          if (!trusted(webCtx, req, res)) return
          const selected = registered.get(req.method ?? '')
          if (!selected) { res.writeHead(405, { allow: [...registered.keys()].join(', ') }); res.end(); return }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          try { await selected(req, res, url) }
          catch (error) {
            if (error instanceof CanvasConflictError) { fail(res, 409, '画布已变化，请刷新后重试'); return }
            if (error instanceof TypeError) { fail(res, 400, error.message); return }
            if (isImageAdmissionError(error)) { fail(res, 400, '参考图片不符合当前图像准入限制'); return }
            if (error instanceof ImageGenerationUnavailableError) {
              fail(res, 503, '请先在设置中启用并配置图像生成服务'); return
            }
            webCtx.logger.warn('image-generation request failed', error)
            fail(res, 502, '图片操作失败，请稍后重试')
          }
        } }), `image-generation: ${path}`)
      }
      methods.set(method, handler)
    }
    const querySession = (url: URL): SessionId => {
      const id = sessionId(url.searchParams.get('sessionId'))
      if (id === undefined) throw new TypeError('会话标识无效')
      return id
    }
    route('state', 'GET', async (_req, res, url) => {
      const id = querySession(url)
      if (url.searchParams.size !== 1 || await service.sessionEvents(id) === undefined) { fail(res, 404, '会话不存在'); return }
      json(res, 200, { ...(await service.status()), sizes: service.outputSizes(), maxEditReferences: service.maxEditReferences() })
    })
    route('gallery', 'GET', async (_req, res, url) => {
      const id = querySession(url)
      const events = url.searchParams.size === 1 ? await service.sessionEvents(id) : undefined
      if (!events) { fail(res, 404, '会话不存在'); return }
      json(res, 200, { enabled: (await service.status()).available, items: galleryItems(events) })
    })
    route('image', 'GET', async (_req, res, url) => {
      const id = querySession(url), imageId = url.searchParams.get('id')
      const events = url.searchParams.size === 2 ? await service.sessionEvents(id) : undefined
      if (!events || imageId === null) { fail(res, 404, '图片不存在'); return }
      const stored = await service.readImage(events, imageId)
      if (!stored) { fail(res, 404, '图片不存在'); return }
      res.writeHead(200, { 'content-type': stored.ref.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
      res.end(Buffer.from(stored.data))
    })
    route('import', 'POST', async (req, res, url) => {
      const id = querySession(url)
      if (url.searchParams.size !== 1) throw new TypeError('参考图片请求参数无效')
      const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (!IMAGE_TYPES.includes(mediaType as ImageMediaType)) throw new TypeError('参考图片格式不受支持')
      const session = webCtx.sessions.get(id)
      if (!session) { fail(res, 404, '请先打开会话后再导入参考图片'); return }
      const limits = webCtx.attachments.imageLimits
      const bytes = await imageBody(req, limits.maxSourceImageBytes ?? limits.maxImageBytes)
      const item = await service.importReference(session, { data: bytes, mediaType: mediaType as ImageMediaType })
      json(res, 200, { item })
    })
    route('canvas', 'GET', async (_req, res, url) => {
      const id = querySession(url)
      const events = url.searchParams.size === 1 ? await service.sessionEvents(id) : undefined
      if (!events) { fail(res, 404, '会话不存在'); return }
      json(res, 200, service.canvas(events))
    })
    route('canvas', 'PUT', async (req, res, url) => {
      const id = querySession(url)
      if (url.searchParams.size !== 1) throw new TypeError('画布请求参数无效')
      const session = webCtx.sessions.get(id)
      if (!session) { fail(res, 404, '请先打开会话后再保存画布'); return }
      const payload = record(await body(req))
      if (!payload || !fields(payload, ['revision', 'state'], ['revision', 'state'])
        || !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0) {
        throw new TypeError('画布修订格式无效')
      }
      const state = parseCanvasState(payload.state, galleryItems(session.events))
      json(res, 200, service.saveCanvas(session, payload.revision as number, state))
    })
    for (const kind of ['generate', 'edit'] as const) route(kind, 'POST', async (req, res, url) => {
      if (url.searchParams.size !== 0) throw new TypeError('生成请求不能包含查询参数')
      const payload = record(await body(req))
      if (!payload || !fields(payload, kind === 'edit' ? ['sessionId', 'prompt', 'imageId', 'imageIds', 'size', 'quality'] : ['sessionId', 'prompt', 'size', 'quality'],
        ['sessionId', 'prompt'])) throw new TypeError('生成参数无效')
      const id = sessionId(payload.sessionId)
      if (id === undefined || typeof payload.prompt !== 'string'
        || (kind === 'edit' && (Object.hasOwn(payload, 'imageId') === Object.hasOwn(payload, 'imageIds')
          || payload.imageId !== undefined && typeof payload.imageId !== 'string'
          || payload.imageIds !== undefined && (!Array.isArray(payload.imageIds) || payload.imageIds.length < 1
            || payload.imageIds.length > 10 || !payload.imageIds.every(value => typeof value === 'string'))))
        || (payload.size !== undefined && typeof payload.size !== 'string')
        || (payload.quality !== undefined && typeof payload.quality !== 'string')) throw new TypeError('生成参数无效')
      const session = webCtx.sessions.get(id)
      if (!session) { fail(res, 404, '请先打开会话后再生成图片'); return }
      const sources = kind === 'edit' ? payload.imageIds as string[] | undefined ?? [payload.imageId as string] : []
      const item = await service.create(session, payload.prompt, sources, AbortSignal.any([AbortSignal.timeout(120_000)]), {
        ...(payload.size === undefined ? {} : { size: payload.size }),
        ...(payload.quality === undefined ? {} : { quality: payload.quality }),
      })
      json(res, 200, { item })
    })
  })
}
