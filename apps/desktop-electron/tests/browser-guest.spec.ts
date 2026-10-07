import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { parseBridgeEvent, parseBridgeResponse } from '../../../packages/browser/browser-electron/src/protocol.ts'
import { createBrowserGuestManager } from '../src/browser-guest.ts'
import { fitBrowserPng } from '../src/browser-image.ts'

const electron = vi.hoisted(() => ({
  views: [] as Array<{ webContents: ReturnType<typeof fakeContents>; setBounds: ReturnType<typeof vi.fn> }>,
  WebContentsView: vi.fn<(options: Record<string, unknown>) => unknown>(),
  createFromBuffer: vi.fn(),
}))

function png(width = 1, height = 1, payload = 0): Buffer {
  const bytes = Buffer.alloc(33 + payload)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function fakeContents() {
  const events = new Map<string, (...args: never[]) => void>()
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  let url = ''
  let destroyed = false
  let loading = false
  let domRevision = 0
  const sendCommand = vi.fn(async (command: string, params?: unknown): Promise<unknown> => {
    if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } }
    if (command === 'Page.createIsolatedWorld') return { executionContextId: 4 }
    if (command === 'Page.captureScreenshot') return { data: png().toString('base64') }
    if (command === 'Runtime.evaluate') {
      if ((params as { expression: string }).expression === 'globalThis.__dshGuestReadMutationRevision()') {
        return { result: { value: domRevision } }
      }
      return { result: { value: { text: 'Hello', entries: [], title: 'Example',
        href: url.length <= 4096 ? url || 'about:blank' : null, domRevision } } }
    }
    return {}
  })
  const contents = {
    events,
    mutate: () => { domRevision++ },
    pageNavigate: (next: string) => { url = next; events.get('did-navigate-in-page')?.({} as never, next as never, true as never) },
    begin: (next: string) => {
      loading = true
      events.get('did-start-loading')?.()
      events.get('did-start-navigation')?.({ isMainFrame: true, url: next } as never)
      url = next
    },
    commit: (next: string) => {
      contents.begin(next)
      events.get('did-navigate')?.({} as never, next as never)
    },
    domReady: () => events.get('dom-ready')?.(),
    finish: () => { loading = false; events.get('did-stop-loading')?.() },
    debugger: { isAttached: vi.fn(() => true), attach: vi.fn(), sendCommand },
    session: {
      setPermissionRequestHandler: vi.fn<(
        handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
      ) => void>(),
      setPermissionCheckHandler: vi.fn<(handler: () => boolean) => void>(),
      on: vi.fn<(event: string, handler: (event: { preventDefault(): void }) => void) => void>(),
      webRequest: { onBeforeRequest: vi.fn<(
        filter: { urls: string[] },
        handler: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void,
      ) => void>() },
    },
    navigationHistory: { canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false),
      goBack: vi.fn(), goForward: vi.fn() },
    setWindowOpenHandler: vi.fn<(handler: () => { action: 'deny' }) => void>(),
    on: vi.fn((name: string, fn: (...args: never[]) => void) => {
      const callbacks = listeners.get(name) ?? []
      callbacks.push(fn)
      listeners.set(name, callbacks)
      events.set(name, (...args: never[]) => { for (const callback of [...callbacks]) callback(...args) })
    }),
    removeListener: vi.fn((name: string, fn: (...args: never[]) => void) => {
      const callbacks = listeners.get(name)
      if (callbacks) callbacks.splice(callbacks.indexOf(fn), 1)
    }),
    getURL: vi.fn(() => url),
    loadURL: vi.fn(async (next: string) => {
      contents.commit(next)
      contents.finish()
    }),
    stop: vi.fn(() => { loading = false }),
    isLoadingMainFrame: vi.fn(() => loading),
    isLoading: vi.fn(() => loading),
    reload: vi.fn(), sendInputEvent: vi.fn(), insertText: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => { destroyed = true; events.get('destroyed')?.() }),
  }
  return contents
}

vi.mock('electron', () => ({
  WebContentsView: electron.WebContentsView,
  BrowserWindow: vi.fn(),
  nativeImage: { createFromBuffer: electron.createFromBuffer },
}))

function fixture() {
  const children: unknown[] = []
  const window = {
    isDestroyed: vi.fn(() => false), getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children, addChildView: vi.fn((view: unknown) => { children.push(view) }),
      removeChildView: vi.fn((view: unknown) => { children.splice(children.indexOf(view), 1) }),
    },
  }
  return window as unknown as BrowserWindow
}

const hostOrigin = 'http://127.0.0.1:12345'

beforeEach(() => {
  vi.clearAllMocks()
  electron.views.length = 0
  electron.createFromBuffer.mockImplementation((bytes: Buffer) => {
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    return { isEmpty: () => false, getSize: () => size,
      resize: vi.fn((target: { width: number; height: number }) => ({
        toPNG: () => png(target.width, target.height, target.width * target.height * 2),
        getSize: () => target,
      })) }
  })
  electron.WebContentsView.mockImplementation(function () {
    const view = { webContents: fakeContents(), setBounds: vi.fn() }
    electron.views.push(view)
    return view
  })
})

describe('Electron 实时浏览器 guest', () => {
  it('已在传输预算内的 PNG 原字节保留，且不重新编码', async () => {
    const source = png(2560, 1440)
    const result = await fitBrowserPng(source.toString('base64'), 2 * 1024 * 1024)
    expect(Buffer.from(result)).toEqual(source)
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(2)
    const native = electron.createFromBuffer.mock.results[0]?.value as { resize: ReturnType<typeof vi.fn> } | undefined
    expect(native?.resize).not.toHaveBeenCalled()
  })

  it('创建受限的内存 guest，并阻止弹窗、下载、权限和 Host 地址', async () => {
    const manager = createBrowserGuestManager(fixture(), { hostOrigin })
    const state = await manager.control('s1', { kind: 'ensure-tab' })
    expect(state?.activeTabId).toBeTruthy()
    expect(electron.WebContentsView.mock.calls[0]?.[0]).toMatchObject({ webPreferences: {
      sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
    } })
    const guestPreferences = electron.WebContentsView.mock.calls[0]?.[0].webPreferences as { partition: string }
    expect(guestPreferences.partition).toMatch(/^dsh-guest-/)
    const wc = electron.views[0]!.webContents
    expect(wc.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    expect(wc.session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    const callback = vi.fn()
    wc.session.setPermissionRequestHandler.mock.calls[0]?.[0]?.(wc, 'camera', callback)
    expect(callback).toHaveBeenCalledWith(false)
    const download = { preventDefault: vi.fn() }
    wc.session.on.mock.calls[0]?.[1]?.(download)
    expect(download.preventDefault).toHaveBeenCalledOnce()
    const navigation = { url: hostOrigin + '/private', isMainFrame: true, preventDefault: vi.fn() }
    wc.events.get('will-frame-navigate')?.(navigation as never)
    expect(navigation.preventDefault).toHaveBeenCalledOnce()
    const aliases = [
      'http://localhost:12345/private', 'http://localhost.:12345/private',
      'http://[::1]:12345/private', 'http://[::ffff:7f00:1]:12345/private',
      'http://127.1:12345/private', 'http://0x7f000001:12345/private',
      'http://2130706433:12345/private',
    ]
    for (const alias of aliases) {
      const redirect = { url: alias, isMainFrame: true, preventDefault: vi.fn() }
      wc.events.get('will-redirect')?.(redirect as never)
      expect(redirect.preventDefault, alias).toHaveBeenCalledOnce()
      await expect(manager.execute('s1', { kind: 'navigate', url: alias }), alias)
        .rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    }
    const filter = wc.session.webRequest.onBeforeRequest.mock.calls[0]?.[0]
    expect(filter?.urls).toContain('<all_urls>')
    expect(filter?.urls).toContain('ws://*/*')
    const onBeforeRequest = wc.session.webRequest.onBeforeRequest.mock.calls[0]?.[1]
    for (const resource of [...aliases, 'ws://localhost:12345/socket', 'wss://[::1]:12345/socket']) {
      const response = vi.fn()
      onBeforeRequest?.({ url: resource }, response)
      expect(response, resource).toHaveBeenCalledWith({ cancel: true })
    }
    for (const resource of ['http://localhost:12346/private', 'http://127.0.0.2:12345/private',
      'https://example.com/private', 'ws://localhost:12346/socket']) {
      const response = vi.fn()
      onBeforeRequest?.({ url: resource }, response)
      expect(response, resource).toHaveBeenCalledWith({ cancel: false })
    }
    await expect(manager.execute('s1', { kind: 'navigate', url: hostOrigin + '/private' })).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    await expect(manager.execute('s1', { kind: 'navigate', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    const permitted = await manager.execute('s1', { kind: 'navigate', url: 'http://localhost:12346/page' })
    expect(permitted.observation.url).toBe('http://localhost:12346/page')
    await manager.dispose()
  })

  it('页面与画面共用 guest，导航撤销状态及审批目标', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state, capture) => updates.push({ state, capture }) })
    expect(await manager.prepare('s1')).toEqual({ kind: 'none' })
    const capture = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' }, { kind: 'none' })
    expect(capture.observation.url).toBe('https://example.com/')
    expect(electron.views).toHaveLength(1)
    const target = await manager.prepare('s1')
    expect(target.kind).toBe('tab')
    const tabId = capture.observation.tabId
    const window = fixture()
    manager.present({ sessionId: 's1', tabId, visible: false, bounds: { x: 0, y: 0, width: 700, height: 500 } })
    expect(electron.views[0]!.webContents.close).not.toHaveBeenCalled()
    electron.views[0]!.webContents.events.get('did-start-navigation')?.({ isMainFrame: true } as never)
    expect(updates.at(-1)).toMatchObject({ state: { observation: null, hasFrame: false } })
    await expect(manager.execute('s1', { kind: 'snapshot' }, target)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(window).toBeTruthy()
    await manager.dispose()
  })

  it('租约阻挡人工命令，隐藏和切换标签页仅卸载视图', async () => {
    const window = fixture()
    const manager = createBrowserGuestManager(window)
    const initial = await manager.control('s1', { kind: 'ensure-tab' })
    const id = initial!.activeTabId!
    manager.present({ sessionId: 's1', tabId: id, visible: true,
      bounds: { x: 100, y: 50, width: 900, height: 900 } })
    expect(electron.views[0]!.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 700, height: 550 })
    await manager.lease('s1')
    expect(window.contentView.children).toHaveLength(0)
    await expect(manager.control('s1', { kind: 'new-tab' })).rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    const directInput = { preventDefault: vi.fn() }
    electron.views[0]!.webContents.events.get('input-event')?.(directInput as never, { type: 'mouseDown' } as never)
    expect(directInput.preventDefault).toHaveBeenCalledOnce()
    await manager.release('s1')
    expect(window.contentView.children).toHaveLength(1)
    manager.present({ sessionId: 's1', tabId: id, visible: true,
      bounds: { x: 100, y: 50, width: 900, height: 900 } })
    expect(window.contentView.children).toHaveLength(1)
    const next = await manager.control('s1', { kind: 'new-tab' })
    expect(next!.activeTabId).not.toBe(id)
    expect(electron.views[0]!.webContents.close).not.toHaveBeenCalled()
    expect(window.contentView.children).toHaveLength(0)
    const back = await manager.control('s1', { kind: 'select-tab', tabId: id })
    expect(back!.activeTabId).toBe(id)
    const remaining = await manager.control('s1', { kind: 'close-tab', tabId: id })
    expect(remaining!.activeTabId).toBe(next!.activeTabId)
    await manager.close('s1')
    expect(electron.views.every(view => view.webContents.close.mock.calls.length === 1)).toBe(true)
  })

  it('原生页面人工输入撤销旧画面，人工导航可建立会话', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push(state) })
    const opened = await manager.control('s1', { kind: 'navigate', url: 'https://example.com/' })
    expect(opened).toMatchObject({ observation: null, hasFrame: false, tabs: [{ url: 'https://example.com/' }] })
    const oldRevision = opened!.stateRevision
    electron.views[0]!.webContents.events.get('input-event')?.({ preventDefault: vi.fn() } as never,
      { type: 'mouseDown' } as never)
    expect(updates.at(-1)).toMatchObject({ observation: null, hasFrame: false,
      stateRevision: oldRevision + 1 })
    await manager.dispose()
  })

  it('人工开页在主 frame 提交后返回，脚本未就绪和图片加载不阻塞原生标签', async () => {
    vi.useFakeTimers()
    try {
      const updates: unknown[] = []
      const manager = createBrowserGuestManager(fixture(), { onState: (_id, current) => updates.push(current) })
      let finish!: () => void
      electron.WebContentsView.mockImplementationOnce(function () {
        const view = { webContents: fakeContents(), setBounds: vi.fn() }
        view.webContents.loadURL.mockImplementationOnce((url: string) => {
          view.webContents.commit(url)
          return new Promise<void>((resolve) => { finish = resolve })
        })
        view.webContents.debugger.sendCommand.mockRejectedValue(new Error('strict observation unavailable'))
        electron.views.push(view)
        return view
      })
      const pending = manager.control('s1', { kind: 'open-url', url: 'https://example.com/slow-image' })
      await vi.advanceTimersByTimeAsync(0)
      const state = await pending
      expect(state).toMatchObject({ observation: null, hasFrame: false,
        tabs: [{ url: 'https://example.com/slow-image', loading: true }] })
      expect(electron.views[0]!.webContents.debugger.sendCommand).not.toHaveBeenCalled()
      expect(electron.views[0]!.webContents.stop).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(12_000)
      expect(electron.views[0]!.webContents.close).not.toHaveBeenCalled()
      electron.views[0]!.webContents.finish()
      expect(updates.at(-1)).toMatchObject({ tabs: [{ url: 'https://example.com/slow-image', loading: false }] })
      expect((updates.at(-1) as { stateRevision: number }).stateRevision).toBeGreaterThan(state!.stateRevision)
      const finished = await manager.control('s1', { kind: 'ensure-tab' })
      expect(finished?.tabs[0]?.loading).toBe(false)
      expect(finished!.stateRevision).toBeGreaterThan(state!.stateRevision)
      finish()
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it('主 frame 已提交但 loadURL 随即拒绝时不承认开页成功', async () => {
    const manager = createBrowserGuestManager(fixture())
    electron.WebContentsView.mockImplementationOnce(function () {
      const view = { webContents: fakeContents(), setBounds: vi.fn() }
      view.webContents.loadURL.mockImplementationOnce(async (url: string) => {
        view.webContents.commit(url)
        view.webContents.domReady()
        throw new Error('navigation rejected')
      })
      electron.views.push(view)
      return view
    })
    await expect(manager.control('s1', { kind: 'open-url', url: 'https://example.com/' }))
      .rejects.toThrow('navigation rejected')
    expect(electron.views[0]!.webContents.close).toHaveBeenCalledOnce()
    expect(await manager.prepare('s1')).toEqual({ kind: 'none' })
    await manager.dispose()
  })

  it('人工导航只承认本次主 frame 提交，允许受校验的重定向且不泄露被拒 URL', async () => {
    const manager = createBrowserGuestManager(fixture(), { hostOrigin })
    await manager.control('s1', { kind: 'ensure-tab' })
    const wc = electron.views[0]!.webContents
    wc.loadURL.mockImplementationOnce((url: string) => {
      wc.begin(url)
      wc.events.get('did-navigate')?.({} as never, 'https://example.com/old' as never)
      wc.events.get('did-redirect-navigation')?.({ isMainFrame: true, url: 'https://example.org/landing' } as never)
      wc.events.get('did-navigate')?.({} as never, 'https://example.org/landing' as never)
      wc.getURL.mockReturnValue('https://example.org/landing')
      wc.events.get('did-navigate')?.({} as never, 'https://example.org/landing' as never)
      return new Promise<void>(() => {})
    })
    const landed = await manager.control('s1', { kind: 'navigate', url: 'https://example.com/start' })
    expect(landed?.tabs[0]).toMatchObject({ url: 'https://example.org/landing', loading: true })

    wc.getURL.mockRestore()
    wc.loadURL.mockImplementationOnce((url: string) => {
      wc.begin(url)
      wc.events.get('did-redirect-navigation')?.({ isMainFrame: true, url: hostOrigin + '/private' } as never)
      wc.getURL.mockReturnValue(hostOrigin + '/private')
      wc.events.get('did-navigate')?.({} as never, (hostOrigin + '/private') as never)
      return new Promise<void>(() => {})
    })
    const failed = await manager.control('s1', { kind: 'navigate', url: 'https://example.com/next' })
      .then(() => null, (error: unknown) => error)
    expect(failed).toMatchObject({ code: 'BROWSER_DENIED', message: 'browser URL denied' })
    expect((failed as Error).message).not.toContain(hostOrigin)
    await manager.dispose()
  })

  it('旧页面迟到的 ERR_ABORTED 不会把正在加载的新人工导航误判为失败', async () => {
    vi.useFakeTimers()
    try {
      const manager = createBrowserGuestManager(fixture())
      const initial = await manager.control('s1', { kind: 'ensure-tab' })
      const wc = electron.views[0]!.webContents
      let rejectOld!: (reason: Error) => void
      wc.loadURL.mockImplementationOnce((url: string) => {
        wc.commit(url)
        return new Promise<void>((_resolve, reject) => { rejectOld = reject })
      })
      const firstPending = manager.control('s1', { kind: 'navigate', url: 'https://example.com/first' })
      await vi.advanceTimersByTimeAsync(0)
      const first = await firstPending
      expect(first?.activeTabId).toBe(initial?.activeTabId)
      wc.loadURL.mockImplementationOnce((url: string) => {
        wc.begin(url)
        wc.events.get('did-fail-load')?.({} as never, -3 as never,
          'ERR_ABORTED' as never, 'https://example.com/first' as never, true as never)
        wc.events.get('did-navigate')?.({} as never, 'https://example.com/first' as never)
        rejectOld(new Error('ERR_ABORTED'))
        wc.events.get('did-navigate')?.({} as never, url as never)
        return new Promise<void>(() => {})
      })
      const secondPending = manager.control('s1', { kind: 'navigate', url: 'https://example.com/second' })
      await vi.advanceTimersByTimeAsync(0)
      const second = await secondPending
      expect(second).toMatchObject({ observation: null, hasFrame: false,
        tabs: [{ url: 'https://example.com/second' }] })
      expect(wc.stop).not.toHaveBeenCalled()
      expect(wc.events.get('did-fail-load')).toBeUndefined()
      expect(wc.removeListener).toHaveBeenCalledWith('did-navigate', expect.any(Function))
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it('人工地址栏导航不依赖动态 DOM 的严格观测，并撤销旧模型引用', async () => {
    const manager = createBrowserGuestManager(fixture())
    const old = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/old' })
    const wc = electron.views[0]!.webContents
    wc.debugger.sendCommand.mockClear()
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('dynamic DOM'))
    const changed = await manager.control('s1', { kind: 'navigate', url: 'https://example.com/new' })
    expect(changed).toMatchObject({ observation: null, hasFrame: false,
      tabs: [{ url: 'https://example.com/new' }] })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
    await expect(manager.execute('s1', { kind: 'click', ref: 'e1', revision: old.observation.revision }))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await manager.dispose()
  })

  it('原子开页复用空会话首个 guest，已有会话则创建独立标签并返回原生页面状态', async () => {
    const events: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { hostOrigin, onState: (sessionId, state, capture) => {
      parseBridgeEvent({ v: 1, type: 'state', sessionId, state, ...(capture ? { capture: {
        observation: capture.observation, png: capture.png === null ? null : Buffer.from(capture.png).toString('base64'),
      } } : {}) })
      events.push(state)
    } })
    const first = await manager.control('s1', { kind: 'open-url', url: 'https://example.com/first' })
    expect(electron.views).toHaveLength(1)
    expect(first).toMatchObject({ observation: null, hasFrame: false,
      tabs: [{ url: 'https://example.com/first' }] })
    const second = await manager.control('s1', { kind: 'open-url', url: 'https://example.org/second' })
    expect(electron.views).toHaveLength(2)
    expect(second).toMatchObject({ observation: null, hasFrame: false,
      tabs: [{}, { url: 'https://example.org/second' }] })
    expect(second!.activeTabId).not.toBe(first!.activeTabId)
    expect(second!.tabs.map(tab => tab.url)).toEqual(['https://example.com/first', 'https://example.org/second'])
    expect(electron.views[0]!.webContents.close).not.toHaveBeenCalled()
    expect(electron.views[1]!.webContents.session.setPermissionRequestHandler).not.toHaveBeenCalled()
    expect(electron.views[1]!.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const redirect = { url: hostOrigin + '/private', isMainFrame: true, preventDefault: vi.fn() }
    electron.views[1]!.webContents.events.get('will-redirect')?.(redirect as never)
    expect(redirect.preventDefault).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ activeTabId: second!.activeTabId,
      observation: null, hasFrame: false })
    await manager.dispose()
  })

  it('原子开页在导航失败后只关闭新标签，并恢复旧标签与呈现', async () => {
    const window = fixture()
    const manager = createBrowserGuestManager(window)
    const old = await manager.control('s1', { kind: 'open-url', url: 'https://example.com/old' })
    const other = await manager.control('s2', { kind: 'open-url', url: 'https://example.org/' })
    manager.present({ sessionId: 's1', tabId: old!.activeTabId!, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    expect(window.contentView.children).toHaveLength(1)
    for (const failure of ['navigation', 'main-frame'] as const) {
      electron.WebContentsView.mockImplementationOnce(function () {
        const view = { webContents: fakeContents(), setBounds: vi.fn() }
        if (failure === 'navigation') view.webContents.loadURL.mockRejectedValueOnce(new Error('navigation failed'))
        else view.webContents.loadURL.mockImplementationOnce(async () => {
          view.webContents.events.get('did-start-navigation')?.({ isMainFrame: true } as never)
          view.webContents.events.get('did-fail-load')?.({} as never, -105 as never,
            'ERR_NAME_NOT_RESOLVED' as never, 'https://example.com/new' as never, true as never)
          throw new Error('ERR_NAME_NOT_RESOLVED')
        })
        electron.views.push(view)
        return view
      })
      await expect(manager.control('s1', { kind: 'open-url', url: 'https://example.com/new' }))
        .rejects.toThrow(failure === 'navigation' ? 'navigation failed' : 'ERR_NAME_NOT_RESOLVED')
      const failed = electron.views.at(-1)!.webContents
      expect(failed.close).toHaveBeenCalledOnce()
      expect(window.contentView.children).toHaveLength(1)
      const restored = await manager.control('s1', { kind: 'ensure-tab' })
      expect(restored).toMatchObject({ activeTabId: old!.activeTabId, tabs: [{ id: old!.activeTabId }] })
      failed.commit('https://example.com/late')
      failed.domReady()
      failed.events.get('page-title-updated')?.({} as never, 'Late title' as never)
      expect(await manager.control('s1', { kind: 'ensure-tab' })).toEqual(restored)
      expect(electron.views[0]!.webContents.close).not.toHaveBeenCalled()
      expect((await manager.control('s2', { kind: 'ensure-tab' }))!.activeTabId).toBe(other!.activeTabId)
    }
    await manager.dispose()
  })

  it('首次原子开页失败不留下空会话；原生导航停稳后回滚刚建的标签', async () => {
    vi.useFakeTimers()
    try {
      const manager = createBrowserGuestManager(fixture())
      electron.WebContentsView.mockImplementationOnce(function () {
        const view = { webContents: fakeContents(), setBounds: vi.fn() }
        view.webContents.loadURL.mockRejectedValueOnce(new Error('first navigation failed'))
        electron.views.push(view)
        return view
      })
      await expect(manager.control('s1', { kind: 'open-url', url: 'https://example.com/' }))
        .rejects.toThrow('first navigation failed')
      expect(electron.views[0]!.webContents.close).toHaveBeenCalledOnce()
      expect(await manager.prepare('s1')).toEqual({ kind: 'none' })

      const first = await manager.control('s1', { kind: 'open-url', url: 'https://example.com/old' })
      const old = electron.views[1]!.webContents
      electron.WebContentsView.mockImplementationOnce(function () {
        const view = { webContents: fakeContents(), setBounds: vi.fn() }
        let finish!: () => void
        view.webContents.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
        view.webContents.isLoadingMainFrame.mockReturnValue(true)
        view.webContents.stop.mockImplementationOnce(() => {
          view.webContents.isLoadingMainFrame.mockReturnValue(false)
          finish()
        })
        electron.views.push(view)
        return view
      })
      const pending = manager.control('s1', { kind: 'open-url', url: 'https://example.com/slow' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).rejects.toThrow('take a new snapshot')
      expect(electron.views[2]!.webContents.close).toHaveBeenCalledOnce()
      expect(old.close).not.toHaveBeenCalled()
      const restored = await manager.control('s1', { kind: 'ensure-tab' })
      expect(restored).toMatchObject({ activeTabId: first!.activeTabId, tabs: [{ id: first!.activeTabId }] })
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it('原子开页先拒绝非法与 Host URL，且租约或标签上限不产生多余 guest', async () => {
    const manager = createBrowserGuestManager(fixture(), { hostOrigin })
    await expect(manager.control('fresh', { kind: 'open-url', url: hostOrigin + '/private' }))
      .rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    expect(electron.views).toHaveLength(0)
    const initial = await manager.control('s1', { kind: 'ensure-tab' })
    for (const [url, code] of [
      ['file:///tmp/unsafe', 'BROWSER_DENIED'], [hostOrigin + '/private', 'BROWSER_DENIED'],
      ['not a URL', 'BROWSER_INVALID_URL'],
    ] as const) {
      await expect(manager.control('s1', { kind: 'open-url', url })).rejects.toMatchObject({ code })
    }
    expect(electron.views).toHaveLength(1)
    expect((await manager.control('s1', { kind: 'ensure-tab' }))!.activeTabId).toBe(initial!.activeTabId)
    await manager.lease('s1')
    await expect(manager.control('s1', { kind: 'open-url', url: 'https://example.com/' }))
      .rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    expect(electron.views).toHaveLength(1)
    await manager.release('s1')
    for (let i = 1; i < 8; i++) await manager.control('s1', { kind: 'new-tab' })
    await expect(manager.control('s1', { kind: 'open-url', url: 'https://example.com/' }))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(electron.views).toHaveLength(8)
    await manager.dispose()
  })

  it('同文档页面改变后，审批目标和元素引用都失效', async () => {
    const manager = createBrowserGuestManager(fixture())
    const capture = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    const target = await manager.prepare('s1')
    electron.views[0]!.webContents.mutate()
    await expect(manager.execute('s1', { kind: 'snapshot' }, target)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(manager.execute('s1', { kind: 'click', ref: 'e1', revision: capture.observation.revision }))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await manager.dispose()
  })

  it('history.pushState 的同文档导航立即撤销旧审批和画面', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push(state) })
    await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    const target = await manager.prepare('s1')
    const wc = electron.views[0]!.webContents
    wc.events.get('did-navigate-in-page')?.({} as never, 'https://example.com/next' as never, true as never)
    expect(updates.at(-1)).toMatchObject({ observation: null, hasFrame: false })
    await expect(manager.execute('s1', { kind: 'snapshot' }, target)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await manager.dispose()
  })

  it('页面制造超长同文档 URL 不会发布非法帧，其他会话及恢复后的本会话仍可用', async () => {
    const updates: Array<{ sessionId: string; state: unknown; capture: unknown }> = []
    const manager = createBrowserGuestManager(fixture(), { onState: (sessionId, state, capture) => {
      const event = { v: 1, type: 'state', sessionId, state, ...(capture ? { capture: {
        observation: capture.observation, png: capture.png === null ? null : Buffer.from(capture.png).toString('base64'),
      } } : {}) } as const
      parseBridgeEvent(event)
      updates.push({ sessionId, state, capture })
    } })
    const first = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    const second = await manager.execute('s2', { kind: 'navigate', url: 'https://example.org/' })
    const approved = await manager.prepare('s1')
    const wc = electron.views[0]!.webContents
    wc.pageNavigate('https://example.com/#' + 'a'.repeat(4096))
    const latest = updates.at(-1)!
    expect(latest.sessionId).toBe('s1')
    expect(latest.state).toMatchObject({ observation: null, hasFrame: false,
      tabs: [{ url: 'about:blank#browser-url-exceeds-limit' }] })
    await expect(manager.prepare('s1')).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    await expect(manager.execute('s1', { kind: 'snapshot' })).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    await expect(manager.execute('s1', { kind: 'snapshot' }, approved)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    const independent = await manager.execute('s2', { kind: 'snapshot' })
    expect(independent.observation.tabId).toBe(second.observation.tabId)
    parseBridgeResponse({ v: 1, id: 'independent', ok: true, value: {
      observation: independent.observation, png: independent.png === null ? null : Buffer.from(independent.png).toString('base64'),
    } }, 'execute')
    wc.pageNavigate('https://example.com/#short')
    const recovered = await manager.execute('s1', { kind: 'snapshot' })
    expect(recovered.observation).toMatchObject({ tabId: first.observation.tabId,
      url: 'https://example.com/#short' })
    expect((await manager.prepare('s1'))).toMatchObject({ kind: 'tab', url: 'https://example.com/#short' })
    await manager.dispose()
  })

  it('人工链接导航后的页面标题事件刷新标签页并撤销旧审批', async () => {
    const updates: Array<{ state: unknown }> = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push({ state }) })
    await manager.control('s1', { kind: 'navigate', url: 'https://example.com/' })
    const before = await manager.prepare('s1')
    const wc = electron.views[0]!.webContents
    wc.events.get('page-title-updated')?.({} as never, 'New title' as never)
    expect(updates.at(-1)?.state).toMatchObject({ tabs: [{ title: 'New title' }],
      observation: null, hasFrame: false })
    await expect(manager.execute('s1', { kind: 'snapshot' }, before)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await manager.dispose()
  })

  it.each(['click', 'scroll', 'type'] as const)('%s 在人工截图目标对应 DOM 移动后拒绝输入', async (kind) => {
    const manager = createBrowserGuestManager(fixture())
    await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    const capture = await manager.execute('s1', { kind: 'snapshot' })
    const expected = await manager.prepare('s1')
    if (expected.kind !== 'tab') throw new Error('expected active tab')
    const target = { browserGeneration: expected.browserGeneration, stateRevision: expected.stateRevision,
      tabId: expected.tabId, generation: expected.generation, revision: capture.observation.revision,
      viewport: capture.observation.viewport }
    const wc = electron.views[0]!.webContents
    wc.mutate()
    const command = kind === 'scroll' ? { kind, target, x: 10, y: 10, direction: 'down' as const, pixels: 50 }
      : kind === 'type' ? { kind, target, x: 10, y: 10, text: 'unsafe' }
        : { kind, target, x: 10, y: 10 }
    await expect(manager.control('s1', command)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
    expect(wc.insertText).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('截图观察 open shadow root，并在之后出现新 shadow root 时撤销坐标目标', async () => {
    const manager = createBrowserGuestManager(fixture())
    await manager.control('s1', { kind: 'ensure-tab' })
    const wc = electron.views[0]!.webContents
    await manager.execute('s1', { kind: 'snapshot' })
    const expression = wc.debugger.sendCommand.mock.calls.find(([command, params]) =>
      command === 'Runtime.evaluate' && (params as { expression: string }).expression.includes('const scanRoots'))?.[1] as
      { expression: string }
    expect(expression.expression).toContain('shadowRoot')
    const shadow = { nodes: [] as unknown[] }
    const host = { shadowRoot: shadow, matches: () => false }
    const document = { title: 'Shadow', body: { innerText: '' }, nodes: [host],
      createTreeWalker(tree: { nodes: unknown[] }) {
        let index = -1
        return { currentNode: undefined as unknown,
          nextNode() { index++; this.currentNode = tree.nodes[index]; return index < tree.nodes.length } }
      } }
    const observers: Array<{ target?: unknown; fire(): void; disconnect(): void; takeRecords(): unknown[] }> = []
    class MutationObserver {
      target?: unknown
      constructor(private readonly callback: () => void) { observers.push(this) }
      observe(target: unknown) { this.target = target }
      disconnect() { this.target = undefined }
      takeRecords() { return [] }
      fire() { this.callback() }
    }
    const context = { document, MutationObserver, NodeFilter: { SHOW_ELEMENT: 1 },
      location: { href: 'https://example.com/' }, innerWidth: 800, innerHeight: 600 }
    const snapshot = runInNewContext(expression.expression, context) as { domRevision: number }
    const root = context as typeof context & { __dshGuestReadMutationRevision(): number }
    expect(observers.some(observer => observer.target === shadow)).toBe(true)
    observers.find(observer => observer.target === shadow)!.fire()
    expect(root.__dshGuestReadMutationRevision()).toBeGreaterThan(snapshot.domRevision)
    const beforeNewRoot = root.__dshGuestReadMutationRevision()
    host.shadowRoot = { nodes: [] }
    expect(root.__dshGuestReadMutationRevision()).toBeGreaterThan(beforeNewRoot)
    await manager.dispose()
  })

  it('元素位置查询期间的 DOM 变化阻止 Agent 点击', async () => {
    const manager = createBrowserGuestManager(fixture())
    const capture = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    const wc = electron.views[0]!.webContents
    const original = wc.debugger.sendCommand.getMockImplementation()!
    wc.debugger.sendCommand.mockImplementation((command: string, params?: unknown) => {
      if (command === 'Runtime.evaluate' && (params as { expression: string }).expression.includes('__dshGuestRefs?.get')) {
        wc.mutate()
        return Promise.resolve({ result: { value: { x: 10, y: 10, width: 40, height: 20 } } })
      }
      return original(command, params)
    })
    await expect(manager.execute('s1', { kind: 'click', ref: 'e1', revision: capture.observation.revision }))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('先取得空会话租约后新建页面，原生呈现仍被遮蔽至释放', async () => {
    const window = fixture()
    const manager = createBrowserGuestManager(window)
    await manager.lease('s1')
    const capture = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
    manager.present({ sessionId: 's1', tabId: capture.observation.tabId, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    expect(window.contentView.children).toHaveLength(0)
    await expect(manager.control('s1', { kind: 'ensure-tab' })).rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    await manager.release('s1')
    expect(window.contentView.children).toHaveLength(1)
    await manager.dispose()
  })

  it('每会话上限八个标签页，超限截图不能发布旧观测', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push(state) })
    let current = await manager.control('s1', { kind: 'ensure-tab' })
    for (let i = 1; i < 8; i++) current = await manager.control('s1', { kind: 'new-tab' })
    await expect(manager.control('s1', { kind: 'new-tab' })).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    const wc = electron.views.at(-1)!.webContents
    manager.present({ sessionId: 's1', tabId: current!.activeTabId!,
      visible: true, bounds: { x: 0, y: 0, width: 500, height: 400 } })
    wc.debugger.sendCommand.mockImplementation(async (command: string, params?: unknown): Promise<unknown> => {
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } }
      if (command === 'Page.createIsolatedWorld') return { executionContextId: 4 }
      if (command === 'Runtime.evaluate') {
        if ((params as { expression: string }).expression === 'globalThis.__dshGuestReadMutationRevision()') {
          return { result: { value: 0 } }
        }
        return { result: { value: { text: '', entries: [], title: '', href: 'about:blank', domRevision: 0 } } }
      }
      if (command === 'Page.captureScreenshot') return { data: png(3000, 2000, 2 * 1024 * 1024).toString('base64') }
      return {}
    })
    electron.createFromBuffer.mockImplementation((bytes: Buffer) => ({ isEmpty: () => false,
      getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
      resize: vi.fn((target: { width: number; height: number }) => ({
        toPNG: () => png(target.width, target.height, 2 * 1024 * 1024),
        getSize: () => target,
      })) }))
    await expect(manager.execute('s1', { kind: 'snapshot' })).rejects.toThrow('browser screenshot processing failed')
    expect(updates.at(-1)).toMatchObject({ observation: null, hasFrame: false })
    await expect(manager.execute('s1', { kind: 'click', ref: 'old', revision: 1 }))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await manager.dispose()
  })

  it('高细节高分屏截图经共享缩图策略反复适配并发布有效 PNG', async () => {
    const manager = createBrowserGuestManager(fixture())
    const state = await manager.control('s1', { kind: 'ensure-tab' })
    manager.present({ sessionId: 's1', tabId: state!.activeTabId!, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    const wc = electron.views[0]!.webContents
    const original = wc.debugger.sendCommand.getMockImplementation()!
    wc.debugger.sendCommand.mockImplementation((command: string, params?: unknown) => {
      if (command === 'Page.captureScreenshot') {
        return Promise.resolve({ data: png(3000, 2000, 2 * 1024 * 1024).toString('base64') })
      }
      return original(command, params)
    })
    const capture = await manager.execute('s1', { kind: 'snapshot' })
    expect(electron.createFromBuffer).toHaveBeenCalled()
    expect(capture.png?.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(capture.png?.byteLength).toBeGreaterThan(33)
    expect(Buffer.from(capture.png!).subarray(0, 8)).toEqual(png().subarray(0, 8))
    await manager.dispose()
  })

  it('拒绝非法 PNG 与超像素截图，不让不可信数据进入原生解码器', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push(state) })
    const state = await manager.control('s1', { kind: 'ensure-tab' })
    manager.present({ sessionId: 's1', tabId: state!.activeTabId!, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    const wc = electron.views[0]!.webContents
    const original = wc.debugger.sendCommand.getMockImplementation()!
    for (const data of ['not-base64!', Buffer.alloc(40).toString('base64'), png(10_000, 10_000).toString('base64')]) {
      wc.debugger.sendCommand.mockImplementation((command: string, params?: unknown) => command === 'Page.captureScreenshot'
        ? Promise.resolve({ data }) : original(command, params))
      electron.createFromBuffer.mockClear()
      await expect(manager.execute('s1', { kind: 'snapshot' })).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
      expect(electron.createFromBuffer).not.toHaveBeenCalled()
      expect(updates.at(-1)).toMatchObject({ observation: null, hasFrame: false })
    }
    await manager.dispose()
  })

  it('缩图期间页面导航不发布迟到的截图', async () => {
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(fixture(), { onState: (_id, state) => updates.push(state) })
    const state = await manager.control('s1', { kind: 'ensure-tab' })
    manager.present({ sessionId: 's1', tabId: state!.activeTabId!, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    const wc = electron.views[0]!.webContents
    const original = wc.debugger.sendCommand.getMockImplementation()!
    wc.debugger.sendCommand.mockImplementation((command: string, params?: unknown) => command === 'Page.captureScreenshot'
      ? Promise.resolve({ data: png(3000, 2000, 2 * 1024 * 1024).toString('base64') })
      : original(command, params))
    electron.createFromBuffer.mockImplementation((bytes: Buffer) => ({ isEmpty: () => false,
      getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
      resize: vi.fn((target: { width: number; height: number }) => {
        wc.events.get('did-start-navigation')?.({ isMainFrame: true } as never)
        return { toPNG: () => png(target.width, target.height), getSize: () => target }
      }),
    }))
    await expect(manager.execute('s1', { kind: 'snapshot' })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(updates.at(-1)).toMatchObject({ observation: null, hasFrame: false })
    await manager.dispose()
  })

  it('从未呈现的租约页面导航与快照仅发布 DOM，呈现后恢复原生画面', async () => {
    const window = fixture()
    const updates: unknown[] = []
    const manager = createBrowserGuestManager(window, { onState: (_id, state, capture) => updates.push({ state, capture }) })
    await manager.lease('s1')
    const first = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' }, { kind: 'none' })
    const wc = electron.views[0]!.webContents
    expect(first.observation.snapshot).toContain('Hello')
    expect(first.png).toBeNull()
    expect(updates.at(-1)).toMatchObject({ state: { hasFrame: false, observation: first.observation }, capture: undefined })
    expect(wc.debugger.sendCommand.mock.calls.some(([command]) => command === 'Page.captureScreenshot')).toBe(false)
    const target = await manager.prepare('s1')
    const second = await manager.execute('s1', { kind: 'snapshot' }, target)
    expect(second.observation.tabId).toBe(first.observation.tabId)
    expect(second.observation.revision).toBeGreaterThan(first.observation.revision)
    expect(second.png).toBeNull()
    await expect(manager.execute('s1', { kind: 'screenshot' })).rejects.toThrow('shown in the desktop workbench')
    expect(window.contentView.children).toHaveLength(0)
    manager.present({ sessionId: 's1', tabId: first.observation.tabId, visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 400 } })
    expect(window.contentView.children).toHaveLength(0)
    await manager.release('s1')
    expect(window.contentView.children).toHaveLength(1)
    await manager.lease('s1')
    expect(window.contentView.children).toHaveLength(0)
    const captured = await manager.execute('s1', { kind: 'snapshot' })
    expect(captured.observation.tabId).toBe(first.observation.tabId)
    expect(Buffer.from(captured.png!)).toEqual(png())
    expect(wc.debugger.sendCommand.mock.calls.some(([command]) => command === 'Page.captureScreenshot')).toBe(true)
    await manager.release('s1')
    await manager.dispose()
  })

  it('已呈现页面 CDP 截图卡住时仅关闭该 Session，迟到截图不能发布', async () => {
    vi.useFakeTimers()
    try {
      const updates: Array<{ sessionId: string; state: unknown; capture: unknown }> = []
      const window = fixture()
      const manager = createBrowserGuestManager(window, { onState: (sessionId, state, capture) =>
        updates.push({ sessionId, state, capture }) })
      const first = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/' })
      manager.present({ sessionId: 's1', tabId: first.observation.tabId, visible: true,
        bounds: { x: 0, y: 0, width: 500, height: 400 } })
      const independent = await manager.execute('s2', { kind: 'navigate', url: 'https://example.org/' })
      const wc = electron.views[0]!.webContents
      let complete!: (image: { data: string }) => void
      const original = wc.debugger.sendCommand.getMockImplementation()!
      wc.debugger.sendCommand.mockImplementation((command: string, params?: unknown) => command === 'Page.captureScreenshot'
        ? new Promise((resolve) => { complete = resolve }) : original(command, params))
      const pending = manager.execute('s1', { kind: 'snapshot' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(pending).rejects.toThrow('browser screenshot timed out; browser session closed')
      expect(wc.close).toHaveBeenCalledOnce()
      expect(await manager.prepare('s1')).toEqual({ kind: 'none' })
      const count = updates.length
      complete({ data: png().toString('base64') })
      await vi.advanceTimersByTimeAsync(0)
      expect(updates).toHaveLength(count)
      expect((await manager.execute('s2', { kind: 'snapshot' })).observation.tabId).toBe(independent.observation.tabId)
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it.each(['model', 'human'] as const)('%s 导航卡住但停止收敛后保留 guest，并撤销旧审批与画面', async (kind) => {
    vi.useFakeTimers()
    try {
      const manager = createBrowserGuestManager(fixture())
      const first = await manager.execute('s1', { kind: 'navigate', url: 'https://example.com/old' })
      const approved = await manager.prepare('s1')
      const wc = electron.views[0]!.webContents
      let finish!: () => void
      wc.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      wc.isLoadingMainFrame.mockReturnValue(true)
      wc.stop.mockImplementationOnce(() => { wc.isLoadingMainFrame.mockReturnValue(false); finish() })
      if (kind === 'model') await manager.lease('s1')
      const pending = kind === 'model'
        ? manager.execute('s1', { kind: 'navigate', url: 'https://example.com/slow' }, approved)
        : manager.control('s1', { kind: 'navigate', url: 'https://example.com/slow' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
      await expect(pending).rejects.toThrow('take a new snapshot')
      expect(wc.stop).toHaveBeenCalledOnce()
      expect(wc.close).not.toHaveBeenCalled()
      await expect(manager.execute('s1', { kind: 'snapshot' }, approved))
        .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
      const after = await manager.execute('s1', { kind: 'snapshot' })
      expect(after.observation.tabId).toBe(first.observation.tabId)
      expect(after.observation.revision).toBeGreaterThan(first.observation.revision)
      if (kind === 'model') await manager.release('s1')
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it.each(['stop throws', 'load never settles', 'CDP stalls'] as const)('%s 时仅关闭超时 Session，迟到结果不能写回', async (failure) => {
    vi.useFakeTimers()
    try {
      const updates: Array<{ sessionId: string; state: unknown }> = []
      const manager = createBrowserGuestManager(fixture(), { onState: (sessionId, state) => updates.push({ sessionId, state }) })
      await manager.control('s1', { kind: 'ensure-tab' })
      const independent = await manager.execute('s2', { kind: 'navigate', url: 'https://example.org/' })
      const wc = electron.views[0]!.webContents
      let finish!: () => void
      wc.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      wc.isLoadingMainFrame.mockReturnValue(true)
      if (failure === 'stop throws') wc.stop.mockImplementationOnce(() => { throw new Error('stop failed') })
      else if (failure === 'CDP stalls') {
        wc.stop.mockImplementationOnce(() => { wc.isLoadingMainFrame.mockReturnValue(false); finish() })
        wc.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}))
      } else wc.stop.mockImplementationOnce(() => { wc.isLoadingMainFrame.mockReturnValue(false) })
      const pending = manager.execute('s1', { kind: 'navigate', url: 'https://example.com/slow' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(failure === 'stop throws' ? 10_000 : 13_000)
      await expect(pending).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
      await expect(pending).rejects.toThrow('browser session closed')
      expect(wc.close).toHaveBeenCalledOnce()
      expect(await manager.prepare('s1')).toEqual({ kind: 'none' })
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(updates.at(-1)).toMatchObject({ sessionId: 's1', state: null })
      const other = await manager.execute('s2', { kind: 'snapshot' })
      expect(other.observation.tabId).toBe(independent.observation.tabId)
      await manager.dispose()
    } finally { vi.useRealTimers() }
  })
})
