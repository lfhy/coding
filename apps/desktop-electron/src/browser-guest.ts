/** Electron 主进程持有的实时浏览器标签页；模型与人工操作共享同一 WebContentsView。 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserHumanTarget, BrowserObservation, BrowserSessionState, BrowserTabId, BrowserTabSummary, BrowserUseErrorCode } from 'coding-browser'
import { fitBrowserPng } from './browser-image.ts'
import { createBrowserCursorOverlay } from './browser-cursor-overlay.ts'
import { createBrowserInputOverlay } from './browser-input-overlay.ts'

const INITIAL_VIEWPORT = { width: 1280, height: 720 }
const MAX_SESSIONS = 8
const MAX_TABS = 8
const FRAME_LIMIT = 2 * 1024 * 1024
const MAX_URL_LENGTH = 4096
const OVERLONG_URL = 'about:blank#browser-url-exceeds-limit'
const NAVIGATION_TIMEOUT_MS = 10_000
const NAVIGATION_STOP_TIMEOUT_MS = 3_000
const SCREENSHOT_TIMEOUT_MS = 5_000

/** 引用在输入前被发现不可用时的原因：模型按原因决定重拍快照、滚动还是换目标。 */
const STALE_TARGET_REASONS: Record<string, string> = {
  element_left_document: 'left the document',
  element_form_changed: 'changed its form',
  ancestors_changed: 'changed its ancestor chain',
  element_changed: 'changed since the snapshot',
  element_not_editable: 'is not editable',
  element_hidden: 'is hidden',
  element_disabled: 'is disabled or inert',
  element_offscreen: 'is outside the visible viewport',
  element_covered: 'is covered by another element',
}

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
  everPresented: boolean
}

interface Owner {
  generation: string
  tabs: Map<BrowserTabId, Tab>
  active: BrowserTabId
  revision: number
  targetRevision: number
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
  onState?: (sessionId: string, state: BrowserSessionState | null, capture?: BrowserCapture) => void
}

class GuestError extends Error {
  constructor(message: string, readonly code: BrowserUseErrorCode) {
    super(message)
    this.name = 'BrowserUseError'
  }
}

function fail(message: string, code: BrowserUseErrorCode): never { throw new GuestError(message, code) }

function allowedUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) fail('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
  let url: URL
  try { url = new URL(raw) }
  catch { return fail('invalid browser URL', 'BROWSER_INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !/^https?:\/\/[^/?#\\\s]+(?:[/?#]|$)/i.test(raw) ||
    /^https?:\/\/[^/?#\\\s]*@/i.test(raw)) {
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
  owner.targetRevision++
}

// 仅隔离世界保存元素引用；页面脚本无法获取 Map 或伪造跨观测版本的 ref。
// 引用是否过期只取决于「这次点击的含义」：节点身份、事件处理器、导航与表单语义、
// 以及点击点的命中结果。class/style/data-* 等展示性属性和子树文本的更新不再作废
// 引用：实时页面一直在重渲染，按整棵属性快照比较会让引用几乎永远过期；这些变化
// 由点击时刻的命中测试兜底。观测只列出此刻真的可点击的元素，被遮挡或禁用的目标
// 不再进入 Elements，模型不必靠反复快照去猜为什么点不动。
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
    root.__dshGuestObserverIncomplete = truncated;
    return root.__dshGuestMutationRevision;
  };
  root.__dshGuestObservers = observers;
  root.__dshGuestReadMutationRevision = scanRoots;
  scanRoots();
  root.__dshGuestRefs?.forEach(ref => ref.observer?.disconnect());
  const refs = new Map(); const entries = [];
  const ACTIONABLE = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]';
  const BLOCKING = '[inert], [aria-disabled="true"]';
  // 语义属性：改变它们可能改变点击的后果（提交目标、下载、导航、禁用状态）。
  const SEMANTIC = ['role', 'id', 'type', 'name', 'value', 'href', 'ping', 'target', 'rel', 'download', 'hreflang',
    'disabled', 'readonly', 'required', 'tabindex', 'contenteditable', 'inert', 'placeholder', 'title', 'for',
    'accept', 'multiple', 'checked', 'selected', 'form', 'formaction', 'formmethod', 'formtarget', 'formenctype',
    'formnovalidate', 'autocomplete', 'inputmode', 'spellcheck', 'dir', 'lang'];
  const sortAttributes = attributes => attributes.sort((left, right) => left[0].localeCompare(right[0]));
  const semantic = el => sortAttributes(Array.from(el.attributes, attr => [attr.name, attr.value])
    .filter(([name]) => name.startsWith('on') || name.startsWith('aria-') || SEMANTIC.includes(name)));
  // 祖先只比事件处理器与 inert：包装层的 class/style 会随动画和主题抖动。
  const handlers = node => sortAttributes(Array.from(node.attributes, attr => [attr.name, attr.value])
    .filter(([name]) => name.startsWith('on') || name === 'inert'));
  const path = el => {
    const chain = [];
    for (let node = el; node && node !== document; node = node.parentNode || node.host) {
      if (node.nodeType === Node.ELEMENT_NODE) chain.push({ node, parent: node.parentNode, attributes: handlers(node) });
    }
    return chain;
  };
  // 子树里新增的事件处理器会改变冒泡行为，其余子树更新与点击含义无关。
  const subtreeHandlers = el => {
    const found = []; let nodes = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (++nodes > 200) return null;
      const node = walker.currentNode;
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('on')) found.push(node.tagName + ':' + attr.name + '=' + attr.value);
      }
    }
    return found.sort();
  };
  const identity = el => ({ tag: el.tagName,
    attributes: semantic(el),
    role: el.getAttribute('role'), id: el.getAttribute('id'),
    // 名称只取属性来源：按钮里的计数、徽标或加载文案会随轮询变化，不代表目标换了含义。
    name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '',
    value: 'value' in el && typeof el.value === 'string' ? el.value : undefined,
    href: el.href || el.getAttribute('href'), form: el.form?.id,
    action: el.hasAttribute('formaction') ? el.formAction : el.form?.action,
    method: el.hasAttribute('formmethod') ? el.formMethod : el.form?.method,
    target: el.hasAttribute('formtarget') ? el.formTarget : el.form?.target || el.getAttribute('target'),
    enctype: el.hasAttribute('formenctype') ? el.formEnctype : el.form?.enctype,
    noValidate: !!(el.form?.noValidate || el.formNoValidate),
    type: el.getAttribute('type'),
    disabled: !!el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    readOnly: !!el.readOnly,
    handlers: subtreeHandlers(el),
    // 关联表单可能不在祖先链上（form 属性指向别处），它自己的处理器同样会截获提交。
    formHandlers: el.form ? handlers(el.form) : undefined });
  const clean = value => String(value).replace(/[\\u0000-\\u001f]/g, ' ').slice(0, 60);
  const describe = node => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return '';
    return clean(node.getAttribute('role') || node.tagName.toLowerCase()) + ' ' +
      JSON.stringify(clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.tagName.toLowerCase()));
  };
  root.__dshGuestIdentity = identity;
  root.__dshGuestPath = path;
  root.__dshGuestDescribe = describe;
  const centre = (start, end, limit) => Math.max(0, Math.min(limit - 1, Math.floor((start + end) / 2)));
  // 命中测试是引用仍然有效的最终依据；被遮挡时回报遮挡者，便于模型换目标或先关掉浮层。
  const hit = el => {
    const box = el.getBoundingClientRect();
    const left = Math.max(0, box.left), top = Math.max(0, box.top);
    const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
    if (left >= right || top >= bottom) return { reason: 'element_offscreen' };
    const x = centre(left, right, innerWidth), y = centre(top, bottom, innerHeight);
    let scope = el.getRootNode();
    const covered = () => ({ reason: 'element_covered',
      blocker: describe(scope.elementFromPoint ? scope.elementFromPoint(x, y) : null) });
    const found = scope.elementFromPoint ? scope.elementFromPoint(x, y) : null;
    if (!found || (found !== el && !el.contains(found))) return covered();
    while (scope !== document) {
      const host = scope.host; if (!host) return { reason: 'element_covered' };
      scope = host.getRootNode();
      if (!scope.elementFromPoint || scope.elementFromPoint(x, y) !== host) return covered();
    }
    return { ok: true, x: x, y: y };
  };
  root.__dshGuestHit = hit;
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  while (walker.nextNode() && scanned++ < 50000 && entries.length < 150) {
    const el = walker.currentNode;
    if (!el.matches(ACTIONABLE)) continue;
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
      style.pointerEvents === 'none' || box.right <= 0 || box.bottom <= 0 ||
      box.left >= innerWidth || box.top >= innerHeight) continue;
    if (el.closest(BLOCKING)) continue;
    if (!hit(el).ok) continue;
    const ref = 'e' + (entries.length + 1) + '-' + Date.now() + '-' + Math.random();
    const entry = { el, form: el.form ?? null, identity: identity(el), path: path(el) };
    const password = el instanceof HTMLInputElement && el.type === 'password';
    const name = password ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'Password') :
      (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || '');
    refs.set(ref, entry);
    entries.push(ref + ' ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' +
      JSON.stringify(String(name).trim().slice(0, 160)) + ' (' + [box.x, box.y, box.width, box.height].map(Math.round).join(',') + ')');
  }
  root.__dshGuestRefs = refs;
  return { text: (document.body?.innerText || '').slice(0, 6000), entries,
    title: document.title.slice(0, 4096), href: location.href.length <= 4096 ? location.href : null,
    domRevision: scanRoots() };
})()`

type Snapshot = { text: string; entries: string[]; title: string; href: string | null; domRevision: number }

/** 引用复核结果：命中点，或无法点击的具体原因与遮挡者。 */
type TargetOutcome = { ok: true; x: number; y: number } | { ok?: false; reason?: string; blocker?: string }

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
  let overlay: ReturnType<typeof createBrowserInputOverlay> | undefined
  let cursorOverlay: ReturnType<typeof createBrowserCursorOverlay> | undefined
  // 指针位置归标签页所有；释放输入租约不清空它。
  const pointers = new Map<BrowserTabId, { x: number; y: number }>()

  function clearOverlay(): void { overlay?.close(); overlay = undefined }
  function clearCursorOverlay(): void { cursorOverlay?.dispose(); cursorOverlay = undefined }

  function showCursor(point = presented && pointers.get(presented.tabId)): void {
    if (!presented || !point || window.isDestroyed()) return
    if (cursorOverlay && !cursorOverlay.alive) cursorOverlay = undefined
    try {
      cursorOverlay ??= createBrowserCursorOverlay(window)
      cursorOverlay.show({ bounds: presented.bounds, point })
    } catch { clearCursorOverlay() }
  }

  function protectPresentation(): void {
    if (!presented || !owners.get(presented.sessionId)?.lease) { clearOverlay(); return }
    try {
      overlay ??= createBrowserInputOverlay(window, () => {
        if (presented) {
          const tab = owners.get(presented.sessionId)?.tabs.get(presented.tabId)
          if (tab) detach(tab)
          presented = undefined
        }
        clearOverlay()
        clearCursorOverlay()
      })
      overlay.attach(presented.bounds)
    } catch (error) {
      const tab = owners.get(presented.sessionId)?.tabs.get(presented.tabId)
      if (tab) detach(tab)
      presented = undefined
      clearOverlay()
      clearCursorOverlay()
      throw error
    }
  }

  async function moveCursor(sessionId: string, tab: Tab, x: number, y: number): Promise<void> {
    if (presented?.sessionId === sessionId && presented.tabId === tab.id) {
      // 已知位置连续移动；首次无起点时只在目标出现，不凭空从视口中心飞来。
      showCursor(pointers.get(tab.id) ?? { x, y })
      await cursorOverlay?.move({ x, y })
    }
    pointers.set(tab.id, { x, y })
  }

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
    pointers.delete(tab.id)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  function destroy(sessionId: string): void {
    const owner = owners.get(sessionId)
    if (!owner) return
    owners.delete(sessionId)
    if (presented?.sessionId === sessionId) { clearOverlay(); clearCursorOverlay(); presented = undefined }
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
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const id = randomUUID() as BrowserTabId
    const generation = randomUUID()
    const tab: Tab = { id, generation, view, revision: 0, navigation: 0, syntheticInput: false, everPresented: false,
      summary: { id, generation, url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: wc.isLoading() } }
    owner.tabs.set(id, tab)
    const isCurrent = (): boolean => owners.get(sessionId) === owner && owner.tabs.get(id) === tab
    view.setBounds({ x: 0, y: 0, ...owner.viewport })
    const denyNavigation = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }): void => {
      if (event.isMainFrame === false || event.url === 'about:blank') return
      try { allowedUrl(event.url) }
      catch { event.preventDefault() }
    }
    wc.on('will-navigate', denyNavigation)
    wc.on('will-frame-navigate', denyNavigation)
    wc.on('will-redirect', denyNavigation)
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || !isCurrent()) return
      // Electron 的 did-start-navigation 在 same-document 中也触发；保守撤销截图。
      invalidate(owner, tab)
      emit(sessionId, owner)
    })
    wc.on('did-navigate', () => { if (isCurrent()) { refreshSummary(tab); emit(sessionId, owner) } })
    const updateLoading = (): void => {
      if (!isCurrent()) return
      const previous = tab.summary.loading
      refreshSummary(tab)
      if (tab.summary.loading !== previous) { owner.revision++; emit(sessionId, owner) }
    }
    wc.on('did-start-loading', updateLoading)
    wc.on('did-stop-loading', updateLoading)
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame || !isCurrent()) return
      invalidate(owner, tab)
      refreshSummary(tab)
      emit(sessionId, owner)
    })
    wc.on('page-title-updated', (_event, title) => {
      if (!isCurrent()) return
      const current = title.slice(0, 4096).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
      if (current === tab.summary.title) return
      owner.revision++
      refreshSummary(tab, current)
      emit(sessionId, owner)
    })
    wc.on('render-process-gone', () => { if (isCurrent()) { invalidate(owner, tab); emit(sessionId, owner) } })
    wc.on('destroyed', () => { if (isCurrent()) { invalidate(owner, tab); emit(sessionId, owner) } })
    // 租约期间即使 guest 仍有焦点也拒绝人工键盘输入，不依赖 syntheticInput。
    wc.on('before-input-event', (event) => { if (owner.lease) event.preventDefault() })
    wc.on('input-event', (_event, input) => {
      if (!isCurrent() || tab.syntheticInput || owner.lease) return
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
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading() }
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
      revision: 0, targetRevision: 0, viewport: { ...INITIAL_VIEWPORT }, lease: leases.has(sessionId),
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

  /**
   * 把引用复核结果变成模型可读的失败原因：只说「元素变了」会让模型反复重拍快照，
   * 遮挡、禁用与移出视口这类原因则指向重拍之外的动作。
   * @param outcome 隔离世界给出的复核结果或原因。
   * @param ref 模型使用的引用，仅用于定位。
   * @param owner 会话页面，提供当前视口上限。
   * @returns 可点击坐标。
   */
  function requireTarget(outcome: TargetOutcome, ref: string, owner: Owner): { x: number; y: number } {
    if (outcome.ok === true) {
      if (outcome.x >= owner.viewport.width || outcome.y >= owner.viewport.height) {
        fail(`browser element ${ref} is outside the visible viewport`, 'BROWSER_STALE_REF')
      }
      return { x: outcome.x, y: outcome.y }
    }
    const reason = STALE_TARGET_REASONS[outcome.reason ?? ''] ?? 'is no longer usable'
    const blocker = outcome.blocker === undefined || outcome.blocker === '' ? '' : ` (${outcome.blocker})`
    return fail(`browser element ${ref} ${reason}${blocker}`, 'BROWSER_STALE_REF')
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
    let png: Uint8Array | null = null
    if (tab.everPresented) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let image: { data: string }
      try {
        image = await Promise.race([
          wc.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false, fromSurface: true,
          }) as Promise<{ data: string }>,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              destroy(sessionId)
              reject(new GuestError('browser screenshot timed out; browser session closed', 'BROWSER_FAILED'))
            }, SCREENSHOT_TIMEOUT_MS)
          }),
        ])
      } finally { if (timer) clearTimeout(timer) }
      try { png = await fitBrowserPng(image.data, FRAME_LIMIT) }
      catch (error) {
        assertStable(sessionId, owner, tab, navigation)
        invalidate(owner, tab)
        emit(sessionId, owner)
        fail(error instanceof Error ? `browser screenshot processing failed: ${error.message}` :
          'browser screenshot processing failed', 'BROWSER_FAILED')
      }
    }
    assertStable(sessionId, owner, tab, navigation)
    if (page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    // 页面其他区域可以在截图期间更新；引用在输入时逐一复核节点身份和命中位置。
    // 人工坐标输入仍以观测开始时的修订版复核，截图期间的任何变更会在输入前拒绝。
    refreshSummary(tab, page.title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
    const observation: BrowserObservation = { tabId: tab.id, generation: tab.generation,
      revision: ++tab.revision, url: page.href, title: tab.summary.title, snapshot,
      viewport: { ...owner.viewport }, cursor }
    const capture: BrowserCapture = { observation, png: png === null ? null : new Uint8Array(png) }
    tab.capture = capture
    tab.domRevision = page.domRevision
    owner.revision++
    emit(sessionId, owner, capture.png === null ? undefined : capture)
    return capture
  }

  function assertTarget(owner: Owner | undefined, expected: BrowserExpectedTarget | undefined): void {
    if (!expected) return
    if (expected.kind === 'none') {
      if (owner) fail('browser target changed after approval', 'BROWSER_STALE_REF')
      return
    }
    if (!owner || expected.browserGeneration !== owner.generation || expected.stateRevision !== owner.targetRevision ||
      expected.tabId !== owner.active || expected.generation !== active(owner).generation ||
      expected.url !== undefined && expected.url !== (active(owner).view.webContents.getURL() || 'about:blank')) {
      fail('browser target changed after approval', 'BROWSER_STALE_REF')
    }
  }

  async function refreshMutation(sessionId: string, owner: Owner, tab: Tab): Promise<void> {
    if (tab.domRevision === undefined) return
    const navigation = tab.navigation
    const current = await evaluate<{ revision: number; incomplete: boolean }>(tab,
      '({ revision: globalThis.__dshGuestReadMutationRevision(), incomplete: !!globalThis.__dshGuestObserverIncomplete })')
    assertStable(sessionId, owner, tab, navigation)
    if (current.incomplete || current.revision !== tab.domRevision) {
      invalidate(owner, tab)
      emit(sessionId, owner)
    }
  }

  async function navigate(sessionId: string, owner: Owner, tab: Tab, url: string, human = false): Promise<void> {
    const wc = tab.view.webContents
    const destination = allowedUrl(url)
    let started = false
    let committedUrl: string | undefined
    let committedNavigation: number | undefined
    let commitTask: ReturnType<typeof setImmediate> | undefined
    const destinations = new Set([destination])
    let resolveCommit!: (value: { timedOut: false; error?: unknown }) => void
    const committed = new Promise<{ timedOut: false; error?: unknown }>((resolve) => { resolveCommit = resolve })
    const onStart = (details: { isMainFrame: boolean; url: string }): void => {
      if (details.isMainFrame && owners.get(sessionId) === owner && owner.tabs.get(tab.id) === tab) {
        if (commitTask) clearImmediate(commitTask)
        commitTask = undefined
        committedUrl = undefined
        started = details.url === destination
      }
    }
    const onRedirect = (details: { isMainFrame: boolean; url: string }): void => {
      if (started && details.isMainFrame && owners.get(sessionId) === owner && owner.tabs.get(tab.id) === tab) {
        destinations.add(details.url)
      }
    }
    const onCommit = (_event: unknown, url: string): void => {
      if (!started || !destinations.has(url) || url !== wc.getURL() ||
        owners.get(sessionId) !== owner || owner.tabs.get(tab.id) !== tab || wc.isDestroyed()) return
      try { allowedUrl(url) }
      catch (error) { resolveCommit({ timedOut: false, error }); return }
      committedUrl = url
      committedNavigation = tab.navigation
      // 同一事件循环内本次 loadURL 的拒绝优先于提交回执；旧加载的异步拒绝不影响本次导航。
      if (human) commitTask ??= setImmediate(() => { resolveCommit({ timedOut: false }) })
    }
    const onDomReady = (): void => {
      if (human || committedUrl === undefined || wc.getURL() !== committedUrl ||
        owners.get(sessionId) !== owner || owner.tabs.get(tab.id) !== tab || wc.isDestroyed()) return
      // DOM 已就绪即可观测；让同一事件循环中的 loadURL 拒绝先于成功回执。
      commitTask ??= setImmediate(() => { resolveCommit({ timedOut: false }) })
    }
    wc.on('did-start-navigation', onStart)
    wc.on('did-redirect-navigation', onRedirect)
    wc.on('did-navigate', onCommit)
    if (!human) wc.on('dom-ready', onDomReady)
    const completed = Promise.resolve().then(() => wc.loadURL(destination))
      .then(() => ({ timedOut: false as const }), (error: unknown) => ({ timedOut: false as const, error }))
    const readiness = Promise.race([completed, committed])
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => { resolve({ timedOut: true }) }, NAVIGATION_TIMEOUT_MS)
    })
    const result = await Promise.race([readiness, deadline])
    if (timer) clearTimeout(timer)
    if (commitTask) clearImmediate(commitTask)
    wc.removeListener('did-start-navigation', onStart)
    wc.removeListener('did-redirect-navigation', onRedirect)
    wc.removeListener('did-navigate', onCommit)
    if (!human) wc.removeListener('dom-ready', onDomReady)
    if (!result.timedOut) {
      // 保留 loadURL 的原始失败诊断，不能把被拒绝的导航当作已完成页面。
      if ('error' in result) throw result.error
      if (owners.get(sessionId) !== owner || owner.tabs.get(tab.id) !== tab || wc.isDestroyed()) {
        fail('browser navigation target changed', 'BROWSER_STALE_REF')
      }
      if (!human && committedNavigation !== undefined && committedNavigation !== tab.navigation) {
        fail('browser document changed during navigation', 'BROWSER_STALE_REF')
      }
      refreshSummary(tab)
      return
    }

    // 停止之后仍须等待原 loadURL 收敛，并确认主 frame 与 CDP 均可响应。
    // 超时的旧调用不再有任何继续观察或写回状态的机会。
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let quiescent = false
    const recovery = { expired: false }
    const stillRecovering = (): boolean => !recovery.expired
    try {
      wc.stop()
      quiescent = await Promise.race([
        (async () => {
          await completed
          if (recovery.expired || wc.isDestroyed() || wc.isLoadingMainFrame()) return false
          const debuggerApi = wc.debugger
          if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
          await debuggerApi.sendCommand('Page.getFrameTree')
          return stillRecovering() && !wc.isDestroyed() && !wc.isLoadingMainFrame()
        })().catch(() => false),
        new Promise<false>((resolve) => {
          stopTimer = setTimeout(() => { recovery.expired = true; resolve(false) }, NAVIGATION_STOP_TIMEOUT_MS)
        }),
      ])
    } catch { /* 无法证明导航停稳时只销毁当前 Session。 */ }
    finally { if (stopTimer) clearTimeout(stopTimer) }
    if (!quiescent) {
      destroy(sessionId)
      fail('browser navigation timed out and could not be stopped safely; browser session closed', 'BROWSER_FAILED')
    }
    invalidate(owner, tab)
    refreshSummary(tab)
    emit(sessionId, owner)
    // 主 frame 已提交且可观测时，模型导航仍可返回该页面；保留严格文档校验。
    if (!human && committedUrl !== undefined && wc.getURL() === committedUrl &&
      committedNavigation !== undefined && committedNavigation + 1 === tab.navigation) return
    fail('browser navigation timed out; loading stopped, take a new snapshot of the current page', 'BROWSER_FAILED')
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
    if (!presentation.visible && requestedPresentation &&
      (requestedPresentation.sessionId !== presentation.sessionId || requestedPresentation.tabId !== presentation.tabId)) return
    requestedPresentation = presentation
    if (disposed || window.isDestroyed()) return
    const { sessionId, tabId, bounds, visible } = presentation
    const owner = owners.get(sessionId)
    const tab = owner?.tabs.get(tabId)
    if (!visible || !tab || owner?.active !== tabId) {
      if (presented) {
        clearOverlay()
        clearCursorOverlay()
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
      clearOverlay()
      clearCursorOverlay()
      const old = owners.get(presented.sessionId)?.tabs.get(presented.tabId)
      if (old) detach(old)
    }
    const oldBounds = presented?.bounds
    if (!same || !oldBounds || Object.keys(effective).some(key => effective[key as keyof typeof effective] !==
      oldBounds[key as keyof typeof effective])) tab.view.setBounds(effective)
    if (!same) {
      window.contentView.addChildView(tab.view)
      tab.everPresented = true
    }
    presented = { sessionId, tabId, bounds: effective }
    protectPresentation()
    if (!owner.lease) showCursor()
    if (owner.viewport.width !== boundedWidth || owner.viewport.height !== boundedHeight) {
      owner.viewport = { width: boundedWidth, height: boundedHeight }
      invalidate(owner, tab)
      emit(sessionId, owner)
    }
  }

  return {
    prepare: sessionId => enqueue(sessionId, () => {
      const owner = owners.get(sessionId)
      if (!owner) return { kind: 'none' }
      const tab = active(owner)
      const url = usableUrl(sessionId, owner, tab)
      if (tab.summary.url !== url) { invalidate(owner, tab); refreshSummary(tab); emit(sessionId, owner) }
      return { kind: 'tab', browserGeneration: owner.generation, stateRevision: owner.targetRevision,
        tabId: tab.id, generation: tab.generation, url }
    }),
    execute: (sessionId, command, expectedTarget) => enqueue(sessionId, async () => {
      const previous = owners.get(sessionId)
      assertTarget(previous, expectedTarget)
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
      if (command.kind === 'navigate') allowedUrl(command.url)
      const owner = previous ?? ensure(sessionId)
      const tab = active(owner)
      let cursor: BrowserObservation['cursor'] = null
      let mutated = false
      let feedback: Promise<void> | undefined
      try { switch (command.kind) {
        case 'navigate': await navigate(sessionId, owner, tab, command.url); break
        case 'click':
        case 'fill': {
          if (command.revision !== tab.revision || !tab.capture) fail('stale browser element revision', 'BROWSER_STALE_REF')
          const latest = tab.capture as BrowserCapture | undefined
          if (latest?.observation.revision !== command.revision) fail('stale browser element revision', 'BROWSER_STALE_REF')
          const documentEpoch = tab.navigation
          const escaped = JSON.stringify(command.ref)
          // 引用复核只判断点击含义：节点身份、事件处理器、导航与表单语义、命中位置。
          // 展示性属性与子树文本的更新不再单独判过期，由点击时刻的命中测试兜底。
          const targetExpression = `(() => { const ref = globalThis.__dshGuestRefs?.get(${escaped}); const el = ref?.el;
              if (!el || !el.isConnected) return { reason: 'element_left_document' };
              if (ref.form !== (el.form ?? null)) return { reason: 'element_form_changed' };
              const path = globalThis.__dshGuestPath(el);
              if (path.length !== ref.path.length || path.some((part, i) =>
                part.node !== ref.path[i].node || part.parent !== ref.path[i].parent ||
                JSON.stringify(part.attributes) !== JSON.stringify(ref.path[i].attributes))) {
                return { reason: 'ancestors_changed' };
              }
              if (JSON.stringify(ref.identity) !== JSON.stringify(globalThis.__dshGuestIdentity(el))) {
                return { reason: 'element_changed' };
              }
              if (${command.kind === 'fill'} && (el.disabled || el.readOnly ||
                (!('value' in el) && !el.isContentEditable))) return { reason: 'element_not_editable' };
              const style = getComputedStyle(el), box = el.getBoundingClientRect();
              if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
                style.pointerEvents === 'none') return { reason: 'element_hidden' };
              if (ref.identity.disabled || el.matches(':disabled') ||
                el.closest('[aria-disabled="true"], [inert]')) return { reason: 'element_disabled' };
              return globalThis.__dshGuestHit(el); })()`
          const box = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), command.ref, owner)
          assertStable(sessionId, owner, tab, documentEpoch)
          const current = tab.capture as BrowserCapture | undefined
          if (current?.observation.revision !== command.revision) {
            fail('browser element changed before input', 'BROWSER_STALE_REF')
          }
          await moveCursor(sessionId, tab, box.x, box.y)
          // 目标移动本身不是过期：第二次复核用当前命中点决定落点。
          const verified = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), command.ref, owner)
          assertStable(sessionId, owner, tab, documentEpoch)
          assertTarget(owner, expectedTarget)
          const movedCapture = tab.capture as BrowserCapture | undefined
          if (movedCapture?.observation.revision !== command.revision) {
            fail('browser element changed during cursor movement', 'BROWSER_STALE_REF')
          }
          const { x, y } = verified
          cursor = { x, y, kind: command.kind, at: Date.now() }
          mutated = true
          await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1,
          })
          try {
            assertStable(sessionId, owner, tab, documentEpoch)
            assertTarget(owner, expectedTarget)
          } catch (error) {
            // 已按下但文档变化时不能向新文档补 release；关闭会话收敛原生按键状态。
            destroy(sessionId)
            throw error
          }
          await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
          })
          if (command.kind === 'fill') {
            assertStable(sessionId, owner, tab, documentEpoch)
            const focused = await evaluate<boolean>(tab, `(() => { const ref = globalThis.__dshGuestRefs?.get(${escaped}); const el = ref?.el;
              if (!el || !el.isConnected || ref.form !== (el.form ?? null)) return false;
              const path = globalThis.__dshGuestPath(el);
              if (path.length !== ref.path.length || path.some((part, i) =>
                part.node !== ref.path[i].node || part.parent !== ref.path[i].parent ||
                JSON.stringify(part.attributes) !== JSON.stringify(ref.path[i].attributes)) ||
                JSON.stringify(ref.identity) !== JSON.stringify(globalThis.__dshGuestIdentity(el)) ||
                el.disabled || el.readOnly || (!('value' in el) && !el.isContentEditable)) return false;
              el.focus(); if (el.getRootNode().activeElement !== el) return false;
              if (el.isContentEditable) el.textContent = '';
              else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
                if (setter) setter.call(el, ''); else el.value = ''; }
              el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)
            assertStable(sessionId, owner, tab, documentEpoch)
            const current = tab.capture as BrowserCapture | undefined
            if (!focused || current?.observation.revision !== command.revision) {
              fail('browser element changed before fill', 'BROWSER_STALE_REF')
            }
            await tab.view.webContents.debugger.sendCommand('Input.insertText', { text: command.text })
          }
          if (presented?.sessionId === sessionId && presented.tabId === tab.id) {
            feedback = cursorOverlay?.move({ x, y }, command.kind).catch(() => {})
          }
          pointers.set(tab.id, { x, y })
          break
        }
        case 'scroll': {
          const pixels = Math.min(Math.max(command.pixels, 0), owner.viewport.height)
          const epoch = tab.navigation
          // 滚轮落在指针当前位置；没有指针时（会话内首个动作）才退回视口中心。
          const pointer = pointers.get(tab.id) ?? {
            x: Math.floor(owner.viewport.width / 2), y: Math.floor(owner.viewport.height / 2),
          }
          const x = pointer.x, y = pointer.y
          assertStable(sessionId, owner, tab, epoch)
          assertTarget(owner, expectedTarget)
          mutated = true
          await evaluate(tab, 'true')
          assertStable(sessionId, owner, tab, epoch)
          assertTarget(owner, expectedTarget)
          await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x, y, deltaX: 0, deltaY: (command.direction === 'down' ? 1 : -1) * pixels,
          })
          // 为异步滚轮合成留出时间；隐藏页面不依赖 requestAnimationFrame。
          await new Promise<void>(resolve => setTimeout(resolve, 100))
          assertStable(sessionId, owner, tab, epoch)
          pointers.set(tab.id, { x, y })
          if (presented?.sessionId === sessionId && presented.tabId === tab.id) {
            showCursor()
            feedback = cursorOverlay?.move({ x, y }, 'scroll').catch(() => {})
          }
          cursor = { x, y, kind: 'scroll', at: Date.now() }
          break
        }
        case 'snapshot': case 'screenshot': break
        default: { const never: never = command; throw new Error(`unknown browser command: ${String(never)}`) }
      }
      const capture = await observe(sessionId, owner, tab, cursor)
      await feedback
      if (command.kind === 'screenshot' && capture.png === null) {
        fail('browser screenshot unavailable until the page is shown in the desktop workbench', 'BROWSER_FAILED')
      }
      return capture
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
        if (command.kind === 'navigate' || command.kind === 'open-url') allowedUrl(command.url)
        if (command.kind === 'open-url') {
          const existing = owner
          owner ??= ensure(sessionId)
          const oldTabId = owner.active
          const oldTab = existing ? active(owner) : undefined
          const tab = existing ? createTab(owner, sessionId) : active(owner)
          const oldPresentation = presented?.sessionId === sessionId && presented.tabId === oldTabId
          if (existing) {
            owner.active = tab.id
            owner.revision++
            owner.targetRevision++
            if (oldPresentation && oldTab) { clearCursorOverlay(); detach(oldTab); presented = undefined }
          }
          try {
            await navigate(sessionId, owner, tab, command.url, true)
            invalidate(owner, tab)
            refreshSummary(tab)
            emit(sessionId, owner)
            return state(sessionId, owner)
          } catch (error) {
            if (owners.get(sessionId) === owner) {
              if (existing) {
                owner.tabs.delete(tab.id)
                owner.active = oldTabId
                owner.revision++
                owner.targetRevision++
                destroyTab(tab)
                if (oldPresentation && !presented && requestedPresentation?.sessionId === sessionId &&
                  requestedPresentation.tabId === oldTabId && requestedPresentation.visible) show(requestedPresentation)
                emit(sessionId, owner)
              } else destroy(sessionId)
            }
            throw error
          }
        }
        if (!owner && ['ensure-tab', 'new-tab', 'navigate'].includes(command.kind)) {
          owner = ensure(sessionId)
          if (command.kind === 'new-tab') return state(sessionId, owner)
        }
        if (!owner) fail('browser session is closed', 'BROWSER_CLOSED')
        const tab = active(owner)
        switch (command.kind) {
          case 'ensure-tab': break
          case 'new-tab': owner.active = createTab(owner, sessionId).id; owner.revision++; owner.targetRevision++; break
          case 'select-tab':
            if (!owner.tabs.has(command.tabId)) fail('browser tab is closed', 'BROWSER_CLOSED')
            owner.active = command.tabId; owner.revision++; owner.targetRevision++; break
          case 'close-tab': {
            const closing = owner.tabs.get(command.tabId)
            if (!closing) fail('browser tab is closed', 'BROWSER_CLOSED')
            if (owner.tabs.size === 1) { destroy(sessionId); return null }
            owner.tabs.delete(command.tabId)
            if (owner.active === command.tabId) owner.active = owner.tabs.keys().next().value as BrowserTabId
            owner.revision++
            owner.targetRevision++
            destroyTab(closing)
            break
          }
          case 'navigate':
            await navigate(sessionId, owner, tab, command.url, true)
            invalidate(owner, tab)
            refreshSummary(tab)
            break
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
              owner.targetRevision++
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
          clearCursorOverlay()
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
        try {
          if (presented?.sessionId === sessionId) protectPresentation()
        } catch (error) { leases.delete(sessionId); owner.lease = false; emit(sessionId, owner); throw error }
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
      clearCursorOverlay()
      await Promise.all([...tails.values()])
    },
  }
}
