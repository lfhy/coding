/** 只读文件列表路由；鉴权和严格回环同源检查先于领域读取。@module coding-file-library/routes */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import { StaleNoteError, type FileLibrary } from './index.ts'

function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejected = ctx.connection.requestRejection(req)
  if (rejected !== undefined) { res.writeHead(rejected); res.end(); return false }
  const host = req.headers.host
  const port = ctx.webServer.port
  if (ctx.webServer.host !== '127.0.0.1'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')
    || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
    res.writeHead(403); res.end(); return false
  }
  return true
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

function binary(res: ServerResponse, mediaType: string, data: Uint8Array): void {
  res.writeHead(200, { 'content-type': mediaType, 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' })
  res.end(Buffer.from(data))
}

function parameter(value: string | null, fallback: number): number {
  if (value === null) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError('分页参数无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new TypeError('分页参数无效')
  return parsed
}

function optionalSessionId(value: string | null): string | undefined {
  if (value === null) return undefined
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('会话标识无效')
  }
  return value
}

function optionalKind(value: string | null): 'upload' | 'generated-image' | 'export' | 'note' | undefined {
  if (value === null) return undefined
  if (value !== 'upload' && value !== 'generated-image' && value !== 'export' && value !== 'note') throw new TypeError('文件类型无效')
  return value
}

function optionalCategory(value: string | null): 'image' | 'presentation' | 'document' | 'other' | undefined {
  if (value === null) return undefined
  if (value !== 'image' && value !== 'presentation' && value !== 'document' && value !== 'other') throw new TypeError('文件分类无效')
  return value
}

/** 按服务的插件生命周期注册可撤销的只读路由。
 * @param ctx - 持有可选 Web 服务及连接信任检查的上下文。
 * @param service - 只在通过来源检查后读取的文件库。
 */
export function installFileRoutes(ctx: Context, service: FileLibrary): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/files/list',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if ([...url.searchParams.keys()].some(key => key !== 'offset' && key !== 'limit' && key !== 'sessionId' && key !== 'scope' && key !== 'kind' && key !== 'category')
            || url.searchParams.getAll('offset').length > 1 || url.searchParams.getAll('limit').length > 1) {
            throw new TypeError('分页参数无效')
          }
          if (url.searchParams.getAll('sessionId').length > 1) throw new TypeError('会话标识无效')
          if (url.searchParams.getAll('scope').length > 1
            || url.searchParams.get('scope') !== null && url.searchParams.get('scope') !== 'unscoped') {
            throw new TypeError('文件范围无效')
          }
          if (url.searchParams.getAll('kind').length > 1) throw new TypeError('文件类型无效')
          if (url.searchParams.getAll('category').length > 1) throw new TypeError('文件分类无效')
          const sessionId = optionalSessionId(url.searchParams.get('sessionId'))
          const kind = optionalKind(url.searchParams.get('kind'))
          const category = optionalCategory(url.searchParams.get('category'))
          const filter = { ...(sessionId === undefined ? {} : { sessionId }), unscoped: url.searchParams.get('scope') === 'unscoped', ...(kind === undefined ? {} : { kind }), ...(category === undefined ? {} : { category }) }
          // 未分组视图与 note 类型需要并入实时无目录笔记；其余视图只读领域表。
          const page = url.searchParams.get('scope') === 'unscoped' || kind === 'note'
            ? await service.listWithNotes(
              parameter(url.searchParams.get('offset'), 0),
              parameter(url.searchParams.get('limit'), 50),
              filter,
            )
            : service.list(
              parameter(url.searchParams.get('offset'), 0),
              parameter(url.searchParams.get('limit'), 50),
              filter,
            )
          json(res, 200, page)
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library list request failed', error)
          json(res, 503, { error: '文件列表暂不可用' })
        }
      },
    }), 'file-library: GET /api/files/list')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/files/preview',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const ids = url.searchParams.getAll('id')
          if (ids.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'id')) {
            json(res, 400, { error: '文件标识无效' })
            return
          }
          const [fileId] = ids
          const value = fileId === undefined ? undefined : await service.read(fileId)
          if (value === undefined || !value.record.mediaType.startsWith('image/')) {
            json(res, 404, { error: '文件不可预览' })
            return
          }
          binary(res, value.record.mediaType, value.data)
        } catch (error) {
          webCtx.logger.warn('file-library preview request failed', error)
          json(res, 503, { error: '文件预览暂不可用' })
        }
      },
    }), 'file-library: GET /api/files/preview')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/tree',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        try {
          json(res, 200, { children: await service.notesTree() })
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes tree request failed', error)
          json(res, 503, { error: '笔记目录暂不可用' })
        }
      },
    }), 'file-library: GET /api/notes/tree')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/read',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if ([...url.searchParams.keys()].some(key => key !== 'path') || url.searchParams.getAll('path').length !== 1) {
            throw new TypeError('笔记路径无效')
          }
          json(res, 200, await service.readNote(url.searchParams.get('path') ?? ''))
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes read request failed', error)
          json(res, 503, { error: '笔记暂不可读' })
        }
      },
    }), 'file-library: GET /api/notes/read')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/save',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        try {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.content !== 'string'
            || (body.baseMtimeMs !== undefined && (typeof body.baseMtimeMs !== 'number' || !Number.isFinite(body.baseMtimeMs)))) {
            throw new TypeError('保存载荷无效')
          }
          json(res, 200, await service.saveNote(body.path, body.content, body.baseMtimeMs))
        } catch (error) {
          if (error instanceof StaleNoteError) { json(res, 409, { error: error.message }); return }
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes save request failed', error)
          json(res, 503, { error: '笔记暂不可写' })
        }
      },
    }), 'file-library: POST /api/notes/save')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/create',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        try {
          const body = await readJsonBody(req)
          if (typeof body.name !== 'string') throw new TypeError('新建载荷无效')
          json(res, 201, await service.createNote(body.name))
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes create request failed', error)
          json(res, 503, { error: '笔记暂不可创建' })
        }
      },
    }), 'file-library: POST /api/notes/create')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/cwd',
      handler: (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        json(res, 200, { path: service.notesRootPath() })
      },
    }), 'file-library: GET /api/notes/cwd')
  })
}

/** 读取限长的 JSON 请求体；超限或非法 JSON 按无效载荷拒绝。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('保存载荷无效')
    total += chunk.byteLength
    if (total > 2 * 1024 * 1024) throw new TypeError('保存载荷过大')
    chunks.push(chunk)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('保存载荷无效')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('保存载荷无效')
  }
}
