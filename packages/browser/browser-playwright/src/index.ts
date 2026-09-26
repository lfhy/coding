/** 隔离的 Chromium 页面提供方；每个会话只拥有一个内存上下文和只读画面。 @module @deepseek-ai/dsh-browser-playwright */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { BrowserUseError, BrowserUseService } from '@deepseek-ai/dsh-browser'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserObservation, BrowserSessionState, BrowserTabId, BrowserTabSummary } from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright'
import { validateAllowedOrigins, validateRequestUrl } from './policy.ts'
import { createBrowserProxy } from './proxy.ts'

const VIEWPORT = { width: 1280, height: 720 }
const VIEWPORT_LIMITS = { minWidth: 200, maxWidth: 1920, minHeight: 240, maxHeight: 1400, maxArea: 1_800_000 }
const SNAPSHOT_LIMIT = 12_000
const FRAME_LIMIT = 2 * 1024 * 1024
const ELEMENT_LIMIT = 150
const ELEMENT_SCAN_LIMIT = 50_000
const MAX_SESSIONS = 8
const MAX_TABS = 8
const IDLE_TIMEOUT = 10 * 60_000
const ELEMENT_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]'

/** 显式放行的精确 origin；空列表只允许经 DNS 校验的公网 HTTP(S)。 */
export interface Config {
  /** 显式放行的精确 HTTP(S) origin；默认只允许 DNS 校验通过的公网目的地。 */
  readonly allowedOrigins: string[]
}

interface SessionTab {
  readonly id: BrowserTabId
  readonly page: Page
  readonly generation: string
  revision: number
  refs: Map<string, ElementHandle>
  capture?: BrowserCapture
  summary: BrowserTabSummary
  history: string[]
  historyIndex: number
}

interface SessionPage {
  readonly browserContext: BrowserContext
  readonly proxy: Awaited<ReturnType<typeof createBrowserProxy>>
  readonly browserGeneration: string
  readonly tabs: Map<BrowserTabId, SessionTab>
  activeTabId: BrowserTabId
  stateRevision: number
  viewport: { width: number; height: number }
  pendingPages: Set<Page> | undefined
  closing: Promise<void> | undefined
  lastUsed: number
}

function tabId(): BrowserTabId { return randomUUID() as BrowserTabId }

async function validateFinalUrl(url: string, origins: ReadonlySet<string>): Promise<void> {
  if (url === 'about:blank') return
  await validateRequestUrl(url, origins)
}

function fail(message: string, code: 'BROWSER_FAILED' | 'BROWSER_STALE_REF' | 'BROWSER_UNAVAILABLE' | 'BROWSER_CLOSED'): BrowserUseError {
  return new BrowserUseError(message, code)
}

/** 已知的截图体积限制不会使页面执行状态失控；其余 BROWSER_FAILED 仍销毁会话。 */
class OversizedFrameError extends BrowserUseError {
  constructor() { super(`browser screenshot exceeds ${FRAME_LIMIT} bytes`, 'BROWSER_FAILED') }
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
      const id = tabId()
      const generation = randomUUID()
      const tab: SessionTab = { id, page, generation, revision: 0, refs: new Map(),
        summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false },
        history: [], historyIndex: -1 }
      const tabs = new Map([[id, tab]])
      const owner: SessionPage = { browserContext, proxy, browserGeneration: randomUUID(), tabs, activeTabId: id,
        stateRevision: 0, viewport: { ...VIEWPORT }, pendingPages: undefined, closing: undefined, lastUsed: Date.now() }
      browserContext.on('page', (opened) => {
        if ([...owner.tabs.values()].some(tab => tab.page === opened)) return
        if (owner.pendingPages) owner.pendingPages.add(opened)
        else void opened.close().catch(() => {})
      })
      page.on('dialog', (dialog) => { void dialog.dismiss() })
      return owner
    } catch (error) {
      await browserContext.close()
      await proxy.close()
      throw error
    }
  }

  private async destroy(owner: SessionPage): Promise<void> {
    owner.closing ??= (async () => {
      for (const tab of owner.tabs.values()) await this.clearRefs(tab)
      await owner.browserContext.close().catch(() => {})
      await owner.proxy.close()
    })()
    await owner.closing
  }

  private async clearRefs(tab: SessionTab): Promise<void> {
    for (const ref of tab.refs.values()) await ref.dispose().catch(() => {})
    tab.refs.clear()
  }

  private active(owner: SessionPage): SessionTab {
    const tab = owner.tabs.get(owner.activeTabId)
    if (!tab) throw fail('active browser tab is closed', 'BROWSER_CLOSED')
    return tab
  }

  private view(owner: SessionPage): BrowserSessionState {
    const active = this.active(owner)
    const capture = active.capture
    const current = capture?.observation.viewport.width === owner.viewport.width &&
      capture.observation.viewport.height === owner.viewport.height ? capture : undefined
    return { browserGeneration: owner.browserGeneration, stateRevision: owner.stateRevision,
      viewport: { ...owner.viewport },
      tabs: [...owner.tabs.values()].map(tab => ({ ...tab.summary })), activeTabId: active.id,
      observation: current?.observation ?? null, hasFrame: current?.png !== null && current?.png !== undefined }
  }

  private updateSummary(tab: SessionTab, title: string): void {
    const page = tab.page
    tab.summary = { id: tab.id, generation: tab.generation, url: page.url(), title,
      canGoBack: tab.historyIndex > 0, canGoForward: tab.historyIndex < tab.history.length - 1 }
  }

  private recordNavigation(tab: SessionTab): void {
    const url = tab.page.url()
    if (tab.history[tab.historyIndex] === url) return
    tab.history.splice(tab.historyIndex + 1)
    tab.history.push(url)
    tab.historyIndex = tab.history.length - 1
  }

  private async observe(owner: SessionPage, tab: SessionTab, cursor: BrowserObservation['cursor']): Promise<BrowserCapture> {
    const page = tab.page
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
    }, { selector: ELEMENT_SELECTOR, limit: ELEMENT_LIMIT, scanLimit: ELEMENT_SCAN_LIMIT, viewport: owner.viewport })
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
          item.x >= owner.viewport.width || item.y >= owner.viewport.height) {
          await handle.dispose().catch(() => {})
          continue
        }
        const ref = `e${refs.size + 1}-${tab.generation}-${randomUUID()}`
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
    const title = (await page.title()).slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    const png = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10_000 })
    await validateFinalUrl(page.url(), this.allowedOrigins)
    if (png.byteLength > FRAME_LIMIT) {
      for (const handle of refs.values()) await handle.dispose().catch(() => {})
      await this.clearRefs(tab)
      delete tab.capture
      this.recordNavigation(tab)
      this.updateSummary(tab, title)
      owner.stateRevision++
      owner.lastUsed = Date.now()
      throw new OversizedFrameError()
    }
    this.recordNavigation(tab)
    this.updateSummary(tab, title)
    const observation: BrowserObservation = {
      tabId: tab.id, generation: tab.generation, revision: tab.revision + 1, url: page.url(),
      title,
      snapshot, viewport: { ...owner.viewport }, cursor,
    }
    await this.clearRefs(tab)
    tab.refs = refs
    tab.revision = observation.revision
    const capture = { observation, png: new Uint8Array(png) }
    tab.capture = capture
    owner.stateRevision++
    owner.lastUsed = Date.now()
    return capture
  }

  private async perform(owner: SessionPage, tab: SessionTab, command: BrowserCommand): Promise<BrowserCapture> {
    const page = tab.page
    let cursor: BrowserObservation['cursor'] = null
    switch (command.kind) {
      case 'navigate':
        await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        break
      case 'click':
      case 'fill': {
        const handle = tab.refs.get(command.ref)
        if (tab.revision !== command.revision || handle === undefined) {
          throw fail(`stale browser element ${command.ref} at revision ${command.revision}`, 'BROWSER_STALE_REF')
        }
        const box = await handle.boundingBox()
        if (box === null) throw fail(`browser element no longer visible: ${command.ref}`, 'BROWSER_STALE_REF')
        if (box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= owner.viewport.width ||
          box.y >= owner.viewport.height) throw fail(`browser element outside viewport: ${command.ref}`, 'BROWSER_STALE_REF')
        cursor = { x: Math.round((Math.max(0, box.x) + Math.min(owner.viewport.width, box.x + box.width)) / 2),
          y: Math.round((Math.max(0, box.y) + Math.min(owner.viewport.height, box.y + box.height)) / 2),
          kind: command.kind, at: Date.now() }
        if (command.kind === 'click') await handle.click({ timeout: 10_000 })
        else await handle.fill(command.text, { timeout: 10_000 })
        break
      }
      case 'scroll':
        await page.mouse.wheel(0, (command.direction === 'down' ? 1 : -1) *
          Math.min(Math.max(command.pixels, 0), owner.viewport.height))
        cursor = { x: owner.viewport.width / 2, y: owner.viewport.height / 2, kind: 'scroll', at: Date.now() }
        break
      case 'snapshot':
      case 'screenshot': break
      case 'close': throw fail('close is handled outside page operations', 'BROWSER_FAILED')
      default: { const unreachable: never = command; throw new Error(`unknown browser command: ${String(unreachable)}`) }
    }
    return this.observe(owner, tab, cursor)
  }

  /** @inheritdoc */
  execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    return this.enqueue(sessionId, signal, async () => {
      let owner = this.pages.get(sessionId)
      if (expectedTarget) {
        if (expectedTarget.kind === 'none') {
          if (owner) throw fail('browser target changed while awaiting approval', 'BROWSER_STALE_REF')
        } else if (!owner || expectedTarget.browserGeneration !== owner.browserGeneration ||
          expectedTarget.stateRevision !== owner.stateRevision || expectedTarget.tabId !== owner.activeTabId ||
          expectedTarget.generation !== this.active(owner).generation ||
          expectedTarget.url !== undefined && (expectedTarget.url !== this.active(owner).summary.url ||
            expectedTarget.url !== this.active(owner).page.url())) {
          throw fail('browser target changed while awaiting approval', 'BROWSER_STALE_REF')
        }
      }
      if (command.kind === 'close') {
        const tab = owner && this.active(owner)
        const capture = tab?.capture ?? { observation: { tabId: tab?.id ?? tabId(), generation: randomUUID(), revision: 0,
          url: 'about:blank', title: '', snapshot: 'Browser session closed.',
          viewport: owner ? { ...owner.viewport } : VIEWPORT, cursor: null }, png: null }
        if (owner) { this.pages.delete(sessionId); await this.destroy(owner) }
        return capture
      }
      if (!owner && command.kind !== 'navigate') throw fail('browser session is closed; navigate to open a page', 'BROWSER_CLOSED')
      if (command.kind === 'navigate') await this.validateNavigation(command.url)
      if (!owner) owner = await this.createOwner(sessionId, signal)
      const tab = this.active(owner)
      if ((command.kind === 'click' || command.kind === 'fill') && tab.capture?.observation.url !== tab.page.url()) {
        throw fail('browser page changed since the element was observed', 'BROWSER_STALE_REF')
      }
      return this.perform(owner, tab, command)
    })
  }

  /** @inheritdoc */
  state(sessionId: SessionId): BrowserSessionState | undefined {
    const owner = this.pages.get(sessionId)
    return owner && this.view(owner)
  }

  /** @inheritdoc */
  async control(sessionId: SessionId, command: BrowserHumanCommand, signal: AbortSignal): Promise<BrowserSessionState | undefined> {
    signal.throwIfAborted()
    if (command.kind === 'set-viewport') this.validateViewport(command.width, command.height)
    return await this.enqueue(sessionId, signal, async () => {
      let owner = this.pages.get(sessionId)
      if (command.kind === 'navigate') await this.validateNavigation(command.url)
      if (!owner && command.kind !== 'navigate' && command.kind !== 'new-tab' && command.kind !== 'ensure-tab') return undefined
      const created = !owner
      if (!owner) owner = await this.createOwner(sessionId, signal)
      switch (command.kind) {
        case 'ensure-tab': break
        case 'new-tab': {
          if (created) break
          if (owner.tabs.size >= MAX_TABS) throw fail('browser tab limit reached', 'BROWSER_UNAVAILABLE')
          // page 事件可能与内部 newPage 同期到达；只承认 newPage 返回的确切句柄。
          const pending = new Set<Page>()
          owner.pendingPages = pending
          let createdPage: Page | undefined
          try {
            createdPage = await owner.browserContext.newPage()
            if (owner.viewport.width !== VIEWPORT.width || owner.viewport.height !== VIEWPORT.height) {
              await createdPage.setViewportSize(owner.viewport)
            }
            const id = tabId()
            const generation = randomUUID()
            const tab: SessionTab = { id, page: createdPage, generation, revision: 0, refs: new Map(),
              summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false },
              history: [], historyIndex: -1 }
            owner.tabs.set(id, tab)
            createdPage.on('dialog', (dialog) => { void dialog.dismiss() })
            owner.activeTabId = id
            owner.stateRevision++
          } finally {
            owner.pendingPages = undefined
            await Promise.all([...pending].filter(page => page !== createdPage).map(page => page.close().catch(() => {})))
          }
          break
        }
        case 'select-tab': {
          const selected = owner.tabs.get(command.tabId)
          if (!selected) throw fail('browser tab is closed', 'BROWSER_CLOSED')
          await selected.page.bringToFront()
          owner.activeTabId = command.tabId
          owner.stateRevision++
          if (this.needsObservation(owner, selected)) {
            await this.settleViewport(selected.page)
            await this.observe(owner, selected, null)
          }
          break
        }
        case 'close-tab': {
          const tab = owner.tabs.get(command.tabId)
          if (!tab) throw fail('browser tab is closed', 'BROWSER_CLOSED')
          await this.clearRefs(tab)
          owner.tabs.delete(command.tabId)
          await tab.page.close()
          if (owner.tabs.size === 0) {
            this.pages.delete(sessionId)
            await this.destroy(owner)
            return undefined
          }
          if (owner.activeTabId === command.tabId) owner.activeTabId = owner.tabs.keys().next().value as BrowserTabId
          owner.stateRevision++
          break
        }
        case 'navigate':
          await this.active(owner).page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          await this.observe(owner, this.active(owner), null)
          break
        case 'set-viewport': {
          if (owner.viewport.width === command.width && owner.viewport.height === command.height) break
          owner.viewport = { width: command.width, height: command.height }
          owner.stateRevision++
          for (const tab of owner.tabs.values()) {
            await this.clearRefs(tab)
            await tab.page.setViewportSize(owner.viewport)
          }
          const active = this.active(owner)
          if (this.needsObservation(owner, active)) {
            await this.settleViewport(active.page)
            await this.observe(owner, active, null)
          }
          break
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const tab = this.active(owner)
          const result = command.kind === 'back'
            ? await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 })
            : command.kind === 'forward'
              ? await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 })
              : await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
          if (command.kind === 'back' && result && tab.historyIndex > 0) tab.historyIndex--
          if (command.kind === 'forward' && result && tab.historyIndex < tab.history.length - 1) tab.historyIndex++
          await this.observe(owner, tab, null)
          break
        }
        default: { const unreachable: never = command; throw new Error(`unknown browser command: ${String(unreachable)}`) }
      }
      owner.lastUsed = Date.now()
      return this.view(owner)
    })
  }

  private async validateNavigation(url: string): Promise<void> {
    if (url.length > 4096) throw fail('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
    await validateRequestUrl(url, this.allowedOrigins)
  }

  private validateViewport(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < VIEWPORT_LIMITS.minWidth || width > VIEWPORT_LIMITS.maxWidth ||
      height < VIEWPORT_LIMITS.minHeight || height > VIEWPORT_LIMITS.maxHeight ||
      width * height > VIEWPORT_LIMITS.maxArea) {
      throw fail('browser viewport must be 200..1920 by 240..1400 pixels with area at most 1800000', 'BROWSER_FAILED')
    }
  }

  private needsObservation(owner: SessionPage, tab: SessionTab): boolean {
    const viewport = tab.capture?.observation.viewport
    if (!viewport) return tab.page.url() !== 'about:blank'
    return viewport.width !== owner.viewport.width || viewport.height !== owner.viewport.height
  }

  private async settleViewport(page: Page): Promise<void> {
    // Chromium 的尺寸调用可能先于 resize 事件兑现，下一帧后页面响应式状态才可用于观测。
    await page.evaluate(() => new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 200)
      requestAnimationFrame(() => { clearTimeout(timeout); resolve() })
    }))
  }

  private async createOwner(sessionId: SessionId, signal: AbortSignal): Promise<SessionPage> {
    if (this.pages.size + this.pendingCreates >= MAX_SESSIONS) throw fail('browser session limit reached', 'BROWSER_UNAVAILABLE')
    this.pendingCreates++
    try {
      const owner = await this.create()
      if (signal.aborted) { await this.destroy(owner); throw signal.reason }
      this.pages.set(sessionId, owner)
      return owner
    } finally { this.pendingCreates-- }
  }

  private enqueue<T>(sessionId: SessionId, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(sessionId) ?? Promise.resolve()
    const operation = predecessor.catch(() => {}).then(async () => {
      if (signal.aborted) throw signal.reason
      if (this.disposed) throw fail('browser provider disposed', 'BROWSER_UNAVAILABLE')
      signal.throwIfAborted()
      const onAbort = (): void => {
        const owner = this.pages.get(sessionId)
        if (owner) {
          this.pages.delete(sessionId)
          void this.destroy(owner)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await run()
        signal.throwIfAborted()
        return result
      } catch (error) {
        const owner = this.pages.get(sessionId)
        if (owner && !(error instanceof OversizedFrameError || error instanceof BrowserUseError &&
          ['BROWSER_STALE_REF', 'BROWSER_CLOSED', 'BROWSER_UNAVAILABLE'].includes(error.code))) {
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
    const owner = this.pages.get(sessionId)
    if (!owner) return undefined
    const capture = this.active(owner).capture
    return capture?.observation.viewport.width === owner.viewport.width &&
      capture.observation.viewport.height === owner.viewport.height ? capture : undefined
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
    const frameKeys = ['tabId', 'browserGeneration', 'stateRevision', 'generation', 'revision']
    if (keys.some(key => key !== 'sessionId' && !(frame && frameKeys.includes(key))) ||
      keys.length !== (frame ? 6 : 1) || !validSessionId(url.searchParams.get('sessionId'))) { send(res, 400); return }
    const sessionId = url.searchParams.get('sessionId') as SessionId
    const state = this.state(sessionId)
    if (!state) { send(res, frame ? 404 : 204); return }
    const capture = this.latest(sessionId)
    if (frame) {
      const generation = url.searchParams.get('generation')
      const tabId = url.searchParams.get('tabId')
      const browserGeneration = url.searchParams.get('browserGeneration')
      const stateRevision = url.searchParams.get('stateRevision')
      const revision = url.searchParams.get('revision')
      if (!revision || !/^[1-9][0-9]*$/.test(revision) || !stateRevision ||
        !/^(0|[1-9][0-9]*)$/.test(stateRevision) || !generation || !/^[a-zA-Z0-9-]{1,128}$/.test(generation) ||
        !tabId || !/^[a-zA-Z0-9-]{1,128}$/.test(tabId) || !browserGeneration ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(browserGeneration)) { send(res, 400); return }
      if (browserGeneration !== state.browserGeneration || Number(stateRevision) !== state.stateRevision ||
        tabId !== state.activeTabId || generation !== capture?.observation.generation ||
        Number(revision) !== capture.observation.revision || !capture.png) { send(res, 409); return }
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-type', 'image/png')
      res.end(capture.png)
      return
    }
    send(res, 200, state)
  }
}
