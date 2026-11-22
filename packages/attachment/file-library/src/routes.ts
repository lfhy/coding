/** 文件库与笔记路由；鉴权和严格回环同源检查先于领域读写。@module coding-file-library/routes */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import type { FileLibrary } from './index.ts'
import { mindmapImportByteLimit } from './mindmap-notes.ts'
import { NoteConflictError, NoteNotFoundError } from './note-path.ts'
import { OFFICE_NATIVE_MAX_BYTES, officeKind } from './office/document.ts'
import { OFFICE_UPLOAD_MAX_BYTES } from './office/zip.ts'
import type { OfficeExport } from './types.ts'

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

/** 按服务的插件生命周期注册可撤销的文件库与笔记路由。
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
          if (error instanceof NoteConflictError) { json(res, 409, { error: error.message }); return }
          if (error instanceof NoteNotFoundError) { json(res, 404, { error: error.message }); return }
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
          if (typeof body.name !== 'string' || body.directory !== undefined && typeof body.directory !== 'string'
            || body.content !== undefined && typeof body.content !== 'string') {
            throw new TypeError('新建载荷无效')
          }
          json(res, 201, await service.createNote(body.name, body.directory ?? '', body.content))
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes create request failed', error)
          json(res, 503, { error: '笔记暂不可创建' })
        }
      },
    }), 'file-library: POST /api/notes/create')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/create-directory',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        try {
          const body = await readJsonBody(req)
          if (typeof body.name !== 'string' || body.parent !== undefined && typeof body.parent !== 'string') {
            throw new TypeError('新建目录载荷无效')
          }
          json(res, 201, await service.createNoteDirectory(body.name, body.parent ?? ''))
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes directory create request failed', error)
          json(res, 503, { error: '笔记目录暂不可创建' })
        }
      },
    }), 'file-library: POST /api/notes/create-directory')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/rename',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
        try {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string' || typeof body.name !== 'string') throw new TypeError('重命名载荷无效')
          json(res, 200, await service.renameNote(body.path, body.name))
        } catch (error) {
          if (error instanceof NoteConflictError) { json(res, 409, { error: error.message }); return }
          if (error instanceof NoteNotFoundError) { json(res, 404, { error: error.message }); return }
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes rename request failed', error)
          json(res, 503, { error: '笔记暂不可重命名' })
        }
      },
    }), 'file-library: POST /api/notes/rename')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/delete',
      handler: async (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'DELETE') { res.writeHead(405, { allow: 'DELETE' }); res.end(); return }
        try {
          const body = await readJsonBody(req)
          if (typeof body.path !== 'string') throw new TypeError('删除载荷无效')
          await service.deleteNote(body.path)
          res.writeHead(204, { 'cache-control': 'private, no-store' }); res.end()
        } catch (error) {
          if (error instanceof NoteConflictError) { json(res, 409, { error: error.message }); return }
          if (error instanceof NoteNotFoundError) { json(res, 404, { error: error.message }); return }
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library notes delete request failed', error)
          json(res, 503, { error: '笔记暂不可删除' })
        }
      },
    }), 'file-library: DELETE /api/notes/delete')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/notes/cwd',
      handler: (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        json(res, 200, { path: service.notesRootPath() })
      },
    }), 'file-library: GET /api/notes/cwd')
    installMindmapRoutes(webCtx, service)
    installOfficeRoutes(webCtx, service)
  })
}

function query(req: IncomingMessage, allowed: readonly string[], subject = '思维导图'): URLSearchParams {
  const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new TypeError(`${subject}请求参数无效`)
  }
  return params
}

function requestType(req: IncomingMessage, expected: string, subject = '思维导图'): void {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== expected) {
    throw new TypeError(`${subject}请求的内容格式无效`)
  }
}

function installMindmapRoutes(ctx: Context, service: FileLibrary): void {
  function route(
    name: string, method: 'GET' | 'POST', status: number, respond: (req: IncomingMessage) => Promise<unknown>,
  ): void {
    const path = `/api/notes/mindmap/${name}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
      handler: async (req, res) => {
        res.setHeader('cache-control', 'private, no-store')
        if (!trusted(ctx, req, res)) return
        if (req.method !== method) { res.writeHead(405, { allow: method }); res.end(); return }
        try {
          json(res, status, await respond(req))
        } catch (error) {
          if (error instanceof NoteConflictError) { json(res, 409, { error: error.message }); return }
          if (error instanceof NoteNotFoundError) { json(res, 404, { error: error.message }); return }
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          ctx.logger.warn('file-library notes mindmap request failed', error)
          json(res, 503, { error: '思维导图暂不可用' })
        }
      },
    }), `file-library: ${method} ${path}`)
  }

  route('create', 'POST', 201, async (req) => {
    query(req, [])
    requestType(req, 'application/json')
    const body = await readJsonBody(req)
    if (Object.keys(body).some(key => key !== 'name' && key !== 'directory')
      || typeof body.name !== 'string' || body.directory !== undefined && typeof body.directory !== 'string') {
      throw new TypeError('新建思维导图的载荷无效')
    }
    return service.createNoteMindmap(body.name, body.directory)
  })
  route('import', 'POST', 201, async (req) => {
    const params = query(req, ['name', 'directory'])
    const name = params.get('name')
    if (!name) throw new TypeError('思维导图文件名无效')
    requestType(req, 'application/octet-stream')
    const limit = mindmapImportByteLimit(name)
    const bytes = await readBody(req, limit, '导入载荷无效', `思维导图上传超过 ${limit / (1024 * 1024)} MiB`)
    return service.importNoteMindmap(name, bytes, params.get('directory') ?? undefined)
  })
  route('read', 'GET', 200, async req => service.readNoteMindmap(query(req, ['path']).get('path') ?? ''))
  route('edit', 'POST', 200, async (req) => {
    query(req, [])
    requestType(req, 'application/json')
    const body = await readJsonBody(req)
    if (Object.keys(body).some(key => key !== 'path' && key !== 'revision' && key !== 'edits')
      || typeof body.path !== 'string' || typeof body.revision !== 'string') {
      throw new TypeError('编辑思维导图的载荷无效')
    }
    return service.editNoteMindmap(body.path, body.revision, body.edits)
  })
}

function officeAttachment(res: ServerResponse, { name, mediaType, bytes }: OfficeExport): void {
  // ASCII 回退给旧客户端；UTF-8 参数才是实际下载名，不能把磁盘路径放入响应。
  const fallback = name.replace(/[^a-zA-Z0-9 ._-]/gu, '_')
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16)}`)
  res.writeHead(200, {
    'content-type': mediaType, 'content-length': bytes.byteLength, 'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
  })
  res.end(bytes)
}

function installOfficeRoutes(ctx: Context, service: FileLibrary): void {
  const subject = '办公笔记'
  const readParams = (req: IncomingMessage, allowed: readonly string[]): URLSearchParams => query(req, allowed, subject)
  async function payload(req: IncomingMessage, fields: readonly string[], limit: number): Promise<Record<string, unknown>> {
    readParams(req, [])
    requestType(req, 'application/json', subject)
    const body = await readJsonBody(req, limit)
    if (Object.keys(body).some(key => !fields.includes(key))) throw new TypeError('办公笔记载荷无效')
    return body
  }

  function route(
    name: string, method: 'GET' | 'POST', respond: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void {
    const path = `/api/notes/office/${name}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
      handler: async (req, res) => {
        res.setHeader('cache-control', 'private, no-store')
        if (!trusted(ctx, req, res)) return
        if (req.method !== method) { res.writeHead(405, { allow: method }); res.end(); return }
        try {
          await respond(req, res)
        } catch (error) {
          if (error instanceof NoteConflictError) { json(res, 409, { error: error.message }); return }
          if (error instanceof NoteNotFoundError) { json(res, 404, { error: error.message }); return }
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          ctx.logger.warn('办公笔记请求失败')
          json(res, 500, { error: '办公笔记暂不可用，请稍后重试' })
        }
      },
    }), `file-library: ${method} ${path}`)
  }

  const metadataBytes = 32 * 1024
  route('create', 'POST', async (req, res) => {
    const { kind, name, directory } = await payload(req, ['kind', 'name', 'directory'], metadataBytes)
    if (typeof name !== 'string' || directory !== undefined && typeof directory !== 'string') throw new TypeError('新建办公笔记载荷无效')
    json(res, 201, await service.createNoteOffice(officeKind(kind), name, directory))
  })
  route('import', 'POST', async (req, res) => {
    const params = readParams(req, ['kind', 'name', 'directory'])
    const kind = officeKind(params.get('kind'))
    const name = params.get('name')
    if (!name) throw new TypeError('Office 文件名无效')
    requestType(req, 'application/octet-stream', subject)
    const bytes = await readBody(req, OFFICE_UPLOAD_MAX_BYTES, '导入载荷无效', 'Office 上传超过 16 MiB')
    json(res, 201, await service.importNoteOffice(kind, name, bytes, params.get('directory') ?? undefined))
  })
  route('read', 'GET', async (req, res) => {
    const params = readParams(req, ['path'])
    json(res, 200, await service.readNoteOffice(params.get('path') ?? ''))
  })
  route('save', 'POST', async (req, res) => {
    const { path, revision, document } = await payload(req, ['path', 'revision', 'document'], OFFICE_NATIVE_MAX_BYTES + metadataBytes)
    if (typeof path !== 'string' || typeof revision !== 'string') throw new TypeError('保存办公笔记载荷无效')
    json(res, 200, await service.saveNoteOffice(path, revision, document))
  })
  route('export', 'GET', async (req, res) => {
    const params = readParams(req, ['path', 'revision'])
    officeAttachment(res, await service.exportNoteOffice(params.get('path') ?? '', params.get('revision') ?? undefined))
  })
}

/** 不以 Content-Length 取代流限额；分块请求也在收齐之前受同一预算约束。 */
async function readBody(req: IncomingMessage, max: number, invalid: string, oversized: string): Promise<Buffer> {
  if (Number(req.headers['content-length']) > max) {
    req.resume()
    throw new TypeError(oversized)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) { req.resume(); throw new TypeError(invalid) }
    total += chunk.byteLength
    if (total > max) { req.resume(); throw new TypeError(oversized) }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

/** 读取限长的 JSON 请求体；超限或非法 JSON 按无效载荷拒绝。 */
async function readJsonBody(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, max, '保存载荷无效', '保存载荷过大')
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('保存载荷无效')
    return parsed as Record<string, unknown>
  } catch {
    throw new TypeError('保存载荷无效')
  }
}
