/** 隔离的 Chromium 页面提供方；每个会话只拥有一个内存上下文和只读画面。 @module @deepseek-ai/dsh-browser-playwright */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { BrowserUseError, BrowserUseService } from '@deepseek-ai/dsh-browser'
import type { BrowserCapture, BrowserCommand, BrowserObservation } from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright'
import { validateAllowedOrigins, validateRequestUrl } from './policy.ts'
import { createBrowserProxy } from './proxy.ts'

const VIEWPORT = { width: 1280, height: 720 }
const SNAPSHOT_LIMIT = 12_000
const FRAME_LIMIT = 2 * 1024 * 1024
const ELEMENT_LIMIT = 150
const ELEMENT_SCAN_LIMIT = 50_000
const MAX_SESSIONS = 8
const IDLE_TIMEOUT = 10 * 60_000
const ELEMENT_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]'

/** 显式放行的精确 origin；空列表只允许经 DNS 校验的公网 HTTP(S)。 */
export interface Config {
  /** 显式放行的精确 HTTP(S) origin；默认只允许 DNS 校验通过的公网目的地。 */
  readonly allowedOrigins: string[]
}

interface SessionPage {
  readonly browserContext: BrowserContext
  readonly proxy: Awaited<ReturnType<typeof createBrowserProxy>>
  readonly page: Page
  readonly generation: string
  revision: number
  refs: Map<string, ElementHandle>
  capture?: BrowserCapture
  closing: Promise<void> | undefined
  lastUsed: number
}

function fail(message: string, code: 'BROWSER_FAILED' | 'BROWSER_STALE_REF' | 'BROWSER_UNAVAILABLE' | 'BROWSER_CLOSED'): BrowserUseError {
  return new BrowserUseError(message, code)
}

/** 只读画面的入口必须再检查 Host/Origin 和环回连接，不能仅依赖 API 鉴权。 */
export function trustedFrameRequest(req: IncomingMessage, host: string, port: number): boolean {
  if (host !== '127.0.0.1') return false
  if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' &&
    req.socket.remoteAddress !== '::ffff:127.0.0.1') return false
  const authority = req.headers.host
  if (authority !== `127.0.0.1:${port}` && authority !== `localhost:${port}` && authority !== `[::1]:${port}`) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${authority}`) return false
  return true
}

function send(res: ServerResponse, status: number, payload?: unknown): void {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  if (payload !== undefined) res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(payload === undefined ? undefined : JSON.stringify(payload))
}

function validSessionId(raw: string | null): raw is SessionId {
  return raw !== null && raw.length > 0 && raw.length <= 256 && /^[a-zA-Z0-9._~-]+$/.test(raw)
}

/** Host 提供方。操作按会话顺序运行；中止时销毁该会话以免保留未知页面状态。 */
export default class PlaywrightBrowserUse extends BrowserUseService {
  static Config: z<Config> = z.object({ allowedOrigins: z.array(z.string()).default([]) })

  private readonly allowedOrigins: ReadonlySet<string>
  private readonly pages = new Map<SessionId, SessionPage>()
  private readonly tails = new Map<SessionId, Promise<void>>()
  private pendingCreates = 0
  private browser: Promise<Browser> | undefined
  private readonly reapTimer: NodeJS.Timeout
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.allowedOrigins = validateAllowedOrigins(config.allowedOrigins)
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      for (const path of ['/browser-use/state', '/browser-use/frame']) {
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact', path,
          handler: (req, res) => { this.respond(req, res, path === '/browser-use/frame', webCtx) },
        }), `browser-playwright: GET ${path}`)
      }
    })
    this.reapTimer = setInterval(() => {
      for (const [id, owner] of this.pages) {
        if (Date.now() - owner.lastUsed >= IDLE_TIMEOUT && !this.tails.has(id)) {
          this.pages.delete(id)
          void this.destroy(owner).catch(() => {})
        }
      }
    }, 60_000)
    this.reapTimer.unref()
    // oxlint-disable-next-line typescript/no-misused-promises -- SessionStore observes returned async cleanup
    ctx.on('session/disposed', async (session) => {
      await this.closeSession(session.id)
    })
    ctx.effect(() => async () => {
      this.disposed = true
      clearInterval(this.reapTimer)
      await Promise.all([...this.tails.values()])
      await Promise.all([...this.pages.values()].map(page => this.destroy(page)))
      if (this.browser) await (await this.browser).close()
    }, 'browser-playwright: browser lifetime')
  }

  private async launch(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true, args: [
      '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ] }).catch((error: unknown) => {
      this.browser = undefined
      throw new BrowserUseError('Chromium unavailable; install the matching Playwright Chromium browser with pnpm exec playwright install chromium or configure the system browser installation.', 'BROWSER_UNAVAILABLE', { cause: error })
    })
    return this.browser
  }

  private async create(): Promise<SessionPage> {
    const browser = await this.launch()
    const proxy = await createBrowserProxy(this.allowedOrigins)
    let browserContext: BrowserContext
    try {
      browserContext = await browser.newContext({
        viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: 'block', permissions: [],
        proxy: { server: proxy.server, username: proxy.username, password: proxy.password,
          bypass: '<-loopback>' },
      })
    } catch (error) { await proxy.close(); throw error }
    try {
      await browserContext.route('**/*', async (route) => {
        try {
          await validateRequestUrl(route.request().url(), this.allowedOrigins)
          await route.continue()
        } catch { await route.abort('blockedbyclient').catch(() => {}) }
      })
      await browserContext.routeWebSocket('**/*', (socket) => { void socket.close() })
      const page = await browserContext.newPage()
      browserContext.on('page', (opened) => { if (opened !== page) void opened.close() })
      page.on('dialog', (dialog) => { void dialog.dismiss() })
      return { browserContext, proxy, page, generation: randomUUID(), revision: 0, refs: new Map(),
        closing: undefined, lastUsed: Date.now() }
    } catch (error) {
      await browserContext.close()
      await proxy.close()
      throw error
    }
  }

  private async destroy(owner: SessionPage): Promise<void> {
    owner.closing ??= (async () => {
      for (const ref of owner.refs.values()) await ref.dispose().catch(() => {})
      owner.refs.clear()
      await owner.browserContext.close().catch(() => {})
      await owner.proxy.close()
    })()
    await owner.closing
  }

  private async observe(owner: SessionPage, cursor: BrowserObservation['cursor']): Promise<BrowserCapture> {
    const page = owner.page
    const refs = new Map<string, ElementHandle>()
    const entries: string[] = []
    // 页面内先筛视口相交元素，再跨进程取至多 150 个句柄；扫描节点也有上限。
    const selection = await page.evaluateHandle(({ selector, limit, scanLimit, viewport }) => {
      const visible: Element[] = []
      const walkers = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT)]
      let scanned = 0
      while (walkers.length && scanned < scanLimit && visible.length < limit) {
        const walker = walkers[walkers.length - 1]
        if (!walker?.nextNode()) { walkers.pop(); continue }
        scanned++
        const element = walker.currentNode as Element
        if (element.shadowRoot) walkers.push(document.createTreeWalker(element.shadowRoot, NodeFilter.SHOW_ELEMENT))
        if (!element.matches(selector)) continue
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' ||
          box.right <= 0 || box.bottom <= 0 || box.left >= viewport.width || box.top >= viewport.height) continue
        visible.push(element)
      }
      return visible
    }, { selector: ELEMENT_SELECTOR, limit: ELEMENT_LIMIT, scanLimit: ELEMENT_SCAN_LIMIT, viewport: VIEWPORT })
    let candidates: Awaited<ReturnType<typeof selection.getProperties>>
    try { candidates = await selection.getProperties() }
    finally { await selection.dispose() }
    try {
      for (const candidate of candidates.values()) {
        const handle = candidate.asElement() as ElementHandle | null
        if (handle === null) { await candidate.dispose(); continue }
        const item = await handle.evaluate((element: Element) => {
          const box = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') return null
          const html = element as HTMLElement
          const password = html instanceof HTMLInputElement && html.type === 'password'
          const name = password
            ? html.getAttribute('aria-label') || html.getAttribute('placeholder') || 'Password'
            : html.getAttribute('aria-label') || html.getAttribute('placeholder') || html.innerText ||
              (html as HTMLInputElement).value || html.getAttribute('title') || ''
          return { role: html.getAttribute('role') || html.tagName.toLowerCase(), name: name.trim().slice(0, 160),
            x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
        }).catch(() => null)
        if (item === null || item.x + item.width < 0 || item.y + item.height < 0 ||
          item.x >= VIEWPORT.width || item.y >= VIEWPORT.height) {
          await handle.dispose().catch(() => {})
          continue
        }
        const ref = `e${refs.size + 1}`
        const row = `${ref} ${item.role} ${JSON.stringify(item.name)} (${item.x},${item.y},${item.width},${item.height})`
        if (entries.join('\n').length + row.length > SNAPSHOT_LIMIT / 2) {
          await handle.dispose().catch(() => {})
          continue
        }
        refs.set(ref, handle)
        entries.push(row)
      }
    } catch (error) {
      for (const candidate of candidates.values()) await candidate.dispose().catch(() => {})
      throw error
    }
    const text = await page.locator('body').evaluate(body => (body as HTMLElement).innerText.slice(0, 6000)).catch(() => '')
    const snapshot = `Page text:\n${text}\nElements:\n${entries.join('\n')}`.slice(0, SNAPSHOT_LIMIT)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    const png = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10_000 })
    if (png.byteLength > FRAME_LIMIT) {
      for (const handle of refs.values()) await handle.dispose().catch(() => {})
      throw fail(`browser screenshot exceeds ${FRAME_LIMIT} bytes`, 'BROWSER_FAILED')
    }
    const observation: BrowserObservation = {
      generation: owner.generation, revision: owner.revision + 1, url: page.url(),
      title: (await page.title()).slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '),
      snapshot, viewport: VIEWPORT, cursor,
    }
    for (const handle of owner.refs.values()) await handle.dispose().catch(() => {})
    owner.refs = refs
    owner.revision = observation.revision
    const capture = { observation, png: new Uint8Array(png) }
    owner.capture = capture
    owner.lastUsed = Date.now()
    return capture
  }

  private async perform(owner: SessionPage, command: BrowserCommand): Promise<BrowserCapture> {
    const page = owner.page
    let cursor: BrowserObservation['cursor'] = null
    switch (command.kind) {
      case 'navigate':
        await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        break
      case 'click':
      case 'fill': {
        const handle = owner.refs.get(command.ref)
        if (owner.revision !== command.revision || handle === undefined) {
          throw fail(`stale browser element ${command.ref} at revision ${command.revision}`, 'BROWSER_STALE_REF')
        }
        const box = await handle.boundingBox()
        if (box === null) throw fail(`browser element no longer visible: ${command.ref}`, 'BROWSER_STALE_REF')
        if (box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= VIEWPORT.width ||
          box.y >= VIEWPORT.height) throw fail(`browser element outside viewport: ${command.ref}`, 'BROWSER_STALE_REF')
        cursor = { x: Math.round((Math.max(0, box.x) + Math.min(VIEWPORT.width, box.x + box.width)) / 2),
          y: Math.round((Math.max(0, box.y) + Math.min(VIEWPORT.height, box.y + box.height)) / 2),
          kind: command.kind, at: Date.now() }
        if (command.kind === 'click') await handle.click({ timeout: 10_000 })
        else await handle.fill(command.text, { timeout: 10_000 })
        break
      }
      case 'scroll':
        await page.mouse.wheel(0, (command.direction === 'down' ? 1 : -1) * Math.min(Math.max(command.pixels, 0), 720))
        cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, kind: 'scroll', at: Date.now() }
        break
      case 'snapshot':
      case 'screenshot': break
      case 'close': throw fail('close is handled outside page operations', 'BROWSER_FAILED')
      default: { const unreachable: never = command; throw new Error(`unknown browser command: ${String(unreachable)}`) }
    }
    return this.observe(owner, cursor)
  }

  /** @inheritdoc */
  execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture> {
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve()
    const operation = predecessor.catch(() => {}).then(async () => {
      if (signal.aborted) throw signal.reason
      if (this.disposed) throw fail('browser provider disposed', 'BROWSER_UNAVAILABLE')
      let owner = this.pages.get(sessionId)
      if (command.kind === 'close') {
        const capture = owner?.capture ?? { observation: { generation: randomUUID(), revision: 0,
          url: 'about:blank', title: '', snapshot: 'Browser session closed.', viewport: VIEWPORT, cursor: null }, png: null }
        if (owner) { this.pages.delete(sessionId); await this.destroy(owner) }
        return capture
      }
      if (!owner && command.kind !== 'navigate') throw fail('browser session is closed; navigate to open a page', 'BROWSER_CLOSED')
      if (command.kind === 'navigate') {
        if (command.url.length > 4096) throw fail('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
        await validateRequestUrl(command.url, this.allowedOrigins)
      }
      signal.throwIfAborted()
      const onAbort = (): void => {
        if (owner) {
          this.pages.delete(sessionId)
          void this.destroy(owner)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (!owner) {
          if (this.pages.size + this.pendingCreates >= MAX_SESSIONS) {
            throw fail('browser session limit reached', 'BROWSER_UNAVAILABLE')
          }
          // 初始化期间的中止同样要撤销刚启动的上下文。
          this.pendingCreates++
          try { owner = await this.create() }
          finally { this.pendingCreates-- }
          signal.throwIfAborted()
          this.pages.set(sessionId, owner)
        }
        const capture = await this.perform(owner, command)
        if (capture.observation.url.length > 4096) throw fail('browser page URL exceeds 4096 characters', 'BROWSER_FAILED')
        signal.throwIfAborted()
        return capture
      } catch (error) {
        if (owner && !(error instanceof BrowserUseError && error.code === 'BROWSER_STALE_REF')) {
          this.pages.delete(sessionId)
          await this.destroy(owner)
        }
        signal.throwIfAborted()
        if (error instanceof BrowserUseError) throw error
        throw new BrowserUseError('browser action failed', 'BROWSER_FAILED', { cause: error })
      } finally { signal.removeEventListener('abort', onAbort) }
    })
    const tail = operation.then(() => {}, () => {})
    this.tails.set(sessionId, tail)
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId) })
    return operation
  }

  /** @inheritdoc */
  latest(sessionId: SessionId): BrowserCapture | undefined {
    return this.pages.get(sessionId)?.capture
  }

  /** @inheritdoc */
  async closeSession(sessionId: SessionId): Promise<void> {
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve()
    const closing = predecessor.catch(() => {}).then(async () => {
      const owner = this.pages.get(sessionId)
      if (owner) { this.pages.delete(sessionId); await this.destroy(owner) }
    })
    const tail = closing.then(() => {}, () => {})
    this.tails.set(sessionId, tail)
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId) })
    await closing
  }

  private respond(req: IncomingMessage, res: ServerResponse, frame: boolean, webCtx: Context): void {
    const connection = Reflect.get(webCtx, 'connection') as {
      requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
    }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) { send(res, rejection); return }
    if (!trustedFrameRequest(req, webCtx.webServer.host, webCtx.webServer.port)) { send(res, 403); return }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405); return }
    let url: URL
    try { url = new URL(req.url ?? '', 'http://localhost') }
    catch { send(res, 400); return }
    const keys = [...url.searchParams.keys()]
    if (keys.some(key => key !== 'sessionId' && !(frame && (key === 'revision' || key === 'generation'))) ||
      keys.length !== (frame ? 3 : 1) || !validSessionId(url.searchParams.get('sessionId'))) { send(res, 400); return }
    const sessionId = url.searchParams.get('sessionId') as SessionId
    const capture = this.latest(sessionId)
    if (!capture) { send(res, frame ? 404 : 204); return }
    if (frame) {
      const revision = url.searchParams.get('revision')
      const generation = url.searchParams.get('generation')
      if (!revision || !/^[1-9][0-9]*$/.test(revision) || !generation ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(generation)) { send(res, 400); return }
      if (generation !== capture.observation.generation || Number(revision) !== capture.observation.revision ||
        !capture.png) { send(res, 409); return }
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-type', 'image/png')
      res.end(capture.png)
      return
    }
    send(res, 200, { ...capture.observation, hasFrame: capture.png !== null })
  }
}
