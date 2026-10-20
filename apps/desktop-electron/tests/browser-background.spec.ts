/** 后台回归按原生父视图模拟零视口，并执行真实快照脚本而非预置元素引用。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { BrowserWindow } from 'electron'
import { createBrowserGuestManager } from '../src/browser-guest.ts'

const electron = vi.hoisted(() => ({ WebContentsView: vi.fn(), BaseWindow: vi.fn(), createFromBuffer: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(), WebContentsView: electron.WebContentsView, BaseWindow: electron.BaseWindow,
  nativeImage: { createFromBuffer: electron.createFromBuffer },
}))

vi.mock('../src/browser-input-overlay.ts', () => ({
  createBrowserInputOverlay: () => ({ attach: vi.fn(), close: vi.fn() }),
}))
vi.mock('../src/browser-cursor-overlay.ts', () => ({
  createBrowserCursorOverlay: () => ({ alive: true, show: vi.fn(), dispose: vi.fn(), move: () => Promise.resolve() }),
}))

function png(): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(1280, 16)
  bytes.writeUInt32BE(720, 20)
  return bytes
}

function fixture() {
  const parents: Array<{ children: unknown[]; width: number; height: number }> = []
  const lifecycle: string[] = []
  function parent(width: number, height: number) {
    const result = { children: [] as unknown[], width, height }
    parents.push(result)
    return {
      ...result,
      addChildView: vi.fn((view: unknown) => {
        for (const item of parents) {
          const index = item.children.indexOf(view)
          if (index !== -1) item.children.splice(index, 1)
        }
        result.children.push(view)
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = result.children.indexOf(view)
        if (index !== -1) result.children.splice(index, 1)
      }),
    }
  }
  // BrowserWindow 的主页面并非 contentView child；任何 child 都会覆盖 Host，必须留空。
  const host = parent(800, 600)
  const window = { isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), contentView: host }
  const stages: Array<{
    contentView: ReturnType<typeof parent>
    destroy: ReturnType<typeof vi.fn>
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  }> = []
  electron.BaseWindow.mockImplementation(function (options: { width: number; height: number }) {
    const stage = { contentView: parent(options.width, options.height), isDestroyed: () => false,
      setIgnoreMouseEvents: vi.fn(), destroy: vi.fn(() => { lifecycle.push('stage-destroy') }) }
    stages.push(stage)
    return stage
  })
  const views: Array<{ webContents: {
    debugger: { sendCommand: ReturnType<typeof vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>> }
    setBackgroundThrottling: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  } }> = []
  const documents: JSDOM[] = []
  const operations: Array<{ method: string; bounds: { x: number; y: number; width: number; height: number }; hostChildren: unknown[] }> = []

  function createView() {
    const dom = new JSDOM('<!doctype html><title>后台回归</title><button>应用内容</button>', {
      url: 'http://127.0.0.1/fixture', runScripts: 'outside-only',
    })
    documents.push(dom)
    const events = new Map<string, Array<(...args: unknown[]) => void>>()
    let bounds = { x: 0, y: 0, width: 1280, height: 720 }
    let url = 'about:blank'
    let destroyed = false
    const button = dom.window.document.querySelector('button')!
    Object.defineProperty(dom.window.document.body, 'innerText', { value: '后台回归 应用内容', configurable: true })
    Object.defineProperty(button, 'innerText', { value: '应用内容' })
    button.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, right: 110, top: 10, bottom: 50,
      width: 100, height: 40, toJSON: () => ({}) })
    const viewportWidth = () => parents.some(item => item.children.includes(view) && bounds.x < item.width &&
      bounds.y < item.height && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0) ? bounds.width : 0
    Object.defineProperty(dom.window, 'innerWidth', { get: viewportWidth })
    Object.defineProperty(dom.window, 'innerHeight', { get: () => viewportWidth() ? bounds.height : 0 })
    dom.window.document.elementFromPoint = (x, y) => x >= 10 && x <= 110 && y >= 10 && y <= 50 ? button : null
    const emit = (name: string, ...args: unknown[]) => {
      events.get(name)?.forEach((listener) => { listener(...args) })
    }
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      operations.push({ method, bounds: { ...bounds }, hostChildren: [...host.children] })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: dom.window.eval(String(params?.expression)) } }
      if (method === 'Page.captureScreenshot') {
        if (!viewportWidth()) throw new Error('No compositor surface outside the native viewport')
        return { data: png().toString('base64') }
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        button.innerHTML = '已应用'
        Object.defineProperty(dom.window.document.body, 'innerText', { value: '已应用', configurable: true })
      }
      return {}
    })
    const view = {
      setBounds: vi.fn((value: typeof bounds) => { bounds = value }),
      webContents: {
        debugger: { isAttached: () => true, attach: vi.fn(), sendCommand }, setBackgroundThrottling: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: vi.fn(),
        on: (name: string, listener: (...args: unknown[]) => void) => {
          const callbacks = events.get(name) ?? []
          callbacks.push(listener)
          events.set(name, callbacks)
        },
        removeListener: (name: string, listener: (...args: unknown[]) => void) => {
          const callbacks = events.get(name)
          const index = callbacks?.indexOf(listener) ?? -1
          if (index !== -1) callbacks!.splice(index, 1)
        },
        loadURL: (next: string) => {
          url = next
          dom.reconfigure({ url: next })
          emit('did-start-navigation', { isMainFrame: true, url: next })
          emit('did-navigate', {}, next)
          return Promise.resolve()
        },
        getURL: () => url,
        isLoading: () => false,
        isDestroyed: () => destroyed,
        close: vi.fn(() => { destroyed = true; lifecycle.push('guest-close') }),
      },
    }
    views.push(view)
    return view
  }
  electron.WebContentsView.mockImplementation(function () { return createView() })
  electron.createFromBuffer.mockImplementation(() => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }) }))
  return { window: window as unknown as BrowserWindow, host, stages, views, operations, lifecycle,
    cleanup: () => { documents.forEach((dom) => { dom.window.close() }) } }
}

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach((cleanup) => { cleanup() }); vi.clearAllMocks() })

function buttonRef(snapshot: string): string {
  const ref = /\n(e\S+) button /u.exec(snapshot)?.[1]
  expect(ref).toBeTruthy()
  return ref!
}

describe('后台 worker 原生浏览器', () => {
  it('未呈现页面保留真实元素、点击和截图，永不挂载到 Host 上层', async () => {
    const test = fixture()
    cleanups.push(test.cleanup)
    const manager = createBrowserGuestManager(test.window)
    await manager.lease('worker')
    try {
      const page = await manager.execute('worker', { kind: 'navigate', url: 'http://127.0.0.1/fixture' })
      expect(page.observation.snapshot).toContain('button "应用内容"')
      const clicked = await manager.execute('worker', { kind: 'click', ref: buttonRef(page.observation.snapshot),
        revision: page.observation.revision })
      expect(clicked.observation.snapshot).toContain('已应用')
      const screenshot = await manager.execute('worker', { kind: 'screenshot' })
      expect(Buffer.from(screenshot.png!)).toEqual(png())
      expect(screenshot.observation.tabId).toBe(page.observation.tabId)
      for (const operation of test.operations) {
        expect(operation.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
        expect(operation.hostChildren).toEqual([])
      }
      expect(electron.BaseWindow).toHaveBeenCalledOnce()
      expect(electron.BaseWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false, focusable: false, skipTaskbar: true }))
      expect(test.stages[0]!.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
      expect(test.views[0]!.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false)
      expect(test.views[0]!.webContents.close).not.toHaveBeenCalled()
    } finally { await manager.release('worker'); await manager.dispose() }
    expect(test.lifecycle).toEqual(['guest-close', 'stage-destroy'])
  })

  it.each(['hide', 'switch'] as const)('观测途中 %s 不会令旧页面失去原生承载', async (mode) => {
    const test = fixture()
    cleanups.push(test.cleanup)
    const manager = createBrowserGuestManager(test.window)
    const bounds = { x: 0, y: 0, width: 700, height: 400 }
    try {
      const first = await manager.execute('a', { kind: 'navigate', url: 'http://127.0.0.1/a' })
      const other = await manager.execute('b', { kind: 'navigate', url: 'http://127.0.0.1/b' })
      manager.present({ sessionId: 'a', tabId: first.observation.tabId, bounds, visible: true })
      await manager.lease('a')
      const wc = test.views[0]!.webContents
      const original = wc.debugger.sendCommand.getMockImplementation()!
      let resume!: () => void
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      let blocked = false
      wc.debugger.sendCommand.mockImplementation(async (method, params) => {
        if (method === 'Runtime.evaluate' && !blocked) {
          blocked = true
          started()
          await new Promise<void>((resolve) => { resume = resolve })
        }
        return original(method, params)
      })
      const pending = manager.execute('a', { kind: 'snapshot' })
      await ready
      if (mode === 'hide') manager.present({ sessionId: 'a', tabId: first.observation.tabId, bounds, visible: false })
      else manager.present({ sessionId: 'b', tabId: other.observation.tabId, bounds, visible: true })
      expect(test.stages[0]!.contentView.children).toContain(test.views[0])
      expect(test.host.children).not.toContain(test.views[0])
      resume()
      const captured = await pending
      expect(captured.observation.snapshot).toContain('button "应用内容"')
      expect(captured.png).not.toBeNull()
      expect(captured.observation.tabId).toBe(first.observation.tabId)
      expect(test.views[0]!.webContents.close).not.toHaveBeenCalled()
      if (mode === 'switch') expect(test.host.children).toEqual([test.views[1]])
      await manager.release('a')
    } finally { await manager.dispose() }
  })

  it('截图真正超时时只关闭当前后台会话，迟到帧不污染另一会话', async () => {
    vi.useFakeTimers()
    const test = fixture()
    cleanups.push(test.cleanup)
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(test.window, { onState: (_id, state) => { updates.push(state) } })
    try {
      await manager.execute('a', { kind: 'navigate', url: 'http://127.0.0.1/a' })
      const other = await manager.execute('b', { kind: 'navigate', url: 'http://127.0.0.1/b' })
      const wc = test.views[0]!.webContents
      const original = wc.debugger.sendCommand.getMockImplementation()!
      let complete!: (value: { data: string }) => void
      wc.debugger.sendCommand.mockImplementation((method, params) => method === 'Page.captureScreenshot'
        ? new Promise((resolve) => { complete = resolve }) : original(method, params))
      const pending = manager.execute('a', { kind: 'screenshot' })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      expect(wc.close).toHaveBeenCalledOnce()
      expect(await manager.prepare('a')).toEqual({ kind: 'none' })
      const count = updates.length
      complete({ data: png().toString('base64') })
      await vi.advanceTimersByTimeAsync(0)
      expect(updates).toHaveLength(count)
      const stillOpen = await manager.execute('b', { kind: 'snapshot' })
      expect(stillOpen.observation.tabId).toBe(other.observation.tabId)
      expect(test.host.children).toEqual([])
    } finally { await manager.dispose(); vi.useRealTimers() }
  })

  it('后台会话并行观测互不关闭，操作完成和失败均释放临时挂载', async () => {
    const test = fixture()
    cleanups.push(test.cleanup)
    const manager = createBrowserGuestManager(test.window)
    try {
      const pages = await Promise.all(['a', 'b'].map(sessionId => manager.execute(sessionId,
        { kind: 'navigate', url: `http://127.0.0.1/${sessionId}` })))
      await Promise.all(['a', 'b'].map(sessionId => manager.execute(sessionId, { kind: 'screenshot' })))
      await expect(manager.execute('a', { kind: 'click', revision: pages[0]!.observation.revision, ref: 'old' }))
        .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
      expect(test.stages[0]!.contentView.children).toEqual([])
      await manager.close('a')
      const remaining = await manager.execute('b', { kind: 'snapshot' })
      expect(remaining.observation.tabId).toBe(pages[1]!.observation.tabId)
      expect(test.views[1]!.webContents.close).not.toHaveBeenCalled()
      expect(test.host.children).toEqual([])
    } finally { await manager.dispose() }
  })
})
