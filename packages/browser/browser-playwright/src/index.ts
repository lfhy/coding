/** 隔离的 Chromium 页面提供方；每个会话只拥有一个内存上下文和只读画面。 @module coding-browser-playwright */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { DEFAULT_MAX_SOURCE_IMAGE_BYTES, DEFAULT_MAX_SOURCE_IMAGE_PIXELS, normalizeImage } from 'coding-attachment-local'
import { AttachmentError } from 'coding-attachment'
import { BrowserUseError, BrowserUseService } from 'coding-browser'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserHumanTarget, BrowserObservation, BrowserSessionState, BrowserStep, BrowserStepResult, BrowserTabId, BrowserTabSummary } from 'coding-browser'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type { SessionId } from 'coding-session/types'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, ElementHandle, JSHandle, Page } from 'playwright'
import { validateBrowserUrl } from './url.ts'

const VIEWPORT = { width: 1280, height: 720 }
const VIEWPORT_LIMITS = { minWidth: 200, maxWidth: 1920, minHeight: 240, maxHeight: 1400, maxArea: 1_800_000 }
const SNAPSHOT_LIMIT = 12_000
const FRAME_LIMIT = 2 * 1024 * 1024
// Chromium 的受控视口至多 720 万设备像素；仍限制跨进程返回的编码数据与解码量。
const FRAME_SOURCE_LIMITS = { maxSourceBytes: DEFAULT_MAX_SOURCE_IMAGE_BYTES,
  maxSourcePixels: DEFAULT_MAX_SOURCE_IMAGE_PIXELS, maxSourceFrames: 1 }
const ELEMENT_LIMIT = 150
const ELEMENT_SCAN_LIMIT = 50_000
const MAX_SESSIONS = 8
const MAX_TABS = 8
const MAX_ACT_STEPS = 8
// 批次内中间点击后等待主框架导航的上限；仅用于避免后续步骤落进即将卸载的文档。
const ACT_SETTLE_MS = 500
const MAX_STEP_REASON_CHARS = 200
const IDLE_TIMEOUT = 10 * 60_000
const ELEMENT_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]'
// 文件输入通常被页面藏起来，单独按 FILE_INPUT_LIMIT 列出，供 browser_upload 引用。
const FILE_INPUT_LIMIT = 3

interface SessionTab {
  readonly id: BrowserTabId
  readonly page: Page
  readonly generation: string
  documentHandle: JSHandle<Document>
  revision: number
  refs: Map<string, ElementHandle>
  /** 本次观测里属于文件输入的引用；点击和填写拒绝它们，上传要求它们。 */
  fileInputs: Set<string>
  capture?: BrowserCapture
  summary: BrowserTabSummary
  history: string[]
  historyIndex: number
}

interface SessionPage {
  readonly browserContext: BrowserContext
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

function fail(message: string, code: 'BROWSER_FAILED' | 'BROWSER_STALE_REF' | 'BROWSER_UNAVAILABLE' | 'BROWSER_CLOSED' | 'BROWSER_BUSY'): BrowserUseError {
  return new BrowserUseError(message, code)
}

/**
 * Playwright 可用性失败的最短可读原因；调用方据此把点击失败报成带原因的过期引用。
 * @param error 点击或填写抛出的原始错误。
 * @returns 面向模型的一句话原因。
 */
function actionabilityReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/intercepts pointer events/i.test(message)) return 'is covered by another element'
  if (/outside of the viewport/i.test(message)) return 'is outside the visible viewport'
  if (/not visible/i.test(message)) return 'is hidden'
  if (/not stable/i.test(message)) return 'keeps moving'
  if (/not enabled|disabled/i.test(message)) return 'is disabled'
  if (/not editable|cannot be filled|not an <input>|not a form control/i.test(message)) return 'is not editable'
  if (/does not receive events/i.test(message)) return 'does not receive pointer events'
  return 'did not become actionable'
}

/**
 * 上传失败的最短可读原因；文件路径只在工具参数里出现，不回显到页面内容附近。
 * @param error Playwright 抛出的原始错误。
 * @returns 面向模型的一句话原因。
 */
function uploadReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Non-multiple file input/i.test(message)) return 'accepts a single file only'
  if (/webkitdirectory/i.test(message)) return 'accepts a directory only'
  if (/not an HTMLInputElement/i.test(message)) return 'is not a file input'
  if (/ENOENT|no such file|File not found|Cannot access/i.test(message)) return 'cannot read the requested file'
  return 'did not accept the files'
}

/**
 * 批次内一步失败的原因文本：去掉控制字符并限长后交给模型，避免页面内容过长撑大结果。
 * @param error 该步抛出的错误。
 * @param ref 该步的模型输入引用。
 * @returns 一句话失败原因。
 */
function stepFailureReason(error: BrowserUseError, ref: string): string {
  const message = error.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const reason = message === '' ? `${ref} could not be used` : message
  return reason.slice(0, MAX_STEP_REASON_CHARS)
}

/** 已知的画面限额不会使页面执行状态失控；其余 BROWSER_FAILED 仍销毁会话。 */
class OversizedFrameError extends BrowserUseError {
  constructor() { super(`browser screenshot exceeds ${FRAME_LIMIT} bytes`, 'BROWSER_FAILED') }
}
/** 新标签导航失败且仅回收该标签页后，保留原会话。 */
class RolledBackTabError extends BrowserUseError {
  constructor(cause: unknown) { super('browser new tab navigation failed', 'BROWSER_FAILED', { cause }) }
}

/** URL 校验未触碰页面；错误不撤销已有会话。 */
class InvalidNavigationInputError extends BrowserUseError {
  constructor(error: BrowserUseError) { super(error.message, error.code, { cause: error }) }
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
  private readonly pages = new Map<SessionId, SessionPage>()
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly operations = new Map<SessionId, symbol>()
  private pendingCreates = 0
  private browser: Promise<Browser> | undefined
  private readonly reapTimer: NodeJS.Timeout
  private disposed = false

  constructor(ctx: Context) {
    super(ctx)
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
        if (Date.now() - owner.lastUsed >= IDLE_TIMEOUT && !this.tails.has(id) && !this.operations.has(id)) {
          this.pages.delete(id)
          void this.destroy(owner).catch(() => {})
        }
      }
    }, 60_000)
    this.reapTimer.unref()
    // oxlint-disable-next-line typescript/no-misused-promises -- SessionStore 等待异步清理完成。
    ctx.on('session/disposed', async (session) => {
      await this.closeSession(session.id)
    })
    ctx.effect(() => async () => {
      this.disposed = true
      clearInterval(this.reapTimer)
      this.operations.clear()
      await Promise.all([...this.tails.values()])
      await Promise.all([...this.pages.values()].map(page => this.destroy(page)))
      if (this.browser) await (await this.browser).close()
    }, 'browser-playwright: browser lifetime')
  }

  private async launch(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true }).catch((error: unknown) => {
      this.browser = undefined
      throw new BrowserUseError('Chromium unavailable; install the matching Playwright Chromium browser with pnpm exec playwright install chromium or configure the system browser installation.', 'BROWSER_UNAVAILABLE', { cause: error })
    })
    return this.browser
  }

  private async create(): Promise<SessionPage> {
    const browser = await this.launch()
    const browserContext = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, acceptDownloads: false,
      // 页面只能写入剪贴板，使「复制」按钮在自动化里照常工作；读取剪贴板会让任意页面拿到
      // 用户系统剪贴板内容，因此与其它权限一起保持拒绝。
      permissions: ['clipboard-write'],
    })
    try {
      const page = await browserContext.newPage()
      const documentHandle = await page.evaluateHandle(() => document)
      const id = tabId()
      const generation = randomUUID()
      const tab: SessionTab = { id, page, generation, documentHandle, revision: 0, refs: new Map(),
        fileInputs: new Set(),
        summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false },
        history: [], historyIndex: -1 }
      const tabs = new Map([[id, tab]])
      const owner: SessionPage = { browserContext, browserGeneration: randomUUID(), tabs, activeTabId: id,
        stateRevision: 0, viewport: { ...VIEWPORT }, pendingPages: undefined, closing: undefined, lastUsed: Date.now() }
      browserContext.on('page', (opened) => {
        if ([...owner.tabs.values()].some(tab => tab.page === opened)) return
        if (owner.pendingPages) owner.pendingPages.add(opened)
        else void opened.close().catch(() => {})
      })
      page.on('dialog', (dialog) => { void dialog.dismiss() })
      this.trackNavigation(owner, tab)
      return owner
    } catch (error) {
      await browserContext.close()
      throw error
    }
  }

  private async destroy(owner: SessionPage): Promise<void> {
    owner.closing ??= (async () => {
      for (const tab of owner.tabs.values()) {
        await this.clearRefs(tab)
        await tab.documentHandle.dispose().catch(() => {})
      }
      await owner.browserContext.close().catch(() => {})
    })()
    await owner.closing
  }

  private trackNavigation(owner: SessionPage, tab: SessionTab): void {
    tab.page.on('framenavigated', (frame) => {
      if (frame !== tab.page.mainFrame()) return
      // 同 URL 重载也替换 Document；撤销旧画面并使审批及截图坐标的状态修订版失效。
      delete tab.capture
      const refs = tab.refs
      tab.refs = new Map()
      void Promise.all([...refs.values()].map(ref => ref.dispose().catch(() => {})))
      owner.stateRevision++
      owner.lastUsed = Date.now()
    })
  }

  private async sameDocument(tab: SessionTab): Promise<boolean> {
    try { return await tab.documentHandle.evaluate(doc => doc === document) }
    catch { return false }
  }

  private async clearRefs(tab: SessionTab): Promise<void> {
    for (const ref of tab.refs.values()) await ref.dispose().catch(() => {})
    tab.refs.clear()
    tab.fileInputs.clear()
  }

  /** 只刷新审批所需的 URL 与 Document 身份，不观测页面或发布截图。 */
  private async refreshTarget(owner: SessionPage): Promise<BrowserExpectedTarget> {
    const tab = this.active(owner)
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = owner.stateRevision
      const url = tab.page.url()
      const current = await tab.page.evaluateHandle(() => document)
      let adopted = false
      let disposed = false
      try {
        const same = await this.sameDocument(tab)
        const stable = await current.evaluate(doc => doc === document).catch(() => false)
        if (revision !== owner.stateRevision || url !== tab.page.url() || !stable) continue
        if (!same || tab.summary.url !== url) {
          delete tab.capture
          await this.clearRefs(tab)
          if (revision !== owner.stateRevision || url !== tab.page.url() ||
            !await current.evaluate(doc => doc === document).catch(() => false)) continue
          const previous = tab.documentHandle
          tab.documentHandle = current
          adopted = true
          tab.summary = { ...tab.summary, url, title: '' }
          this.recordNavigation(tab)
          owner.stateRevision++ // 导航事件尚未到达时也撤销旧审批，并通知只读状态的消费方。
          const boundRevision = owner.stateRevision
          await previous.dispose().catch(() => {})
          if (boundRevision !== owner.stateRevision || url !== tab.page.url() ||
            !await current.evaluate(doc => doc === document).catch(() => false) ||
            boundRevision !== owner.stateRevision) continue
        }
        if (!adopted) {
          await current.dispose().catch(() => {})
          disposed = true
        }
        if ((!adopted && owner.stateRevision !== revision) || url !== tab.page.url()) continue
        owner.lastUsed = Date.now()
        return { kind: 'tab', browserGeneration: owner.browserGeneration, stateRevision: owner.stateRevision,
          tabId: tab.id, generation: tab.generation, url }
      } finally { if (!adopted && !disposed) await current.dispose().catch(() => {}) }
    }
    throw fail('browser target changed during preparation', 'BROWSER_STALE_REF')
  }

  private active(owner: SessionPage): SessionTab {
    const tab = owner.tabs.get(owner.activeTabId)
    if (!tab) throw fail('active browser tab is closed', 'BROWSER_CLOSED')
    return tab
  }

  private view(sessionId: SessionId, owner: SessionPage): BrowserSessionState {
    const active = this.active(owner)
    const capture = active.capture
    const current = capture?.observation.viewport.width === owner.viewport.width &&
      capture.observation.viewport.height === owner.viewport.height ? capture : undefined
    return { operationActive: this.operationActive(sessionId), browserGeneration: owner.browserGeneration,
      stateRevision: owner.stateRevision,
      viewport: { ...owner.viewport },
      tabs: [...owner.tabs.values()].map(tab => ({ ...tab.summary })), activeTabId: active.id,
      observation: current?.observation ?? null, hasFrame: current?.png !== null && current?.png !== undefined }
  }

  /** @inheritdoc */
  operationActive(sessionId: SessionId): boolean { return this.operations.has(sessionId) }

  /** @inheritdoc */
  override prepareTarget(sessionId: SessionId, signal: AbortSignal): Promise<BrowserExpectedTarget> {
    return this.enqueue(sessionId, signal, async () => {
      const owner = this.pages.get(sessionId)
      return owner ? this.refreshTarget(owner) : { kind: 'none' }
    })
  }

  private ensureAvailable(): void {
    if (this.disposed) throw fail('browser provider disposed', 'BROWSER_UNAVAILABLE')
  }

  /** @inheritdoc */
  async acquireOperation(sessionId: SessionId, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    this.ensureAvailable()
    if (this.operations.has(sessionId)) throw fail('browser operation already active', 'BROWSER_BUSY')
    const token = Symbol('browser operation')
    this.operations.set(sessionId, token)
    const release = (): void => { if (this.operations.get(sessionId) === token) this.operations.delete(sessionId) }
    let onAbort = (): void => {}
    try {
      await Promise.race([
        this.tails.get(sessionId) ?? Promise.resolve(),
        new Promise<never>((_resolve, reject) => {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- 必须向调用方透传原始 AbortSignal.reason。
          onAbort = () => { reject(signal.reason) }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
      signal.throwIfAborted()
      this.ensureAvailable()
      return release
    } catch (error) { release(); throw error }
    finally { signal.removeEventListener('abort', onAbort) }
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
    const documentHandle = await page.evaluateHandle(() => document)
    const stateRevision = owner.stateRevision
    try {
      return await this.observeDocument(owner, tab, cursor, documentHandle, stateRevision, refs)
    } catch (error) {
      const changed = error instanceof BrowserUseError && error.code === 'BROWSER_STALE_REF' ||
        owner.stateRevision !== stateRevision ||
        !await documentHandle.evaluate(doc => doc === document).catch(() => false)
      await documentHandle.dispose().catch(() => {})
      for (const ref of refs.values()) await ref.dispose().catch(() => {})
      if (!(error instanceof OversizedFrameError) && changed) {
        delete tab.capture
        await this.clearRefs(tab)
        if (owner.stateRevision === stateRevision) owner.stateRevision++
        throw fail('browser document changed during observation', 'BROWSER_STALE_REF')
      }
      throw error
    }
  }

  private async observeDocument(owner: SessionPage, tab: SessionTab, cursor: BrowserObservation['cursor'],
    documentHandle: JSHandle<Document>, stateRevision: number, refs: Map<string, ElementHandle>): Promise<BrowserCapture> {
    const page = tab.page
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
        // 文件输入单独列在 File inputs：点它只会弹系统选择框，上传要按引用指定文件。
        if (element instanceof HTMLInputElement && element.type === 'file') continue
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
          if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' ||
            style.pointerEvents === 'none') return null
          // 观测只列出此刻真能点的元素：被禁用或 pointer-events 关闭的目标列出来只会让
          // 模型白点一轮。遮挡交给点击时的可用性检查，那里能报出具体原因。
          if (element.closest('[inert], [aria-disabled="true"]')) return null
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
    const fileInputs = new Set<string>()
    const fileEntries = await this.fileEntries(tab, refs, fileInputs)
    const text = await page.locator('body').evaluate(body => (body as HTMLElement).innerText.slice(0, 6000)).catch(() => '')
    const sections = `Page text:\n${text}\nElements:\n${entries.join('\n')}`
    const snapshot = (fileEntries.length === 0 ? sections : `${sections}\nFile inputs:\n${fileEntries.join('\n')}`)
      .slice(0, SNAPSHOT_LIMIT).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    const title = (await page.title()).slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    let png: Uint8Array = await page.screenshot({ type: 'png', scale: 'device', animations: 'disabled', timeout: 10_000 })
    if (owner.stateRevision !== stateRevision ||
      !await documentHandle.evaluate(doc => doc === document).catch(() => false)) {
      throw fail('browser document changed during observation', 'BROWSER_STALE_REF')
    }
    if (png.byteLength > FRAME_LIMIT) {
      try {
        const normalized = await normalizeImage(png, { maxBytes: FRAME_LIMIT, ...FRAME_SOURCE_LIMITS })
        if (normalized.metadata.mediaType !== 'image/png') throw fail('browser screenshot is not PNG', 'BROWSER_FAILED')
        png = normalized.data
      } catch (error) {
        if (owner.stateRevision !== stateRevision ||
          !await documentHandle.evaluate(doc => doc === document).catch(() => false)) {
          throw fail('browser document changed during observation', 'BROWSER_STALE_REF')
        }
        if (error instanceof AttachmentError &&
          (error.code === 'IMAGE_TOO_LARGE' || error.code === 'IMAGE_TOO_MANY_PIXELS')) {
          await this.clearRefs(tab)
          delete tab.capture
          this.recordNavigation(tab)
          this.updateSummary(tab, title)
          owner.stateRevision++
          owner.lastUsed = Date.now()
          throw new OversizedFrameError()
        }
        throw error
      }
      if (owner.stateRevision !== stateRevision ||
        !await documentHandle.evaluate(doc => doc === document).catch(() => false)) {
        throw fail('browser document changed during observation', 'BROWSER_STALE_REF')
      }
    }
    this.recordNavigation(tab)
    this.updateSummary(tab, title)
    const observation: BrowserObservation = {
      tabId: tab.id, generation: tab.generation, revision: tab.revision + 1, url: page.url(),
      title,
      snapshot, viewport: { ...owner.viewport }, cursor,
    }
    await this.clearRefs(tab)
    await tab.documentHandle.dispose().catch(() => {})
    if (owner.stateRevision !== stateRevision ||
      !await documentHandle.evaluate(doc => doc === document).catch(() => false)) {
      throw fail('browser document changed during observation', 'BROWSER_STALE_REF')
    }
    tab.documentHandle = documentHandle
    tab.refs = refs
    tab.fileInputs = fileInputs
    tab.revision = observation.revision
    const capture = { observation, png: new Uint8Array(png) }
    tab.capture = capture
    owner.stateRevision++
    owner.lastUsed = Date.now()
    return capture
  }

  /**
   * 收集当前文档的文件输入控件，包括页面藏起来的真实 input（常见做法是把它藏在样式化按钮后面）。
   * 每次观测最多 FILE_INPUT_LIMIT 个，引用与其他元素共用同一份 refs 与观测修订版；
   * 这些引用只能用于 `upload`，点击或填写会在 elementStep 里被拒绝。
   * @param tab 当前标签页；引用随下一次观测作废。
   * @param refs 本次观测的引用表。
   * @param fileInputs 输出参数：记下本次观测里属于文件输入的引用。
   * @returns 快照 `File inputs:` 段的行。
   */
  private async fileEntries(tab: SessionTab, refs: Map<string, ElementHandle>,
    fileInputs: Set<string>): Promise<string[]> {
    const selection = await tab.page.evaluateHandle(({ limit, scanLimit }: { limit: number; scanLimit: number }) => {
      const found: HTMLInputElement[] = []
      const walkers = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT)]
      let scanned = 0
      while (walkers.length && scanned < scanLimit && found.length < limit) {
        const walker = walkers[walkers.length - 1]
        if (!walker?.nextNode()) { walkers.pop(); continue }
        scanned++
        const element = walker.currentNode as Element
        if (element.shadowRoot) walkers.push(document.createTreeWalker(element.shadowRoot, NodeFilter.SHOW_ELEMENT))
        if (element instanceof HTMLInputElement && element.type === 'file') found.push(element)
      }
      return found
    }, { limit: FILE_INPUT_LIMIT, scanLimit: ELEMENT_SCAN_LIMIT })
    let candidates: Awaited<ReturnType<typeof selection.getProperties>>
    try { candidates = await selection.getProperties() }
    finally { await selection.dispose() }
    const rows: string[] = []
    try {
      for (const candidate of candidates.values()) {
        const handle = candidate.asElement() as ElementHandle | null
        if (handle === null) { await candidate.dispose(); continue }
        const info = await handle.evaluate((element: Element) => {
          const input = element as HTMLInputElement
          const label = input.labels && input.labels.length > 0 ? (input.labels[0] as HTMLElement).innerText : ''
          return {
            name: (input.getAttribute('aria-label') || input.getAttribute('placeholder') ||
              input.getAttribute('title') || label || '').trim().slice(0, 160),
            accept: (input.getAttribute('accept') || '').slice(0, 120),
            multiple: input.multiple,
            selected: input.files?.length ?? 0,
          }
        }).catch(() => null)
        if (info === null) { await handle.dispose().catch(() => {}); continue }
        const ref = `f${rows.length + 1}-${tab.generation}-${randomUUID()}`
        const details = [info.accept === '' ? '' : `accept=${info.accept}`, info.multiple ? 'multiple' : 'single',
          info.selected === 0 ? 'no file selected' : `${info.selected} selected`].filter(part => part !== '').join(', ')
        refs.set(ref, handle)
        fileInputs.add(ref)
        rows.push(`${ref} ${JSON.stringify(info.name)} (${details})`)
      }
    } catch (error) {
      for (const candidate of candidates.values()) await candidate.dispose().catch(() => {})
      throw error
    }
    return rows
  }

  /**
   * 在当前观测的元素引用上执行一步点击或填写，并给出指针落点。
   * 元素缺失、移出视口或当下不可用一律以 `BROWSER_STALE_REF` 拒绝，不重试、不换目标。
   * @param owner 元素所属会话；用于视口边界。
   * @param tab 元素引用所属标签页。
   * @param step 要执行的一步元素操作；`ref` 必须来自该标签页当前观测。
   * @returns 这一步的指针位置与时间。
   */
  private async elementStep(owner: SessionPage, tab: SessionTab, step: BrowserStep): Promise<BrowserObservation['cursor']> {
    const handle = tab.refs.get(step.ref)
    if (handle === undefined) throw fail(`browser element is no longer current: ${step.ref}`, 'BROWSER_STALE_REF')
    if (tab.fileInputs.has(step.ref)) {
      // 文件输入既不接受文本也不是「点一下就完成」的目标：点它会弹系统选择框。
      throw fail(`browser element ${step.ref} is a file input; call browser_upload with this ref instead of ${step.kind === 'click' ? 'clicking' : 'filling'} it`, 'BROWSER_STALE_REF')
    }
    if (step.kind === 'click' && await this.opensFileChooser(handle)) {
      throw fail(`browser element ${step.ref} opens a file chooser; call browser_upload with the file input ref listed under File inputs`, 'BROWSER_STALE_REF')
    }
    const box = await handle.boundingBox()
    if (box === null) throw fail(`browser element no longer visible: ${step.ref}`, 'BROWSER_STALE_REF')
    if (box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= owner.viewport.width ||
      box.y >= owner.viewport.height) throw fail(`browser element outside viewport: ${step.ref}`, 'BROWSER_STALE_REF')
    const cursor = { x: Math.round((Math.max(0, box.x) + Math.min(owner.viewport.width, box.x + box.width)) / 2),
      y: Math.round((Math.max(0, box.y) + Math.min(owner.viewport.height, box.y + box.height)) / 2),
      kind: step.kind, at: Date.now() }
    try {
      if (step.kind === 'click') await handle.click({ timeout: 10_000 })
      else await handle.fill(step.text, { timeout: 10_000 })
    } catch (error) {
      if (error instanceof BrowserUseError) throw error
      // Playwright 的可用性检查失败表示元素当下点不动；报成过期引用并带上原因，
      // 模型才知道该关掉遮挡、滚动还是换目标，而不是收到一句笼统的操作失败。
      throw fail(`browser element ${step.ref} ${actionabilityReason(error)}`, 'BROWSER_STALE_REF')
    }
    return cursor
  }

  /**
   * 点击会不会打开系统文件选择框：目标本身、它关联或内部包含的文件输入控件。
   * 无法判断的脚本调用（例如按钮里执行 showPicker）仍可能在提供方之外弹框，因此只作前置提示。
   * @param handle 即将点击的元素句柄。
   * @returns 该点击是否会触发文件选择框。
   */
  private async opensFileChooser(handle: ElementHandle): Promise<boolean> {
    return handle.evaluate((element: Element) => {
      const isFile = (node: Element | null | undefined): boolean =>
        node instanceof HTMLInputElement && node.type === 'file'
      if (isFile(element)) return true
      const label = element.closest('label')
      if (label instanceof HTMLLabelElement && isFile(label.control)) return true
      const nested = element.querySelector('label')
      return nested instanceof HTMLLabelElement && isFile(nested.control)
    }).catch(() => false)
  }

  /**
   * 把文件交给当前观测里的文件输入控件：不打开系统文件选择框，也不移动鼠标。
   * 引用必须来自 `File inputs:`，且在同一次观测的修订版内；失败不重试。
   * @param tab 引用所属标签页。
   * @param command 已校验的上传命令，`files` 为提供方世界的绝对路径。
   * @returns 无返回值；成功路径由调用方统一重新观测。
   */
  private async uploadFiles(tab: SessionTab, command: Extract<BrowserCommand, { kind: 'upload' }>): Promise<void> {
    const handle = tab.refs.get(command.ref)
    if (!tab.fileInputs.has(command.ref) || handle === undefined) {
      throw fail(`browser element ${command.ref} is not a file input in the current observation; use a ref listed under File inputs`, 'BROWSER_STALE_REF')
    }
    try {
      await handle.setInputFiles([...command.files], { timeout: 10_000 })
    } catch (error) {
      if (error instanceof BrowserUseError) throw error
      throw fail(`browser file input ${command.ref} ${uploadReason(error)}`, 'BROWSER_STALE_REF')
    }
  }

  /**
   * 批次内非末步的点击可能异步提交表单；给导航一个短暂窗口，
   * 让下一步在文档已被替换时停下，而不是把输入丢进即将卸载的文档。
   * @param tab 刚被点击的标签页。
   * @returns 是否已经开始主框架导航。
   */
  private async navigatedAfterClick(tab: SessionTab): Promise<boolean> {
    const navigated = await tab.page.waitForEvent('framenavigated', {
      timeout: ACT_SETTLE_MS, predicate: (frame: unknown) => frame === tab.page.mainFrame(),
    }).then(() => true, () => false)
    return navigated || !await this.sameDocument(tab)
  }

  private async perform(owner: SessionPage, tab: SessionTab, command: BrowserCommand): Promise<BrowserCapture> {
    const page = tab.page
    let cursor: BrowserObservation['cursor'] = null
    let steps: BrowserStepResult[] | undefined
    switch (command.kind) {
      case 'navigate':
        await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        break
      case 'click':
      case 'fill': {
        if (tab.revision !== command.revision) {
          throw fail(`stale browser element ${command.ref} at revision ${command.revision}`, 'BROWSER_STALE_REF')
        }
        cursor = await this.elementStep(owner, tab, command)
        break
      }
      case 'upload': {
        if (tab.revision !== command.revision) {
          throw fail(`stale browser file input ${command.ref} at revision ${command.revision}`, 'BROWSER_STALE_REF')
        }
        await this.uploadFiles(tab, command)
        break
      }
      case 'act': {
        // 整个批次共用一个观测修订版与一份元素引用；页面一旦离开该文档，余下步骤全部作废。
        if (tab.revision !== command.revision) throw fail(`stale browser element revision ${command.revision}`, 'BROWSER_STALE_REF')
        const documentRevision = owner.stateRevision
        steps = []
        for (const [index, step] of command.steps.entries()) {
          if (steps.length >= MAX_ACT_STEPS) break
          if (owner.stateRevision !== documentRevision || !await this.sameDocument(tab)) break
          try {
            cursor = await this.elementStep(owner, tab, step)
          } catch (error) {
            if (!(error instanceof BrowserUseError)) throw error
            steps.push({ kind: step.kind, ok: false, reason: stepFailureReason(error, step.ref) })
            break
          }
          steps.push({ kind: step.kind, ok: true })
          if (step.kind === 'click' && index < command.steps.length - 1 && await this.navigatedAfterClick(tab)) break
        }
        break
      }
      case 'scroll':
        await page.mouse.wheel(0, (command.direction === 'down' ? 1 : -1) *
          Math.min(Math.max(command.pixels, 0), owner.viewport.height))
        cursor = { x: owner.viewport.width / 2, y: owner.viewport.height / 2, kind: 'scroll', at: Date.now() }
        break
      case 'viewport':
        await this.applyViewport(owner, command.width, command.height)
        await this.settleViewport(page)
        break
      case 'snapshot':
      case 'screenshot': break
      case 'close': throw fail('close is handled outside page operations', 'BROWSER_FAILED')
      default: { const unreachable: never = command; throw new Error(`unknown browser command: ${String(unreachable)}`) }
    }
    const capture = await this.observe(owner, tab, cursor)
    return steps === undefined ? capture : { ...capture, steps }
  }

  /** @inheritdoc */
  async execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    // 越界尺寸在排队前拒绝，且不触发队列失败时的会话销毁。
    if (command.kind === 'viewport') this.validateViewport(command.width, command.height)
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
        if (expectedTarget.kind === 'tab' && owner) {
          const tab = this.active(owner)
          if (!await this.sameDocument(tab) || expectedTarget.stateRevision !== owner.stateRevision ||
            expectedTarget.url !== undefined && expectedTarget.url !== tab.page.url()) {
            throw fail('browser target changed while awaiting approval', 'BROWSER_STALE_REF')
          }
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
      if (command.kind === 'navigate') validateBrowserUrl(command.url)
      if (!owner) owner = await this.createOwner(sessionId, signal)
      const tab = this.active(owner)
      if ((command.kind === 'click' || command.kind === 'fill' || command.kind === 'upload' ||
        command.kind === 'act') && tab.capture?.observation.url !== tab.page.url()) {
        throw fail('browser page changed since the element was observed', 'BROWSER_STALE_REF')
      }
      return this.perform(owner, tab, command)
    })
  }

  /** @inheritdoc */
  state(sessionId: SessionId): BrowserSessionState | undefined {
    const owner = this.pages.get(sessionId)
    return owner && this.view(sessionId, owner)
  }

  private async addTab(owner: SessionPage): Promise<SessionTab> {
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
      const documentHandle = await createdPage.evaluateHandle(() => document)
      const tab: SessionTab = { id, page: createdPage, generation, documentHandle, revision: 0, refs: new Map(),
        fileInputs: new Set(),
        summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false },
        history: [], historyIndex: -1 }
      owner.tabs.set(id, tab)
      createdPage.on('dialog', (dialog) => { void dialog.dismiss() })
      this.trackNavigation(owner, tab)
      owner.activeTabId = id
      owner.stateRevision++
      return tab
    } finally {
      owner.pendingPages = undefined
      await Promise.all([...pending].filter(page => page !== createdPage).map(page => page.close().catch(() => {})))
    }
  }

  private async rollbackTab(owner: SessionPage, tab: SessionTab, previousTabId: BrowserTabId): Promise<void> {
    await this.clearRefs(tab)
    await tab.documentHandle.dispose().catch(() => {})
    await tab.page.close()
    await this.activeTab(owner, previousTabId).page.bringToFront()
    owner.tabs.delete(tab.id)
    owner.activeTabId = previousTabId
    owner.stateRevision++
  }

  private activeTab(owner: SessionPage, id: BrowserTabId): SessionTab {
    const tab = owner.tabs.get(id)
    if (!tab) throw fail('browser tab is closed', 'BROWSER_CLOSED')
    return tab
  }

  /** @inheritdoc */
  async control(sessionId: SessionId, command: BrowserHumanCommand, signal: AbortSignal,
    guard?: () => Promise<void>): Promise<BrowserSessionState | undefined> {
    signal.throwIfAborted()
    if (this.operationActive(sessionId)) throw fail('browser is controlled by the agent', 'BROWSER_BUSY')
    if (command.kind === 'set-viewport') this.validateViewport(command.width, command.height)
    return await this.enqueue(sessionId, signal, async () => {
      await guard?.()
      signal.throwIfAborted()
      let owner = this.pages.get(sessionId)
      if (command.kind === 'navigate' || command.kind === 'open-url') {
        try { validateBrowserUrl(command.url) }
        catch (error) {
          if (error instanceof BrowserUseError) throw new InvalidNavigationInputError(error)
          throw error
        }
      }
      if (!owner && command.kind !== 'navigate' && command.kind !== 'open-url' &&
        command.kind !== 'new-tab' && command.kind !== 'ensure-tab') {
        if (command.kind === 'click' || command.kind === 'scroll' || command.kind === 'type') {
          throw fail('browser screenshot is no longer current', 'BROWSER_STALE_REF')
        }
        return undefined
      }
      const created = !owner
      if (!owner) owner = await this.createOwner(sessionId, signal)
      switch (command.kind) {
        case 'ensure-tab': break
        case 'new-tab': {
          if (created) break
          await this.addTab(owner)
          break
        }
        case 'open-url': {
          const previousTabId = owner.activeTabId
          const tab = created ? this.active(owner) : await this.addTab(owner)
          try {
            await tab.page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
            await this.observe(owner, tab, null)
          } catch (error) {
            if (created || signal.aborted) throw error
            // 只有新页及原活动页的恢复均确定完成，才能保留已有会话。
            await this.rollbackTab(owner, tab, previousTabId)
            throw new RolledBackTabError(error)
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
          await tab.documentHandle.dispose().catch(() => {})
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
        case 'click':
        case 'scroll':
        case 'type': {
          const tab = this.active(owner)
          await this.validateHumanTarget(owner, tab, command.target, command.x, command.y)
          const { x, y } = command
          if (command.kind === 'click') await tab.page.mouse.click(x, y)
          else if (command.kind === 'scroll') {
            if (!Number.isSafeInteger(command.pixels) || command.pixels < 1 || command.pixels > 2000) {
              throw fail('browser scroll distance must be 1..2000 pixels', 'BROWSER_FAILED')
            }
            await tab.page.mouse.move(x, y)
            await tab.page.mouse.wheel(0, (command.direction === 'down' ? 1 : -1) * command.pixels)
            await this.settleScroll(tab.page)
          } else {
            if (command.text.length > 2000) throw fail('browser text exceeds 2000 characters', 'BROWSER_FAILED')
            await tab.page.mouse.click(x, y)
            await tab.page.keyboard.insertText(command.text)
          }
          await this.observe(owner, tab, command.kind === 'type'
            ? { x, y, kind: 'fill', at: Date.now() }
            : { x, y, kind: command.kind, at: Date.now() })
          break
        }
        case 'set-viewport': {
          await this.applyViewport(owner, command.width, command.height)
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
          if (command.kind === 'back') {
            if (result && tab.historyIndex > 0) tab.historyIndex--
          } else if (command.kind === 'forward' && result && tab.historyIndex < tab.history.length - 1) {
            tab.historyIndex++
          }
          await this.observe(owner, tab, null)
          break
        }
        default: { const unreachable: never = command; throw new Error(`unknown browser command: ${String(unreachable)}`) }
      }
      owner.lastUsed = Date.now()
      return this.view(sessionId, owner)
    })
  }

  private async validateHumanTarget(owner: SessionPage, tab: SessionTab, target: BrowserHumanTarget,
    x: number, y: number): Promise<void> {
    const observed = tab.capture?.observation
    if (target.browserGeneration !== owner.browserGeneration || target.stateRevision !== owner.stateRevision ||
      target.tabId !== owner.activeTabId || target.generation !== tab.generation ||
      target.revision !== observed?.revision || observed.url !== tab.page.url() ||
      target.viewport.width !== owner.viewport.width || target.viewport.height !== owner.viewport.height ||
      observed.viewport.width !== owner.viewport.width || observed.viewport.height !== owner.viewport.height ||
      tab.capture?.png === null || tab.capture?.png === undefined ||
      !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 ||
      x >= owner.viewport.width || y >= owner.viewport.height) {
      throw fail('browser screenshot is no longer current', 'BROWSER_STALE_REF')
    }
    if (!await this.sameDocument(tab) || target.stateRevision !== owner.stateRevision ||
      observed !== this.currentCapture(tab)?.observation || observed.url !== tab.page.url()) {
      throw fail('browser screenshot is no longer current', 'BROWSER_STALE_REF')
    }
  }

  private currentCapture(tab: SessionTab): BrowserCapture | undefined { return tab.capture }

  /**
   * 把会话所有页面改成给定 CSS 视口；尺寸未变时保留现有观测，变了则撤销全部元素引用。
   * 调用方负责在需要时重新观测，视口本身不产生截图。
   * @param owner - 目标会话页面。
   * @param width - 新的视口宽度，单位为 CSS 像素。
   * @param height - 新的视口高度，单位为 CSS 像素。
   * @returns 所有页面改完尺寸后兑现。
   */
  private async applyViewport(owner: SessionPage, width: number, height: number): Promise<void> {
    this.validateViewport(width, height)
    if (owner.viewport.width === width && owner.viewport.height === height) return
    owner.viewport = { width, height }
    owner.stateRevision++
    for (const tab of owner.tabs.values()) {
      await this.clearRefs(tab)
      await tab.page.setViewportSize(owner.viewport)
    }
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

  private async settleScroll(page: Page): Promise<void> {
    // wheel 调用兑现时页面的滚动事件与绘制可能还未完成；两帧后再采集页面和画面。
    await page.evaluate(() => new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 250)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve() }))
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
        if (owner && !(error instanceof OversizedFrameError || error instanceof RolledBackTabError ||
          error instanceof InvalidNavigationInputError || error instanceof BrowserUseError &&
          ['BROWSER_STALE_REF', 'BROWSER_CLOSED', 'BROWSER_UNAVAILABLE', 'BROWSER_INVALID_URL'].includes(error.code))) {
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
    if (!state) {
      if (!frame && this.operationActive(sessionId)) send(res, 200, { operationActive: true })
      else send(res, frame ? 404 : 204)
      return
    }
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
