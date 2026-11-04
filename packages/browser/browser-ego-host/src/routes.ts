/** 会话化浏览器 Host 路由；每个 handler 读取载荷前检查连接与回环同源。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from 'coding-session/types'
import { recentActions, replayActivity, subscribeActivity } from './activity.ts'
import { parseNavigation } from './navigation.ts'
import { targetIdsForSession, validId } from './session-space.ts'
import { ensureWorker, workerGet, workerHover, workerInput, workerPost, workerResize } from './worker.ts'

interface Page {
  targetId: string
  url: string
  title: string
  active: boolean
  viewportW: number | null
  viewportH: number | null
  humanCheck?: unknown
}
interface Frame { targetId: string; data: string; mime?: string; vw: number; vh: number; ts: number }
const MAX_BODY_BYTES = 8192

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
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
      viewportH: typeof page.viewportH === 'number' ? page.viewportH : null,
      humanCheck: page.humanCheck ?? null }]
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
    || typeof data.ts !== 'number' || !Number.isSafeInteger(data.ts)
    || (data.mime !== undefined && data.mime !== 'image/webp' && data.mime !== 'image/png' && data.mime !== 'image/jpeg')) return null
  return data as unknown as Frame
}

/**
 * 单帧画质与宽度上限来自 `ego-browser` 设置；越界或缺失时省略参数，由 worker 用自身配置兜底。
 * @param section - 设置命名空间的解析结果。
 * @param targetId - 已核验属于该会话的页面目标。
 * @returns worker 封闭的取帧路径。
 */
export function framePath(section: unknown, targetId: string, format?: 'lossy'): `/api/frame?${string}` {
  const config = object(section)
  const quality = Number(config?.cdpQuality)
  const maxWidth = Number(config?.cdpMaxWidth)
  const params = new URLSearchParams({ targetId })
  if (Number.isSafeInteger(quality) && quality >= 1 && quality <= 100) params.set('quality', String(quality))
  if (Number.isSafeInteger(maxWidth) && maxWidth >= 320 && maxWidth <= 2560) params.set('maxWidth', String(maxWidth))
  if (format !== undefined) params.set('format', format)
  return `/api/frame?${params.toString()}`
}

/**
 * 实时画面的取帧间隔（毫秒）：来自 `ego-browser` 设置的 `cdpFps`（5–30），越界时按 15fps。
 * @param section - 设置命名空间的解析结果。
 * @returns 两次取帧之间至少等待的时间。
 */
export function frameInterval(section: unknown): number {
  const fps = Number(object(section)?.cdpFps)
  const rate = Number.isSafeInteger(fps) && fps >= 5 && fps <= 30 ? fps : 15
  return Math.max(33, Math.round(1000 / rate))
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

/** 只接受视口内鼠标、有界文本与受限按键，剔除所有额外 CDP 字段。 */
export function parseInput(value: unknown, page: Page): Record<string, unknown> | null {
  const body = object(value)
  if (!body || body.targetId !== page.targetId || !validId(body.sessionId)) return null
  if (body.type === 'keyDown' || body.type === 'keyUp') {
    const keys = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (!keys.includes(body.key as string) || typeof body.code !== 'string' || body.code !== body.key
      || !Number.isSafeInteger(body.windowsVirtualKeyCode) || (body.windowsVirtualKeyCode as number) < 0
      || (body.windowsVirtualKeyCode as number) > 255
      || (body.modifiers !== undefined && (!Number.isSafeInteger(body.modifiers) || (body.modifiers as number) < 0
        || (body.modifiers as number) > 7))) return null
    const allowed = ['sessionId', 'targetId', 'type', 'key', 'code', 'windowsVirtualKeyCode', 'modifiers']
    if (Object.keys(body).some(key => !allowed.includes(key))) return null
    return { targetId: page.targetId, type: body.type, key: body.key, code: body.code,
      windowsVirtualKeyCode: body.windowsVirtualKeyCode, modifiers: body.modifiers ?? 0 }
  }
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
    /** 单帧画质设置的当前值；设置服务未就绪时返回 undefined，由 worker 用自身配置兜底。 */
    const frameConfig = (): unknown => {
      const settings = webCtx.get('settings') as { get?: (namespace: string) => unknown } | undefined
      return typeof settings?.get === 'function' ? settings.get('ego-browser') : undefined
    }
    register('/api/ego/activity', (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(':ok\n\n')
      subscribeActivity(res)
      replayActivity(res, sessionId => webCtx.sessions.get(sessionId) !== undefined)
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
      const result = frame(await workerGet(port, framePath(frameConfig(), targetId)), targetId)
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
      let selectedId: string | null = null
      let busy = false
      let frameTimer: ReturnType<typeof setTimeout> | null = null
      // 关闭标记经闭包读取，避免类型流分析把它当成常量 false。
      const closed = (): boolean => res.destroyed

      // 目录按秒刷新；画面按 cdpFps 独立取帧，两者不再互相拖累。
      const pollPages = async (): Promise<void> => {
        if (closed()) return
        try {
          if (!webCtx.sessions.get(sessionId)) { res.end(); return }
          const port = await ensureWorker(webCtx)
          const visible = port === null ? [] : await currentPages(sessionId, port)
          if (closed()) return
          const stamp = JSON.stringify(visible)
          if (stamp !== lastPages) { lastPages = stamp; if (!sse(res, 'spaces', visible)) return }
          selectedId = (visible.find(page => page.active) ?? visible[0])?.targetId ?? null
        } catch { /* 连接断开与 worker 重启时下一轮继续。 */ }
      }

      // 画面状态机：滚动期间低开销推流；画面连续两次不变就补一张无损帧，静止时不会出现编码台阶；
      // 之后降频探测变化，一旦画面又变了就回到实时推流。
      let lastLossy = ''
      let idleTicks = 0
      let upgraded = false
      let stillUnavailable = false
      const pollFrame = async (): Promise<void> => {
        const targetId = selectedId
        if (busy || closed() || targetId === null) return
        busy = true
        try {
          const port = await ensureWorker(webCtx)
          if (port === null) return
          const wantStill = !upgraded && !stillUnavailable && idleTicks >= 2
          const result = frame(await workerGet(port, framePath(frameConfig(), targetId, wantStill ? undefined : 'lossy')), targetId)
          if (!result || closed() || result.ts <= lastFrameAt) return
          if (!webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(targetId)) return
          if (result.mime === 'image/webp') {
            upgraded = true
            lastFrameAt = result.ts
            sse(res, 'frame', result)
            return
          }
          // 无损帧超出体积预算时退回有损：这一页不再尝试升级，避免每轮多采一次。
          if (wantStill) stillUnavailable = true
          const changed = result.data !== lastLossy
          lastLossy = result.data
          if (upgraded) {
            if (!changed) return
            upgraded = false
            idleTicks = 0
          } else {
            idleTicks = changed ? 0 : idleTicks + 1
          }
          lastFrameAt = result.ts
          sse(res, 'frame', result)
        } catch { /* 连接断开与 worker 重启时下一轮继续。 */ }
        finally { busy = false }
      }

      // 自调度取帧：间隔取 cdpFps；单帧耗时超过间隔时自然降速，不会排队。静止后降到 4fps 探测变化。
      const loop = async (): Promise<void> => {
        if (closed()) return
        const startedAt = Date.now()
        await pollFrame()
        if (closed()) return
        const interval = upgraded ? 250 : frameInterval(frameConfig())
        const wait = Math.max(0, interval - (Date.now() - startedAt))
        frameTimer = setTimeout(() => { frameTimer = null; void loop() }, wait)
      }

      const pagesTimer = setInterval(() => { void pollPages() }, 1000)
      void pollPages()
      void loop()
      res.once('close', () => {
        clearInterval(pagesTimer)
        if (frameTimer !== null) clearTimeout(frameTimer)
        frameTimer = null
      })
    })
    register('/api/ego/hover', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      if (!body || Object.keys(body).some(key => !['sessionId', 'targetId', 'x', 'y'].includes(key))
        || !validId(body.sessionId) || !webCtx.sessions.get(body.sessionId as SessionId)
        || !validId(body.targetId) || !Number.isSafeInteger(body.x) || !Number.isSafeInteger(body.y)) {
        send(res, 400, { ok: false }); return
      }
      const sessionId = body.sessionId as SessionId
      if (!(await targetIdsForSession(sessionId)).has(body.targetId)) { send(res, 403, { ok: false }); return }
      const port = await ensureWorker(webCtx)
      if (port === null) { send(res, 503, { ok: false }); return }
      // 归属已由空间登记确认；视口边界交给持有页面的 worker，避免每次悬停再拉一遍页面目录。
      const x = body.x as number, y = body.y as number
      const result = object(await workerHover(port, { targetId: body.targetId, x, y }))
      if (!webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(body.targetId)
        || result?.ok !== true || !['default', 'pointer', 'text', 'wait', 'progress', 'help', 'move', 'grab', 'grabbing',
        'not-allowed', 'crosshair', 'cell', 'vertical-text', 'zoom-in', 'zoom-out', 'ew-resize', 'ns-resize'].includes(result.cursor as string)
        || (result.title !== null && (typeof result.title !== 'string' || result.title.length > 256))
        || (result.href !== null && (typeof result.href !== 'string' || result.href.length > 2048))) {
        send(res, 503, { ok: false }); return
      }
      send(res, 200, { ok: true, targetId: body.targetId, cursor: result.cursor, title: result.title, href: result.href })
    })
    register('/api/ego/viewport', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      const width = Number(body?.width)
      const height = Number(body?.height)
      // 像素比可选：老客户端不带该字段，等价于 1，画面语义与旧版一致。
      const pixelRatio = body?.pixelRatio === undefined ? undefined : Number(body.pixelRatio)
      if (!body || Object.keys(body).some(key => !['sessionId', 'targetId', 'width', 'height', 'pixelRatio'].includes(key))
        || !validId(body.sessionId) || !validId(body.targetId)
        || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || (pixelRatio !== undefined && (!Number.isFinite(pixelRatio) || pixelRatio < 1 || pixelRatio > 3))
        || width < 320 || width > 3840 || height < 200 || height > 2160
        || !webCtx.sessions.get(body.sessionId as SessionId)) { send(res, 400, { ok: false }); return }
      const sessionId = body.sessionId as SessionId
      if (!(await targetIdsForSession(sessionId)).has(body.targetId)) { send(res, 403, { ok: false }); return }
      const port = await ensureWorker(webCtx)
      if (port === null) { send(res, 503, { ok: false }); return }
      // 页面可能在检查期间被 Agent 关掉；归属与存在性都要在转发前复核。
      if (!(await currentPages(sessionId, port)).some(page => page.targetId === body.targetId)) {
        send(res, 409, { ok: false }); return
      }
      if (!webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(body.targetId)) {
        send(res, 409, { ok: false }); return
      }
      const viewport = await workerResize(port, { targetId: body.targetId, width, height,
        pixelRatio: pixelRatio ?? 1 })
      if (viewport === null) { send(res, 503, { ok: false }); return }
      send(res, 200, { ok: true, viewport })
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
    register('/api/ego/pages', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      if (!body || Object.keys(body).length !== 1 || !validId(body.sessionId)
        || !webCtx.sessions.get(body.sessionId as SessionId)) { send(res, 400, { ok: false }); return }
      const sessionId = body.sessionId as SessionId
      const targetId = await webCtx.egoBrowser.createBlankPage(sessionId)
      const port = targetId === null ? null : await ensureWorker(webCtx)
      if (!targetId || port === null || !webCtx.sessions.get(sessionId)
        || !(await currentPages(sessionId, port)).some(page => page.targetId === targetId)) {
        send(res, 503, { ok: false }); return
      }
      send(res, 200, { ok: true, targetId })
    })
    register('/api/ego/navigation', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      const command = parseNavigation(body, true)
      if (!command || !body || !webCtx.sessions.get(body.sessionId as SessionId)) {
        send(res, 400, { ok: false }); return
      }
      const sessionId = body.sessionId as SessionId
      const owned = await targetIdsForSession(sessionId)
      if (command.targetId && !owned.has(command.targetId)) { send(res, 403, { ok: false }); return }
      if (!command.targetId) {
        if (owned.size > 0 || command.url === undefined) { send(res, 409, { ok: false }); return }
        // 无目标时只允许进入该会话空间，不从 worker 的全局活动标签中选页。
        const created = await webCtx.egoBrowser.createSessionPage(sessionId, command.url)
        send(res, created ? 200 : 503, { ok: created })
        return
      }
      const port = await ensureWorker(webCtx)
      if (port === null) { send(res, 503, { ok: false }); return }
      if (!(await currentPages(sessionId, port)).some(page => page.targetId === command.targetId)) {
        send(res, 409, { ok: false }); return
      }
      if (!webCtx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(command.targetId)) {
        send(res, 409, { ok: false }); return
      }
      const accepted = await workerPost(port, '/api/navigation', {
        targetId: command.targetId, action: command.action,
        ...(command.url === undefined ? {} : { url: command.url }),
      })
      send(res, accepted ? 200 : 503, { ok: accepted })
    })
    register('/api/ego/close', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      if (!body || !validId(body.sessionId) || !webCtx.sessions.get(body.sessionId as SessionId)
        || !validId(body.targetId)) { send(res, 400, { ok: false }); return }
      const sessionId = body.sessionId as SessionId
      if (!(await targetIdsForSession(sessionId)).has(body.targetId)) { send(res, 403, { ok: false }); return }
      const port = await ensureWorker(webCtx)
      if (port === null) { send(res, 503, { ok: false }); return }
      const accepted = await workerPost(port, '/api/close', { targetId: body.targetId })
      send(res, accepted ? 200 : 503, { ok: accepted })
    })
    // 用户主动要求时才换上有窗口的浏览器；这是唯一会把窗口带到前台的入口。
    // 路径避开上游的 /api/ego/raise：上游在同一 Host 上已注册那条全局路由，
    // 同名注册会抛错并连带撤销本文件其余会话路由。
    register('/api/ego/window', async (req, res) => {
      if (req.method !== 'POST') { send(res, 405, { ok: false }); return }
      const body = object(await readBody(req))
      if (!body || !validId(body.sessionId) || !webCtx.sessions.get(body.sessionId as SessionId)) {
        send(res, 400, { ok: false }); return
      }
      const raised = await webCtx.egoBrowser.raiseWindow()
      send(res, raised ? 200 : 503, { ok: raised })
    })
    register('/api/ego/status', (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      const sessionId = getSession(webCtx, req, res)
      if (!sessionId) return
      envCheck(webCtx, sessionId).then((result) => { send(res, 200, result) }).catch(() => {
        send(res, 200, {
          ok: true, running: false, browserConnected: false, spaces: 0, actions: recentActions(sessionId),
        })
      })
    })
    register('/api/ego/history', (req, res) => {
      if (req.method !== 'GET') { send(res, 405, { ok: false }); return }
      const sessionId = getSession(webCtx, req, res)
      if (!sessionId) return
      send(res, 200, { ok: true, actions: recentActions(sessionId) })
    })
  })
}

/** 面板状态：只暴露运行/连接/页面数量与最近动作，不返回路径或进程信息。 */
async function envCheck(webCtx: Context, sessionId: SessionId): Promise<{
  ok: boolean
  running: boolean
  browserConnected: boolean
  spaces: number
  actions: readonly { tool: string; at: number }[]
}> {
  const port = await ensureWorker(webCtx)
  const health = port === null ? null : object(await workerGet(port, '/api/health'))
  const pages = port === null ? [] : await currentPages(sessionId, port)
  return {
    ok: true,
    running: port !== null,
    browserConnected: health?.browserConnected === true,
    spaces: pages.length,
    actions: recentActions(sessionId),
  }
}
