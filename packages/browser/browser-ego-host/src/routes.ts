/** 四条会话化 Host 路由；每个 handler 首句检查共享连接防线。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from 'coding-session/types'
import { subscribeActivity } from './activity.ts'
import { targetIdsForSession, validId } from './session-space.ts'
import { ensureWorker, workerGet, workerInput } from './worker.ts'

interface Page { targetId: string; url: string; title: string; active: boolean; viewportW: number | null; viewportH: number | null }
interface Frame { targetId: string; data: string; vw: number; vh: number; ts: number }
const MAX_BODY_BYTES = 8192

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) { res.writeHead(rejection); res.end(); return false }
  const authority = req.headers.host
  const port = ctx.webServer.port
  if (ctx.webServer.host !== '127.0.0.1' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(authority ?? '')
    || (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`)) {
    res.writeHead(403); res.end(); return false
  }
  return true
}

function getSession(ctx: Context, req: IncomingMessage, res: ServerResponse): SessionId | null {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const id = url.searchParams.get('sessionId')
  if ((url.searchParams.size !== 1 && url.searchParams.size !== 2) || !validId(id) || !ctx.sessions.get(id as SessionId)) {
    send(res, 404, { ok: false, error: 'session not found' }); return null
  }
  return id as SessionId
}

function pages(value: unknown, targetIds: ReadonlySet<string>): Page[] {
  const raw = object(value)
  if (!Array.isArray(raw?.spaces)) return []
  return raw.spaces.flatMap((entry: unknown) => {
    const page = object(entry)
    if (!page || !validId(page.targetId) || !targetIds.has(page.targetId)
      || typeof page.url !== 'string' || typeof page.title !== 'string') return []
    return [{ targetId: page.targetId, url: page.url, title: page.title, active: page.active === true,
      viewportW: typeof page.viewportW === 'number' ? page.viewportW : null,
      viewportH: typeof page.viewportH === 'number' ? page.viewportH : null }]
  })
}
async function currentPages(sessionId: SessionId, port: number): Promise<Page[]> {
  const targetIds = await targetIdsForSession(sessionId)
  if (targetIds.size === 0) return []
  return pages(await workerGet(port, '/api/spaces'), targetIds)
}

function frame(value: unknown, targetId: string): Frame | null {
  const data = object(value)
  if (!data || data.targetId !== targetId || typeof data.data !== 'string'
    || data.data.length === 0 || data.data.length > 2_800_000
    || typeof data.vw !== 'number' || typeof data.vh !== 'number'
    || !Number.isSafeInteger(data.vw) || !Number.isSafeInteger(data.vh)
    || data.vw <= 0 || data.vw > 8192 || data.vh <= 0 || data.vh > 8192
    || typeof data.ts !== 'number' || !Number.isSafeInteger(data.ts)) return null
  return data as unknown as Frame
}

function sse(res: ServerResponse, event: 'spaces' | 'frame', value: unknown): boolean {
  if (res.destroyed || res.writableLength > 4 * 1024 * 1024) { res.destroy(); return false }
  return res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (String(req.headers['content-type']).split(';')[0]?.trim().toLowerCase() !== 'application/json') return null
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of req) {
      length += (chunk as Buffer).byteLength
      if (length > MAX_BODY_BYTES) { req.resume(); return null }
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch { return null }
}

/** 只接受已显示视口内的鼠标操作或有界文本，剔除所有额外 CDP 字段。 */
export function parseInput(value: unknown, page: Page): Record<string, unknown> | null {
  const body = object(value)
  if (!body || body.targetId !== page.targetId || !validId(body.sessionId)) return null
  if (body.type === 'insertText') {
    return typeof body.text === 'string' && body.text.length > 0 && body.text.length <= 2000
      ? { targetId: page.targetId, type: 'insertText', text: body.text } : null
  }
  if (!Number.isSafeInteger(body.x) || !Number.isSafeInteger(body.y)
    || (body.x as number) < 0 || (body.y as number) < 0
    || (body.x as number) >= (page.viewportW ?? 0) || (body.y as number) >= (page.viewportH ?? 0)) return null
  const x = body.x as number, y = body.y as number
  if (body.type === 'mouseWheel') {
    return Number.isSafeInteger(body.deltaX) && Number.isSafeInteger(body.deltaY)
      && Math.abs(body.deltaX as number) <= 2000 && Math.abs(body.deltaY as number) <= 2000
      ? { targetId: page.targetId, type: 'mouseWheel', x, y, deltaX: body.deltaX, deltaY: body.deltaY } : null
  }
  if ((body.type === 'mousePressed' || body.type === 'mouseReleased') && body.button === 'left'
    && (body.buttons === 0 || body.buttons === 1) && body.clickCount === 1) {
    return { targetId: page.targetId, type: body.type, x, y, button: 'left', buttons: body.buttons, clickCount: 1 }
  }
  return null
}

/** 所有 HTTP handler 在查询 session/body/worker 之前执行连接 + 回环同源栅栏。 */
export function installRoutes(ctx: Context): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path,
        handler: (req, res) => { if (trusted(webCtx, req, res)) return handler(req, res) },
      }), `browser-ego-host: ${path}`)
    }
    register('/api/ego/activity', (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(':ok\n\n')
      subscribeActivity(res)
    })
    register('/api/ego/spaces', async (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      const sessionId = getSession(webCtx, req, res)
      if (!sessionId) return
      if (new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.size !== 1) { send(res, 400, { ok: false }); return }
      const port = await ensureWorker(webCtx)
      send(res, 200, { ok: true, spaces: port === null ? [] : await currentPages(sessionId, port), frameRelay: true })
    })
    register('/api/ego/frame', async (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      const sessionId = getSession(webCtx, req, res)
      if (!sessionId) return
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const targetId = url.searchParams.get('targetId')
      if (url.searchParams.size !== 2 || !validId(targetId) || !(await targetIdsForSession(sessionId)).has(targetId)) {
        send(res, 404, { ok: false }); return
      }
      const port = await ensureWorker(webCtx)
      if (port === null || !(await currentPages(sessionId, port)).some(page => page.targetId === targetId)) {
        send(res, 404, { ok: false }); return
      }
      const result = frame(await workerGet(port, `/api/frame?targetId=${encodeURIComponent(targetId)}`), targetId)
      if (!result || !webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(targetId)) {
        send(res, 404, { ok: false }); return
      }
      send(res, 200, result)
    })
    register('/api/ego/stream', (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      const sessionId = getSession(webCtx, req, res)
      if (!sessionId) return
      if (new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.size !== 1) { send(res, 400, { ok: false }); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(':ok\n\n')
      let lastPages = ''
      let lastFrameAt = 0
      let busy = false
      const poll = async (): Promise<void> => {
        if (busy || res.destroyed) return
        busy = true
        try {
          if (!webCtx.sessions.get(sessionId)) { res.end(); return }
          const port = await ensureWorker(webCtx)
          const visible = port === null ? [] : await currentPages(sessionId, port)
          if (!webCtx.sessions.get(sessionId)) { res.end(); return }
          const stamp = JSON.stringify(visible)
          if (stamp !== lastPages) { lastPages = stamp; if (!sse(res, 'spaces', visible)) return }
          const selected = visible.find(page => page.active) ?? visible[0]
          if (!selected || port === null) return
          const targetIds = await targetIdsForSession(sessionId)
          if (!targetIds.has(selected.targetId)) return
          const result = frame(await workerGet(port, `/api/frame?targetId=${encodeURIComponent(selected.targetId)}`), selected.targetId)
          if (result && result.ts > lastFrameAt && webCtx.sessions.get(sessionId)
            && (await targetIdsForSession(sessionId)).has(result.targetId)) {
            lastFrameAt = result.ts
            sse(res, 'frame', result)
          }
        } catch { /* 连接断开与 worker 重启时下一轮继续。 */ }
        finally { busy = false }
      }
      void poll()
      const timer = setInterval(() => { void poll() }, 1000)
      res.once('close', () => { clearInterval(timer) })
    })
    register('/api/ego/input', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      if (!body || !validId(body.sessionId) || !webCtx.sessions.get(body.sessionId as SessionId)
        || !validId(body.targetId)) { send(res, 400, { ok: false }); return }
      const sessionId = body.sessionId as SessionId
      const targetIds = await targetIdsForSession(sessionId)
      if (!targetIds.has(body.targetId)) { send(res, 403, { ok: false }); return }
      const port = await ensureWorker(webCtx)
      if (port === null) { send(res, 503, { ok: false }); return }
      const page = (await currentPages(sessionId, port)).find(item => item.targetId === body.targetId)
      if (!page) { send(res, 409, { ok: false }); return }
      const input = parseInput(body, page)
      if (!input || !webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(page.targetId)) {
        send(res, 400, { ok: false }); return
      }
      const accepted = await workerInput(port, input)
      send(res, accepted ? 200 : 503, { ok: accepted })
    })
  })
}
