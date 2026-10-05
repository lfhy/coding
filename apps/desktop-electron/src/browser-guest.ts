/** Electron 主进程持有的实时浏览器标签页；模型与人工操作共享同一 WebContentsView。 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow, nativeImage, WebContentsView } from 'electron'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserHumanTarget, BrowserObservation, BrowserSessionState, BrowserTabId, BrowserTabSummary, BrowserUseErrorCode } from '@deepseek-ai/dsh-browser'

const INITIAL_VIEWPORT = { width: 1280, height: 720 }
const MAX_SESSIONS = 8
const MAX_TABS = 8
const FRAME_LIMIT = 2 * 1024 * 1024
const MAX_URL_LENGTH = 4096
const OVERLONG_URL = 'about:blank#browser-url-exceeds-limit'

interface Tab {
  id: BrowserTabId
  generation: string
  view: WebContentsView
  revision: number
  capture?: BrowserCapture
  summary: BrowserTabSummary
  navigation: number
  worldContextId?: number
  syntheticInput: boolean
  domRevision?: number
}

interface Owner {
  generation: string
  tabs: Map<BrowserTabId, Tab>
  active: BrowserTabId
  revision: number
  viewport: { width: number; height: number }
  lease: boolean
  partition: string
}

export interface BrowserGuestPresentation {
  sessionId: string
  tabId: BrowserTabId
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
}

export interface BrowserGuestManager {
  prepare(sessionId: string): Promise<BrowserExpectedTarget>
  execute(sessionId: string, command: BrowserCommand, expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture>
  control(sessionId: string, command: BrowserHumanCommand): Promise<BrowserSessionState | null>
  close(sessionId: string): Promise<null>
  lease(sessionId: string): Promise<null>
  release(sessionId: string): Promise<null>
  present(presentation: BrowserGuestPresentation): void
  dispose(): Promise<void>
}

export interface BrowserGuestOptions {
  hostOrigin?: string
  onState?: (sessionId: string, state: BrowserSessionState | null, capture?: BrowserCapture) => void
}

class GuestError extends Error {
  constructor(message: string, readonly code: BrowserUseErrorCode) {
    super(message)
    this.name = 'BrowserUseError'
  }
}

function fail(message: string, code: BrowserUseErrorCode): never { throw new GuestError(message, code) }

function isHostControlUrl(raw: string, hostOrigin?: string): boolean {
  if (!hostOrigin) return false
  let target: URL
  try { target = new URL(raw) }
  catch { return false }
  const port = new URL(hostOrigin).port
  const hostname = target.hostname.toLowerCase().replace(/\.+$/, '')
  return target.port === port && ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]', '[::ffff:7f00:1]'].includes(hostname)
}

function allowedUrl(raw: string, hostOrigin?: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) fail('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
  let url: URL
  try { url = new URL(raw) }
  catch { return fail('invalid browser URL', 'BROWSER_INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !/^https?:\/\/[^/?#\\\s]+(?:[/?#]|$)/i.test(raw) ||
    /^https?:\/\/[^/?#\\\s]*@/i.test(raw) || isHostControlUrl(url.href, hostOrigin)) {
    fail('browser URL denied', 'BROWSER_DENIED')
  }
  return url.href
}

function validateViewport(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || width > 1920 ||
    height < 240 || height > 1400 || width * height > 1_800_000) {
    fail('browser viewport must be 200..1920 by 240..1400 pixels with area at most 1800000', 'BROWSER_FAILED')
  }
}

function active(owner: Owner): Tab {
  const tab = owner.tabs.get(owner.active)
  if (!tab) fail('active browser tab is closed', 'BROWSER_CLOSED')
  return tab
}

function invalidate(owner: Owner, tab: Tab): void {
  delete tab.capture
  delete tab.worldContextId
  delete tab.domRevision
  tab.navigation++
  owner.revision++
}

// 仅隔离世界保存元素引用；页面脚本无法获取 Map 或伪造跨观测版本的 ref。
const snapshotScript = `(function () {
  const root = globalThis;
  root.__dshGuestMutationRevision ??= 0;
  root.__dshGuestObservers?.forEach(observer => observer.disconnect());
  const observers = new Map();
  const scanRoots = () => {
    const pending = [document]; let scanned = 0; let truncated = false;
    while (pending.length && scanned < 50000) {
      const tree = pending.pop();
      if (!observers.has(tree)) {
        const observer = new MutationObserver(() => { root.__dshGuestMutationRevision++; });
        observer.observe(tree, { subtree: true, childList: true, attributes: true, characterData: true });
        observers.set(tree, observer);
        if (tree !== document) root.__dshGuestMutationRevision++;
      }
      const walker = document.createTreeWalker(tree, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (++scanned > 50000) { truncated = true; break; }
        if (walker.currentNode.shadowRoot) pending.push(walker.currentNode.shadowRoot);
      }
    }
    if (pending.length) truncated = true;
    for (const observer of observers.values()) {
      if (observer.takeRecords().length) root.__dshGuestMutationRevision++;
    }
    if (truncated) root.__dshGuestMutationRevision++;
    return root.__dshGuestMutationRevision;
  };
  root.__dshGuestObservers = observers;
  root.__dshGuestReadMutationRevision = scanRoots;
  scanRoots();
  const refs = new Map(); const entries = [];
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  while (walker.nextNode() && scanned++ < 50000 && entries.length < 150) {
    const el = walker.currentNode;
    if (!el.matches('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]')) continue;
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
      box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) continue;
    const ref = 'e' + (entries.length + 1) + '-' + Date.now() + '-' + Math.random();
    refs.set(ref, el);
    const password = el instanceof HTMLInputElement && el.type === 'password';
    const name = password ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'Password') :
      (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || '');
    entries.push(ref + ' ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' +
      JSON.stringify(String(name).trim().slice(0, 160)) + ' (' + [box.x, box.y, box.width, box.height].map(Math.round).join(',') + ')');
  }
  root.__dshGuestRefs = refs;
  return { text: (document.body?.innerText || '').slice(0, 6000), entries,
    title: document.title.slice(0, 4096), href: location.href.length <= 4096 ? location.href : null,
    domRevision: scanRoots() };
})()`

type Snapshot = { text: string; entries: string[]; title: string; href: string | null; domRevision: number }

/**
 * 创建主进程持有的浏览器；隐藏工作台仅卸载视图，不停止页面或释放会话。
 * 调用方在窗口关闭前调用 dispose；操作错误以 code 区分拒绝、过期与不可用。
 * @param window - 承载可见标签页的 Host 窗口。
 * @param options - Host 控制 origin 与状态事件回调。
 * @returns 同会话串行的浏览器 guest 管理器。
 */
export function createBrowserGuestManager(window: BrowserWindow, options: BrowserGuestOptions = {}): BrowserGuestManager {
  const owners = new Map<string, Owner>()
  const tails = new Map<string, Promise<void>>()
  const leases = new Set<string>()
  let disposed = false
  let presented: { sessionId: string; tabId: BrowserTabId; bounds: BrowserGuestPresentation['bounds'] } | undefined
  let requestedPresentation: BrowserGuestPresentation | undefined

  function state(sessionId: string, owner: Owner): BrowserSessionState {
    const tab = active(owner)
    const capture = tab.capture
    return { operationActive: owner.lease, browserGeneration: owner.generation, stateRevision: owner.revision,
      viewport: { ...owner.viewport }, tabs: [...owner.tabs.values()].map(value => ({ ...value.summary })),
      activeTabId: owner.active, observation: capture?.observation ?? null, hasFrame: capture?.png != null }
  }

  function emit(sessionId: string, owner?: Owner, capture?: BrowserCapture): void {
    if (owner && owners.get(sessionId) !== owner) return
    options.onState?.(sessionId, owner ? state(sessionId, owner) : null, capture)
  }

  function detach(tab: Tab): void {
    if (window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view)
  }

  function destroyTab(tab: Tab): void {
    detach(tab)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  function destroy(sessionId: string): void {
    const owner = owners.get(sessionId)
    if (!owner) return
    owners.delete(sessionId)
    if (presented?.sessionId === sessionId) presented = undefined
    for (const tab of owner.tabs.values()) destroyTab(tab)
    emit(sessionId)
  }

  function createTab(owner: Owner, sessionId: string): Tab {
    if (owner.tabs.size >= MAX_TABS) fail('browser tab limit reached', 'BROWSER_UNAVAILABLE')
    const view = new WebContentsView({ webPreferences: {
      partition: owner.partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, devTools: false,
    } })
    const wc = view.webContents
    if (owner.tabs.size === 0) {
      wc.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
      wc.session.setPermissionCheckHandler(() => false)
      wc.session.on('will-download', (event) => { event.preventDefault() })
      if (options.hostOrigin) {
        // 按实际目标的规范化地址判定；WebSocket 与所有子资源同样不能访问 Host 端口。
        wc.session.webRequest.onBeforeRequest({ urls: ['<all_urls>', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
          callback({ cancel: isHostControlUrl(details.url, options.hostOrigin) })
        })
      }
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const id = randomUUID() as BrowserTabId
    const generation = randomUUID()
    const tab: Tab = { id, generation, view, revision: 0, navigation: 0, syntheticInput: false,
      summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false } }
    owner.tabs.set(id, tab)
    view.setBounds({ x: 0, y: 0, ...owner.viewport })
    const denyNavigation = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }): void => {
      if (event.isMainFrame === false || event.url === 'about:blank') return
      try { allowedUrl(event.url, options.hostOrigin) }
      catch { event.preventDefault() }
    }
    wc.on('will-navigate', denyNavigation)
    wc.on('will-frame-navigate', denyNavigation)
    wc.on('will-redirect', denyNavigation)
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      // Electron 的 did-start-navigation 在 same-document 中也触发；保守撤销截图。
      invalidate(owner, tab)
      emit(sessionId, owner)
    })
    wc.on('did-navigate', () => { refreshSummary(tab); emit(sessionId, owner) })
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      invalidate(owner, tab)
      refreshSummary(tab)
      emit(sessionId, owner)
    })
    wc.on('page-title-updated', (_event, title) => {
      if (owners.get(sessionId) !== owner || !owner.tabs.has(tab.id)) return
      const current = title.slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
      if (current === tab.summary.title) return
      invalidate(owner, tab)
      refreshSummary(tab, current)
      emit(sessionId, owner)
    })
    wc.on('render-process-gone', () => { invalidate(owner, tab); emit(sessionId, owner) })
    wc.on('destroyed', () => { invalidate(owner, tab); if (owners.get(sessionId) === owner) emit(sessionId, owner) })
    wc.on('input-event', (event, input) => {
      if (tab.syntheticInput) return
      if (owner.lease) { event.preventDefault(); return }
      if (['mouseDown', 'mouseUp', 'mouseWheel', 'keyDown', 'keyUp', 'char'].includes(input.type)) {
        invalidate(owner, tab)
        emit(sessionId, owner)
      }
    })
    return tab
  }

  function refreshSummary(tab: Tab, title = tab.summary.title): void {
    const wc = tab.view.webContents
    const url = wc.getURL() || 'about:blank'
    tab.summary = { id: tab.id, generation: tab.generation, url: url.length <= MAX_URL_LENGTH ? url : OVERLONG_URL, title,
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
  }

  function usableUrl(sessionId: string, owner: Owner, tab: Tab): string {
    const url = tab.view.webContents.getURL() || 'about:blank'
    if (url.length <= MAX_URL_LENGTH) return url
    if (tab.summary.url !== OVERLONG_URL || tab.capture) {
      invalidate(owner, tab)
      refreshSummary(tab)
      emit(sessionId, owner)
    }
    fail('browser page URL exceeds 4096 characters', 'BROWSER_FAILED')
  }

  function staleObservation(sessionId: string, owner: Owner, tab: Tab): never {
    invalidate(owner, tab)
    refreshSummary(tab)
    emit(sessionId, owner)
    fail('browser document changed during observation', 'BROWSER_STALE_REF')
  }

  function ensure(sessionId: string): Owner {
    let owner = owners.get(sessionId)
    if (owner) return owner
    if (owners.size >= MAX_SESSIONS) fail('browser session limit reached', 'BROWSER_UNAVAILABLE')
    owner = { generation: randomUUID(), tabs: new Map(), active: '' as BrowserTabId,
      revision: 0, viewport: { ...INITIAL_VIEWPORT }, lease: leases.has(sessionId),
      partition: `dsh-guest-${randomUUID()}` }
    owners.set(sessionId, owner)
    try { owner.active = createTab(owner, sessionId).id }
    catch (error) { destroy(sessionId); throw error }
    emit(sessionId, owner)
    return owner
  }

  function enqueue<T>(sessionId: string, run: () => T | Promise<T>): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const pending = previous.then(async () => {
      if (disposed) fail('browser guest disposed', 'BROWSER_UNAVAILABLE')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve().then(run),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              destroy(sessionId)
              reject(new GuestError('browser action timed out', 'BROWSER_FAILED'))
            }, 15_000)
          }),
        ])
      } finally { if (timer) clearTimeout(timer) }
    })
    const tail = pending.then(() => {}, () => {})
    tails.set(sessionId, tail)
    void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
    return pending
  }

  async function evaluate<T>(tab: Tab, expression: string): Promise<T> {
    const debuggerApi = tab.view.webContents.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    if (tab.worldContextId === undefined) {
      const frame = await debuggerApi.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
      const world = await debuggerApi.sendCommand('Page.createIsolatedWorld', {
        frameId: frame.frameTree.frame.id, worldName: 'dsh-guest', grantUniveralAccess: false,
      }) as { executionContextId: number }
      tab.worldContextId = world.executionContextId
    }
    const result = await debuggerApi.sendCommand('Runtime.evaluate', {
      expression, contextId: tab.worldContextId, returnByValue: true, awaitPromise: true,
    }) as { result?: { value?: T }; exceptionDetails?: unknown }
    if (result.exceptionDetails || result.result?.value === undefined) fail('browser document evaluation failed', 'BROWSER_FAILED')
    return result.result.value
  }

  function assertStable(sessionId: string, owner: Owner, tab: Tab, navigation: number): void {
    if (owners.get(sessionId) !== owner ||
      owner.tabs.get(tab.id) !== tab || tab.navigation !== navigation || tab.view.webContents.isDestroyed()) {
      fail('browser document changed during observation', 'BROWSER_STALE_REF')
    }
  }

  async function observe(sessionId: string, owner: Owner, tab: Tab, cursor: BrowserObservation['cursor']): Promise<BrowserCapture> {
    const navigation = tab.navigation
    usableUrl(sessionId, owner, tab)
    const page = await evaluate<Snapshot>(tab, snapshotScript)
    assertStable(sessionId, owner, tab, navigation)
    const wc = tab.view.webContents
    if (page.href === null || page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    const snapshot = `Page text:\n${page.text}\nElements:\n${page.entries.join('\n')}`.slice(0, 12_000)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    const image = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    }) as { data: string }
    assertStable(sessionId, owner, tab, navigation)
    if (page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    let png: Uint8Array = Buffer.from(image.data, 'base64')
    const domRevision = await evaluate<number>(tab, 'globalThis.__dshGuestReadMutationRevision()')
    assertStable(sessionId, owner, tab, navigation)
    if (page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    if (domRevision !== page.domRevision) {
      invalidate(owner, tab)
      emit(sessionId, owner)
      fail('browser document changed during observation', 'BROWSER_STALE_REF')
    }
    if (png.byteLength > FRAME_LIMIT) {
      png = nativeImage.createFromBuffer(Buffer.from(png)).resize({ ...owner.viewport, quality: 'best' }).toPNG()
    }
    if (png.byteLength > FRAME_LIMIT) {
      // 大画面不被发布；页面仍然可供人工使用，先前的元素引用亦不可复用。
      delete tab.capture
      owner.revision++
      emit(sessionId, owner)
      fail(`browser screenshot exceeds ${FRAME_LIMIT} bytes`, 'BROWSER_FAILED')
    }
    refreshSummary(tab, page.title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
    const observation: BrowserObservation = { tabId: tab.id, generation: tab.generation,
      revision: ++tab.revision, url: page.href, title: tab.summary.title, snapshot,
      viewport: { ...owner.viewport }, cursor }
    const capture: BrowserCapture = { observation, png: new Uint8Array(png) }
    tab.capture = capture
    tab.domRevision = page.domRevision
    owner.revision++
    emit(sessionId, owner, capture)
    return capture
  }

  function assertTarget(owner: Owner | undefined, expected: BrowserExpectedTarget | undefined): void {
    if (!expected) return
    if (expected.kind === 'none') {
      if (owner) fail('browser target changed after approval', 'BROWSER_STALE_REF')
      return
    }
    if (!owner || expected.browserGeneration !== owner.generation || expected.stateRevision !== owner.revision ||
      expected.tabId !== owner.active || expected.generation !== active(owner).generation ||
      expected.url !== undefined && expected.url !== (active(owner).view.webContents.getURL() || 'about:blank')) {
      fail('browser target changed after approval', 'BROWSER_STALE_REF')
    }
  }

  async function refreshMutation(sessionId: string, owner: Owner, tab: Tab): Promise<void> {
    if (tab.domRevision === undefined) return
    const navigation = tab.navigation
    const revision = await evaluate<number>(tab, 'globalThis.__dshGuestReadMutationRevision()')
    assertStable(sessionId, owner, tab, navigation)
    if (revision !== tab.domRevision) {
      invalidate(owner, tab)
      emit(sessionId, owner)
    }
  }

  async function navigate(tab: Tab, url: string): Promise<void> {
    await tab.view.webContents.loadURL(allowedUrl(url, options.hostOrigin))
    refreshSummary(tab)
  }

  function checkHumanTarget(owner: Owner, tab: Tab, target: BrowserHumanTarget, x: number, y: number): void {
    const observation = tab.capture?.observation
    if (target.browserGeneration !== owner.generation || target.stateRevision !== owner.revision ||
      target.tabId !== owner.active || target.generation !== tab.generation ||
      target.revision !== observation?.revision || target.viewport.width !== owner.viewport.width ||
      target.viewport.height !== owner.viewport.height || !tab.capture?.png ||
      !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 ||
      x >= owner.viewport.width || y >= owner.viewport.height || observation.url !== tab.view.webContents.getURL()) {
      fail('browser screenshot is no longer current', 'BROWSER_STALE_REF')
    }
  }

  function sendInput(tab: Tab, event: Parameters<Tab['view']['webContents']['sendInputEvent']>[0]): void {
    tab.syntheticInput = true
    try { tab.view.webContents.sendInputEvent(event) }
    finally { tab.syntheticInput = false }
  }

  function show(presentation: BrowserGuestPresentation): void {
    requestedPresentation = presentation
    if (disposed || window.isDestroyed()) return
    const { sessionId, tabId, bounds, visible } = presentation
    const owner = owners.get(sessionId)
    const tab = owner?.tabs.get(tabId)
    if (!visible || !tab || owner?.active !== tabId || owner.lease) {
      if (presented) {
        const old = owners.get(presented.sessionId)?.tabs.get(presented.tabId)
        if (old) detach(old)
        presented = undefined
      }
      return
    }
    const content = window.getContentBounds()
    if (!Object.values(bounds).every(Number.isFinite)) return
    const x = Math.max(0, Math.min(Math.floor(bounds.x), content.width))
    const y = Math.max(0, Math.min(Math.floor(bounds.y), content.height))
    const width = Math.max(0, Math.min(Math.floor(bounds.width), content.width - x))
    const height = Math.max(0, Math.min(Math.floor(bounds.height), content.height - y))
    if (width < 200 || height < 240) return
    const boundedWidth = Math.min(width, 1920, Math.floor(1_800_000 / Math.min(height, 1400)))
    const boundedHeight = Math.min(height, 1400)
    const effective = { x, y, width: boundedWidth, height: boundedHeight }
    const same = presented?.sessionId === sessionId && presented.tabId === tabId
    if (presented && !same) {
      const old = owners.get(presented.sessionId)?.tabs.get(presented.tabId)
      if (old) detach(old)
    }
    const oldBounds = presented?.bounds
    if (!same || !oldBounds || Object.keys(effective).some(key => effective[key as keyof typeof effective] !==
      oldBounds[key as keyof typeof effective])) tab.view.setBounds(effective)
    if (!same) window.contentView.addChildView(tab.view)
    presented = { sessionId, tabId, bounds: effective }
    if (owner.viewport.width !== boundedWidth || owner.viewport.height !== boundedHeight) {
      owner.viewport = { width: boundedWidth, height: boundedHeight }
      invalidate(owner, tab)
      emit(sessionId, owner)
    }
  }

  return {
    prepare: sessionId => enqueue(sessionId, async () => {
      const owner = owners.get(sessionId)
      if (!owner) return { kind: 'none' }
      const tab = active(owner)
      await refreshMutation(sessionId, owner, tab)
      const url = usableUrl(sessionId, owner, tab)
      if (tab.summary.url !== url) { invalidate(owner, tab); refreshSummary(tab); emit(sessionId, owner) }
      return { kind: 'tab', browserGeneration: owner.generation, stateRevision: owner.revision,
        tabId: tab.id, generation: tab.generation, url }
    }),
    execute: (sessionId, command, expectedTarget) => enqueue(sessionId, async () => {
      const previous = owners.get(sessionId)
      assertTarget(previous, expectedTarget)
      if (previous && expectedTarget?.kind === 'tab') {
        await refreshMutation(sessionId, previous, active(previous))
        assertTarget(previous, expectedTarget)
      }
      if (command.kind === 'close') {
        const tab = previous && active(previous)
        const capture: BrowserCapture = tab?.capture ?? { observation: {
          tabId: tab?.id ?? randomUUID() as BrowserTabId, generation: randomUUID(), revision: 0,
          url: 'about:blank', title: '', snapshot: 'Browser session closed.',
          viewport: previous ? { ...previous.viewport } : { ...INITIAL_VIEWPORT }, cursor: null,
        }, png: null }
        destroy(sessionId)
        return capture
      }
      if (!previous && command.kind !== 'navigate') fail('browser session is closed', 'BROWSER_CLOSED')
      if (command.kind === 'navigate') allowedUrl(command.url, options.hostOrigin)
      const owner = previous ?? ensure(sessionId)
      const tab = active(owner)
      let cursor: BrowserObservation['cursor'] = null
      let mutated = false
      try { switch (command.kind) {
        case 'navigate': await navigate(tab, command.url); break
        case 'click':
        case 'fill': {
          if (command.revision !== tab.revision || !tab.capture) fail('stale browser element revision', 'BROWSER_STALE_REF')
          await refreshMutation(sessionId, owner, tab)
          const latest = tab.capture as BrowserCapture | undefined
          if (latest?.observation.revision !== command.revision) fail('stale browser element revision', 'BROWSER_STALE_REF')
          const documentEpoch = tab.navigation
          const escaped = JSON.stringify(command.ref)
          const box = await evaluate<{ x: number; y: number; width: number; height: number } | null>(tab,
            `(() => { const el = globalThis.__dshGuestRefs?.get(${escaped}); if (!el || !el.isConnected) return null;
              const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`)
          if (!box || !box.width || !box.height || box.x + box.width <= 0 || box.y + box.height <= 0 ||
            box.x >= owner.viewport.width || box.y >= owner.viewport.height) fail('browser element no longer visible', 'BROWSER_STALE_REF')
          assertStable(sessionId, owner, tab, documentEpoch)
          await refreshMutation(sessionId, owner, tab)
          const current = tab.capture as BrowserCapture | undefined
          if (current?.observation.revision !== command.revision) {
            fail('browser element changed before input', 'BROWSER_STALE_REF')
          }
          const x = Math.round(Math.max(0, box.x + box.width / 2))
          const y = Math.round(Math.max(0, box.y + box.height / 2))
          cursor = { x, y, kind: command.kind, at: Date.now() }
          mutated = true
          sendInput(tab, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          sendInput(tab, { type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          if (command.kind === 'fill') {
            assertStable(sessionId, owner, tab, documentEpoch)
            const focused = await evaluate<boolean>(tab, `(() => { const el = globalThis.__dshGuestRefs?.get(${escaped});
              if (!el || !el.isConnected || (!('value' in el) && !el.isContentEditable)) return false;
              el.focus(); if (el.isContentEditable) el.textContent = '';
              else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
                if (setter) setter.call(el, ''); else el.value = ''; }
              el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)
            assertStable(sessionId, owner, tab, documentEpoch)
            const current = tab.capture as BrowserCapture | undefined
            if (!focused || current?.observation.revision !== command.revision) {
              fail('browser element changed before fill', 'BROWSER_STALE_REF')
            }
            await tab.view.webContents.insertText(command.text)
          }
          break
        }
        case 'scroll': {
          const pixels = Math.min(Math.max(command.pixels, 0), owner.viewport.height)
          mutated = true
          sendInput(tab, { type: 'mouseWheel', x: owner.viewport.width / 2,
            y: owner.viewport.height / 2, deltaX: 0, deltaY: (command.direction === 'down' ? -1 : 1) * pixels })
          cursor = { x: owner.viewport.width / 2, y: owner.viewport.height / 2, kind: 'scroll', at: Date.now() }
          break
        }
        case 'snapshot': case 'screenshot': break
        default: { const never: never = command; throw new Error(`unknown browser command: ${String(never)}`) }
      }
      return await observe(sessionId, owner, tab, cursor)
      } catch (error) {
        if (mutated && owners.get(sessionId) === owner && owner.tabs.has(tab.id)) {
          invalidate(owner, tab)
          emit(sessionId, owner)
        }
        throw error
      }
    }),
    control: (sessionId, command) => {
      if (leases.has(sessionId)) return Promise.reject(new GuestError('browser operation already active', 'BROWSER_BUSY'))
      return enqueue(sessionId, async () => {
        let owner = owners.get(sessionId)
        if (command.kind === 'navigate') allowedUrl(command.url, options.hostOrigin)
        if (!owner && ['ensure-tab', 'new-tab', 'navigate'].includes(command.kind)) {
          owner = ensure(sessionId)
          if (command.kind === 'new-tab') return state(sessionId, owner)
        }
        if (!owner) fail('browser session is closed', 'BROWSER_CLOSED')
        const tab = active(owner)
        switch (command.kind) {
          case 'ensure-tab': break
          case 'new-tab': owner.active = createTab(owner, sessionId).id; owner.revision++; break
          case 'select-tab':
            if (!owner.tabs.has(command.tabId)) fail('browser tab is closed', 'BROWSER_CLOSED')
            owner.active = command.tabId; owner.revision++; break
          case 'close-tab': {
            const closing = owner.tabs.get(command.tabId)
            if (!closing) fail('browser tab is closed', 'BROWSER_CLOSED')
            if (owner.tabs.size === 1) { destroy(sessionId); return null }
            owner.tabs.delete(command.tabId)
            if (owner.active === command.tabId) owner.active = owner.tabs.keys().next().value as BrowserTabId
            owner.revision++
            destroyTab(closing)
            break
          }
          case 'navigate': await navigate(tab, command.url); await observe(sessionId, owner, tab, null); break
          case 'back':
          case 'forward':
          case 'reload': {
            const history = tab.view.webContents.navigationHistory
            if (command.kind === 'back' && history.canGoBack()) history.goBack()
            else if (command.kind === 'forward' && history.canGoForward()) history.goForward()
            else if (command.kind === 'reload') tab.view.webContents.reload()
            // 导航完成由页面事件撤销旧画面；不把尚未完成的加载当作成功捕获。
            break
          }
          case 'set-viewport': {
            validateViewport(command.width, command.height)
            if (owner.viewport.width !== command.width || owner.viewport.height !== command.height) {
              owner.viewport = { width: command.width, height: command.height }
              owner.revision++
              for (const item of owner.tabs.values()) {
                delete item.capture
                if (presented?.sessionId !== sessionId || presented.tabId !== item.id) {
                  item.view.setBounds({ x: 0, y: 0, ...owner.viewport })
                }
              }
            }
            break
          }
          case 'click':
          case 'scroll':
          case 'type': {
            await refreshMutation(sessionId, owner, tab)
            checkHumanTarget(owner, tab, command.target, command.x, command.y)
            const wc = tab.view.webContents
            if (command.kind === 'scroll') {
              if (!Number.isSafeInteger(command.pixels) || command.pixels < 1 || command.pixels > 2000) {
                fail('browser scroll distance must be 1..2000 pixels', 'BROWSER_FAILED')
              }
              sendInput(tab, { type: 'mouseWheel', x: command.x, y: command.y, deltaX: 0,
                deltaY: (command.direction === 'down' ? -1 : 1) * command.pixels })
            } else {
              sendInput(tab, { type: 'mouseDown', x: command.x, y: command.y, button: 'left', clickCount: 1 })
              sendInput(tab, { type: 'mouseUp', x: command.x, y: command.y, button: 'left', clickCount: 1 })
              if (command.kind === 'type') {
                if (command.text.length > 2000) fail('browser text exceeds 2000 characters', 'BROWSER_FAILED')
                await wc.insertText(command.text)
              }
            }
            await observe(sessionId, owner, tab, { x: command.x, y: command.y,
              kind: command.kind === 'type' ? 'fill' : command.kind, at: Date.now() })
            break
          }
          default: { const never: never = command; throw new Error(`unknown browser command: ${String(never)}`) }
        }
        if (presented?.sessionId === sessionId && presented.tabId !== owner.active) {
          const old = owner.tabs.get(presented.tabId)
          if (old) detach(old)
          presented = undefined
        }
        emit(sessionId, owner)
        return state(sessionId, owner)
      })
    },
    close: sessionId => enqueue(sessionId, () => { destroy(sessionId); return null }),
    lease: async (sessionId) => {
      if (disposed) fail('browser guest disposed', 'BROWSER_UNAVAILABLE')
      if (leases.has(sessionId)) fail('browser operation already active', 'BROWSER_BUSY')
      leases.add(sessionId)
      try { await (tails.get(sessionId) ?? Promise.resolve()) }
      catch (error) { leases.delete(sessionId); throw error }
      const owner = owners.get(sessionId)
      if (owner) {
        owner.lease = true
        if (presented?.sessionId === sessionId) {
          const tab = owner.tabs.get(presented.tabId)
          if (tab) detach(tab)
          presented = undefined
        }
        emit(sessionId, owner)
      }
      return null
    },
    release: (sessionId) => {
      leases.delete(sessionId)
      const owner = owners.get(sessionId)
      if (owner) { owner.lease = false; emit(sessionId, owner) }
      if (requestedPresentation) show(requestedPresentation)
      return Promise.resolve(null)
    },
    present: show,
    dispose: async () => {
      disposed = true
      for (const sessionId of [...owners.keys()]) destroy(sessionId)
      await Promise.all([...tails.values()])
    },
  }
}
