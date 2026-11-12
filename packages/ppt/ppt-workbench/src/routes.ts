/**
 * `/api/ppt/*` HTTP 路由：右侧工作台读写工程、导出与确认模型打开请求的唯一通道。
 *
 * 每个 handler 先过连接层与本机同源栅栏，再读载荷；返回体一律是 `{ ok, ... }`，
 * 失败带 `{ ok: false, error: { code, message } }`，面板按键解释而不靠猜。
 * @module coding-ppt-workbench/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-connection'
import { DEFAULT_FONT_FAMILY, PptModelError } from 'coding-ppt-model'
import { BUILTIN_TEMPLATE_PREVIEW } from './builtin-templates.ts'
import { createDefaultDeck } from './default-template.ts'
import { PptStoreError, type PptSnapshot } from './store.ts'
import type PptProjects from './index.ts'

const PREFIX = '/api/ppt/'
const MAX_BODY = 16 * 1024 * 1024
const STATES: Readonly<Record<PptStoreError['code'], number>> = {
  'not-found': 404,
  conflict: 409,
  forbidden: 403,
  'bad-request': 400,
}

interface Reply {
  readonly status: number
  readonly body: unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function fail(reason: unknown): Reply {
  if (reason instanceof PptStoreError) {
    return { status: STATES[reason.code], body: { ok: false, error: { code: reason.code, message: reason.message } } }
  }
  if (reason instanceof PptModelError) {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: reason.message } } }
  }
  const message = reason instanceof Error ? reason.message : String(reason)
  return { status: 500, body: { ok: false, error: { code: 'internal', message } } }
}

/**
 * 连接层与本机同源栅栏：只接受当前 Host 端口上的回环请求。
 * @param ctx - 宿主上下文。
 * @param req - HTTP 请求。
 * @param res - HTTP 响应；被拒绝时已写出状态码。
 * @returns 请求可信时为 true。
 */
function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end()
    return false
  }
  const authority = req.headers.host
  const port = ctx.webServer.port
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  if (ctx.webServer.host !== '127.0.0.1'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || !allowed.includes(authority ?? '')
    || (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`)) {
    res.writeHead(403)
    res.end()
    return false
  }
  return true
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY) throw new PptStoreError('bad-request', '请求体超过 16MiB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PptStoreError('bad-request', '请求体不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PptStoreError('bad-request', '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

function sessionIdOf(source: Record<string, unknown>): string {
  const value = source.sessionId
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new PptStoreError('bad-request', 'sessionId 必须是非空字符串')
  }
  return value
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new PptStoreError('bad-request', `${what} 必须是非空字符串`)
  return value
}

function optionalNumber(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PptStoreError('bad-request', `${what} 必须是整数`)
  }
  return value
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml',
}

function mediaType(source: string): string {
  const ext = source.split('.').pop()?.toLowerCase() ?? 'png'
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

function snapshotBody(snapshot: PptSnapshot): unknown {
  return { ok: true, project: snapshot }
}

/**
 * 注册全部 PPT 路由。
 * @param ctx - 宿主上下文，需提供 `webServer` 与 `connection`。
 * @param service - 工程服务实例。
 */
export function installRoutes(ctx: Context, service: PptProjects): void {
  const route = (path: string, methods: readonly string[], handler: (
    body: Record<string, unknown>,
    url: URL,
  ) => unknown): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}${path}`,
      handler: async (req, res) => {
        if (!trusted(ctx, req, res)) return
        const method = req.method ?? 'GET'
        if (!methods.includes(method)) {
          sendJson(res, 405, { ok: false, error: { code: 'method', message: `只接受 ${methods.join(' / ')}` } })
          return
        }
        try {
          const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.webServer.port}`)
          const body = method === 'GET' ? {} : await readJson(req)
          const payload = await handler(body, url)
          sendJson(res, 200, payload)
        } catch (reason) {
          const reply = fail(reason)
          sendJson(res, reply.status, reply.body)
        }
      },
    }), `pptWorkbench: ${methods.join('/')} ${PREFIX}${path}`)
  }

  route('state', ['GET'], async (_body, url) => {
    const sessionId = sessionIdOf({ sessionId: url.searchParams.get('sessionId') ?? undefined })
    return { ok: true, state: await service.state(sessionId) }
  })

  route('templates', ['GET'], async () => ({ ok: true, templates: await service.listTemplates() }))

  route('templates/builtins', ['GET'], () => ({ ok: true, deck: BUILTIN_TEMPLATE_PREVIEW }))

  route('templates/default', ['GET'], () => ({ ok: true, deck: createDefaultDeck('演示文稿标题') }))

  // 字体下拉只列本机已安装的族名；默认黑体单独给出，未安装时也能选中。
  route('fonts', ['GET'], async () => ({
    ok: true, default: DEFAULT_FONT_FAMILY, fonts: await service.listFonts(),
  }))

  route('templates/detail', ['GET'], async (_body, url) => ({
    ok: true, template: await service.readTemplate(url.searchParams.get('id') ?? ''),
  }))

  // 模板媒体只作为图片提供，SVG 等可执行同源资源不经此路由输出。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}templates/media`,
    handler: async (req, res) => {
      if (!trusted(ctx, req, res)) return
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 GET' } })
        return
      }
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.webServer.port}`)
        const id = url.searchParams.get('id') ?? ''
        const source = url.searchParams.get('path') ?? ''
        if (source === '') throw new PptStoreError('bad-request', '模板媒体 path 必须提供')
        const type = MEDIA_TYPES[source.split('.').pop()?.toLowerCase() ?? '']
        if (type === undefined || type === 'image/svg+xml') {
          throw new PptStoreError('forbidden', '模板媒体只允许 PNG、JPEG、GIF 或 WebP 图片')
        }
        const bytes = await service.templateMedia(id, source)
        res.writeHead(200, {
          'content-type': type,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        res.end(Buffer.from(bytes))
      } catch (reason) {
        const reply = fail(reason)
        sendJson(res, reply.status, reply.body)
      }
    },
  }), `pptWorkbench: GET ${PREFIX}templates/media`)

  route('open', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    const dir = optionalString(body.dir, 'dir')
    if (dir === undefined) throw new PptStoreError('bad-request', 'dir 必须提供')
    return snapshotBody(await service.open(sessionId, dir))
  })

  route('create', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    const title = optionalString(body.title, 'title')
    if (title === undefined) throw new PptStoreError('bad-request', 'title 必须提供')
    const size = body.size === '4:3' || body.size === '16:9' || body.size === undefined ? body.size : null
    if (size === null) throw new PptStoreError('bad-request', 'size 必须是 16:9 或 4:3')
    const theme = body.theme === 'ink' || body.theme === 'paper' || body.theme === 'ocean'
      || body.theme === 'forest' || body.theme === 'inference' || body.theme === undefined ? body.theme : null
    if (theme === null) throw new PptStoreError('bad-request', 'theme 必须是 ink / paper / ocean / forest / inference 之一')
    const dir = optionalString(body.dir, 'dir')
    return snapshotBody(await service.create(sessionId, {
      title,
      ...size === undefined ? {} : { size },
      ...theme === undefined ? {} : { theme },
      ...dir === undefined ? {} : { dir },
    }))
  })

  route('edit', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    const baseRevision = optionalNumber(body.baseRevision, 'baseRevision')
    return snapshotBody(await service.edit(sessionId, optionalString(body.dir, 'dir'), body.ops, baseRevision))
  })

  route('undo', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    return snapshotBody(await service.undo(
      sessionId, optionalString(body.dir, 'dir'), optionalNumber(body.steps, 'steps') ?? 1,
    ))
  })

  route('redo', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    return snapshotBody(await service.redo(
      sessionId, optionalString(body.dir, 'dir'), optionalNumber(body.steps, 'steps') ?? 1,
    ))
  })

  // 图片用原始字节返回：面板直接把它当 <img src>，不需要再解 base64。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}media`,
    handler: async (req, res) => {
      if (!trusted(ctx, req, res)) return
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 GET' } })
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.webServer.port}`)
      try {
        const sessionId = sessionIdOf({ sessionId: url.searchParams.get('sessionId') ?? undefined })
        const dir = url.searchParams.get('dir') ?? undefined
        const source = url.searchParams.get('path') ?? ''
        const bytes = await service.media(sessionId, dir, source)
        if (bytes === undefined) {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `找不到图片 ${source}` } })
          return
        }
        res.writeHead(200, { 'content-type': mediaType(source), 'cache-control': 'max-age=60' })
        res.end(Buffer.from(bytes))
      } catch (reason) {
        const reply = fail(reason)
        sendJson(res, reply.status, reply.body)
      }
    },
  }), `pptWorkbench: GET ${PREFIX}media`)

  route('upload', ['POST'], async (body, url) => {
    const sessionId = sessionIdOf({ sessionId: url.searchParams.get('sessionId') ?? undefined })
    const name = optionalString(body.name, 'name')
    const base64 = optionalString(body.base64, 'base64')
    if (name === undefined || base64 === undefined) {
      throw new PptStoreError('bad-request', 'name 与 base64 必须提供')
    }
    const bytes = Buffer.from(base64, 'base64')
    const source = await service.upload(sessionId, optionalString(body.dir, 'dir'), name, bytes)
    return { ok: true, source }
  })

  route('render', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    const pages = Array.isArray(body.pages)
      ? body.pages.map(entry => optionalNumber(entry, 'pages[]') ?? 0)
      : undefined
    return { ok: true, pages: await service.render(sessionId, optionalString(body.dir, 'dir'), pages) }
  })

  route('check', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    return { ok: true, check: await service.check(sessionId, optionalString(body.dir, 'dir')) }
  })

  route('import', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    const source = optionalString(body.source, 'source')
    if (source === undefined) throw new PptStoreError('bad-request', 'source 必须提供')
    const dir = optionalString(body.dir, 'dir')
    const title = optionalString(body.title, 'title')
    const imported = await service.import(sessionId, source, {
      ...dir === undefined ? {} : { dir },
      ...title === undefined ? {} : { title },
    })
    return { ok: true, project: imported.snapshot, dropped: imported.dropped }
  })

  route('export', ['POST'], async (body) => {
    const sessionId = sessionIdOf(body)
    if (body.target === 'pdf') {
      return { ok: true, export: await service.exportPdf(sessionId, optionalString(body.dir, 'dir')) }
    }
    return {
      ok: true,
      export: await service.export(sessionId, optionalString(body.dir, 'dir'), {
        skipCheck: body.skipCheck === true,
      }),
    }
  })

  route('ack', ['POST'], (body) => {
    const sessionId = sessionIdOf(body)
    const at = optionalNumber(body.at, 'at')
    if (at === undefined) throw new PptStoreError('bad-request', 'at 必须提供')
    service.ackOpenRequest(sessionId, at)
    return Promise.resolve({ ok: true })
  })
}
