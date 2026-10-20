/** Electron 主进程持有的实时浏览器标签页；模型与人工操作共享同一 WebContentsView。 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserHumanTarget, BrowserSessionState, BrowserTabId } from 'coding-browser'
import { createBrowserCursorOverlay } from './browser-cursor-overlay.ts'
import { createBrowserInputOverlay } from './browser-input-overlay.ts'
import { createGuestObserver } from './browser-guest-observation.ts'
import { createBackgroundStage } from './browser-guest-stage.ts'
import { performModelOperation } from './browser-guest-model.ts'
import { navigateGuest } from './browser-guest-navigation.ts'
import type { TargetOutcome } from './browser-guest-snapshot.ts'
import { INITIAL_VIEWPORT, MAX_SESSIONS, MAX_TABS, GuestError, STALE_TARGET_REASONS, active, allowedUrl, fail, invalidate,
  refreshSummary, validateViewport, type Owner, type Tab } from './browser-guest-state.ts'

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
  const backgroundStage = createBackgroundStage()
  let presented: { sessionId: string; tabId: BrowserTabId; bounds: BrowserGuestPresentation['bounds'] } | undefined
  let requestedPresentation: BrowserGuestPresentation | undefined
  let overlay: ReturnType<typeof createBrowserInputOverlay> | undefined
  let cursorOverlay: ReturnType<typeof createBrowserCursorOverlay> | undefined
  // 指针位置归标签页所有；释放输入租约不清空它。
  const pointers = new Map<BrowserTabId, { x: number; y: number }>()
  const { usableUrl, evaluate, assertStable, observe, refreshMutation } = createGuestObserver({ owners, destroy, emit })

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
        concealPresentation()
      })
      overlay.attach(presented.bounds)
    } catch (error) {
      concealPresentation()
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
    backgroundStage.detach(tab.view)
  }

  function park(sessionId: string, owner: Owner, tab: Tab): void {
    if (presented?.sessionId === sessionId && presented.tabId === tab.id) return
    backgroundStage.attach(tab.view, owner.viewport)
  }

  function unpark(tab: Tab): void {
    if (presented?.tabId !== tab.id) backgroundStage.detach(tab.view)
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
      // 未呈现的子会话也需要保持布局和绘制，供 CDP 命中测试与显式截图使用。
      backgroundThrottling: false,
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
      if (event.url === 'about:blank') return
      try {
        // loadURL 发起的显式导航不触发 will-navigate；页面及子 frame 不得自行读取其他本地文件。
        if (new URL(event.url).protocol === 'file:') { event.preventDefault(); return }
        if (event.isMainFrame !== false) allowedUrl(event.url)
      } catch { if (event.isMainFrame !== false) event.preventDefault() }
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

  function navigate(sessionId: string, owner: Owner, tab: Tab, url: string, human = false): Promise<void> {
    return navigateGuest(sessionId, owner, tab, url, {
      isCurrent: () => owners.get(sessionId) === owner && owner.tabs.get(tab.id) === tab,
      destroy: () => { destroy(sessionId) }, emit: () => { emit(sessionId, owner) },
    }, human)
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

  /** 正在执行或等待审批时撤下前台呈现，仍为同一 guest 保留可观测的隐藏承载。 */
  function concealPresentation(): void {
    if (!presented) return
    const owner = owners.get(presented.sessionId)
    const tab = owner?.tabs.get(presented.tabId)
    clearOverlay(); clearCursorOverlay(); presented = undefined
    if (!tab || !owner) return
    detach(tab)
    if (owner.lease) backgroundStage.attach(tab.view, owner.viewport)
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
      concealPresentation()
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
    if (presented && !same) concealPresentation()
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
        if (tab) unpark(tab)
        destroy(sessionId)
        return capture
      }
      if (!previous && command.kind !== 'navigate') fail('browser session is closed', 'BROWSER_CLOSED')
      if (command.kind === 'navigate') allowedUrl(command.url)
      const owner = previous ?? ensure(sessionId)
      const tab = active(owner)
      park(sessionId, owner, tab)
      const mutation = { occurred: false }
      try {
        const { cursor, feedback } = await performModelOperation({
          command, owner, tab, evaluate, requireTarget, pointers,
          assertStable: (navigation) => { assertStable(sessionId, owner, tab, navigation) },
          assertTarget: () => { assertTarget(owner, expectedTarget) },
          destroy: () => { destroy(sessionId) },
          moveCursor: (x, y) => moveCursor(sessionId, tab, x, y),
          feedback: (x, y, kind) => {
            if (presented?.sessionId !== sessionId || presented.tabId !== tab.id) return undefined
            if (kind === 'scroll') showCursor()
            return cursorOverlay?.move({ x, y }, kind).catch(() => {})
          },
          mutate: () => { mutation.occurred = true },
          navigate: url => navigate(sessionId, owner, tab, url),
          fail: message => fail(message, 'BROWSER_STALE_REF'),
        })
        const capture = await observe(sessionId, owner, tab, cursor, command.kind === 'screenshot')
        await feedback
        unpark(tab)
        return capture
      } catch (error) {
        unpark(tab)
        if (mutation.occurred && owners.get(sessionId) === owner && owner.tabs.has(tab.id)) {
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
      if (owner) { owner.lease = false; if (presented?.sessionId !== sessionId) unpark(active(owner)); emit(sessionId, owner) }
      if (requestedPresentation) show(requestedPresentation)
      return Promise.resolve(null)
    },
    present: show,
    dispose: async () => {
      disposed = true
      for (const sessionId of [...owners.keys()]) destroy(sessionId)
      backgroundStage.dispose()
      clearCursorOverlay()
      await Promise.all([...tails.values()])
    },
  }
}
