import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

/** Electron 的最小替身：视图、分区 session 与私有承载窗口的真实调用都需要被观察到。 */
const electron = vi.hoisted(() => {
  const views: { view: unknown; webContents: unknown }[] = []
  const partitions = new Map<string, Record<string, unknown>>()
  const windows: unknown[] = []

  class FakeWebContents {
    destroyed = false
    windowOpenHandler: unknown
    handlers = new Map<string, ((event: unknown, ...rest: unknown[]) => void)[]>()
    debuggerMessages: ((event: unknown, method: string, params: unknown) => void)[] = []
    backgroundThrottling = true
    debugger = {
      attached: false,
      isAttached: () => this.debugger.attached,
      attach: vi.fn(() => { this.debugger.attached = true }),
      detach: vi.fn(() => { this.debugger.attached = false }),
      sendCommand: vi.fn(async (method: string) => ({ echoed: method })),
      on: vi.fn((_event: string, listener: (event: unknown, method: string, params: unknown) => void) => {
        this.debuggerMessages.push(listener)
      }),
    }
    setWindowOpenHandler = vi.fn((handler: unknown) => { this.windowOpenHandler = handler })
    on = vi.fn((event: string, handler: (event: unknown, ...rest: unknown[]) => void) => {
      const list = this.handlers.get(event) ?? []
      list.push(handler)
      this.handlers.set(event, list)
    })
    loadURL = vi.fn(async () => {})
    getURL = (): string => 'https://example.test/page'
    getTitle = (): string => '示例页面'
    isDestroyed = (): boolean => this.destroyed
    close = vi.fn(() => { this.destroyed = true })
    setBackgroundThrottling = vi.fn((value: boolean) => { this.backgroundThrottling = value })
    emit(event: string, payload: unknown, ...rest: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(payload, ...rest)
    }
    emitDebugger(method: string, params: unknown): void {
      for (const listener of this.debuggerMessages) listener({}, method, params)
    }
  }

  class WebContentsView {
    readonly webContents = new FakeWebContents()
    bounds: { x: number; y: number; width: number; height: number } | undefined
    constructor(readonly options: Record<string, unknown>) { views.push({ view: this, webContents: this.webContents }) }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void { this.bounds = bounds }
  }

  class BaseWindow {
    readonly contentView = {
      children: [] as unknown[],
      addChildView: vi.fn((view: unknown) => { this.contentView.children.push(view) }),
      removeChildView: vi.fn((view: unknown) => {
        const index = this.contentView.children.indexOf(view)
        if (index >= 0) this.contentView.children.splice(index, 1)
      }),
    }
    ignoreMouse = false
    destroyed = false
    constructor(readonly options: Record<string, unknown>) { windows.push(this) }
    setIgnoreMouseEvents = vi.fn((value: boolean) => { this.ignoreMouse = value })
    isDestroyed = (): boolean => this.destroyed
    destroy = vi.fn(() => { this.destroyed = true })
  }

  return {
    views, partitions, windows, FakeWebContents,
    electron: {
      WebContentsView,
      BaseWindow,
      app: { getPath: vi.fn(() => '/tmp/coding-ego-host-test') },
      session: {
        fromPartition: vi.fn((partition: string) => {
          const existing = partitions.get(partition)
          if (existing) return existing
          const cookies = { get: vi.fn(async () => []), set: vi.fn(async () => undefined) }
          const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
          const created_ = {
            cookies, handlers,
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
              const list = handlers.get(event) ?? []
              list.push(handler)
              handlers.set(event, list)
            }),
          }
          partitions.set(partition, created_)
          return created_
        }),
      },
    },
  }
})

vi.mock('electron', () => electron.electron)

const { createEgoPageHost } = await import('../src/ego-page-host.ts')
type EgoDownloadEvent = import('../src/ego-page-host.ts').EgoDownloadEvent

function appWindow() {
  return {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    contentView: {
      children: [] as unknown[],
      addChildView: vi.fn(function (this: { children: unknown[] }, view: unknown) { this.children.push(view) }),
      removeChildView: vi.fn(function (this: { children: unknown[] }, view: unknown) {
        const index = this.children.indexOf(view)
        if (index >= 0) this.children.splice(index, 1)
      }),
    },
  } as unknown as BrowserWindow
}

function contentsOf(view: unknown): InstanceType<typeof electron.FakeWebContents> {
  return (view as { webContents: InstanceType<typeof electron.FakeWebContents> }).webContents
}

describe('桌面 Agent 页面宿主', () => {
  beforeEach(() => {
    electron.views.length = 0
    electron.partitions.clear()
    electron.windows.length = 0
  })

  it('为每个页面建立视图、后台承载与调试会话，并把命令与事件接到页面本身', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    const page = await host.createPage(host.defaultContext(), 'https://example.test/page')
    expect(electron.views).toHaveLength(1)
    const session = electron.partitions.get('persist:ego-default')
    expect(session?.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    const stage = electron.windows.at(-1) as { contentView: { children: unknown[] } }
    expect(stage.contentView.children).toHaveLength(1)
    const pageView = stage.contentView.children[0]
    const wc = contentsOf(pageView)
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.test/page')
    expect(wc.debugger.isAttached()).toBe(true)
    expect(wc.windowOpenHandler).toEqual(expect.any(Function))
    expect((wc.windowOpenHandler as () => { action: string })()).toEqual({ action: 'deny' })
    const events: [string, unknown][] = []
    page.onEvent((method, params) => { events.push([method, params]) })
    wc.emitDebugger('Page.loadEventFired', { timestamp: 1 })
    expect(events).toEqual([['Page.loadEventFired', { timestamp: 1 }]])
    await expect(page.send('Runtime.evaluate', { expression: '1' })).resolves.toEqual({ echoed: 'Runtime.evaluate' })
    expect(page.describe()).toEqual({ url: 'https://example.test/page', title: '示例页面' })
    expect(host.list()).toHaveLength(1)
    expect(host.find(page.targetId)).toBe(page)
    host.dispose()
  })

  it('关闭页面后目录与视图同步清理，重复关闭安全', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    const page = await host.createPage(host.defaultContext(), 'about:blank')
    const wc = contentsOf(electron.views[0]?.view)
    const target = host.find(page.targetId)
    target?.close()
    expect(host.list()).toEqual([])
    expect(wc.debugger.detach).toHaveBeenCalled()
    expect(wc.close).toHaveBeenCalled()
    expect(() => { page.close() }).not.toThrow()
    host.dispose()
  })

  it('呈现只在矩形落在窗口内时把视图移进窗口，撤回时回到后台承载', async () => {
    const window = appWindow()
    const host = createEgoPageHost({ window: () => window })
    const page = await host.createPage(host.defaultContext(), 'about:blank')
    const stage = electron.windows.at(-1) as { contentView: { children: unknown[] } }
    const view = stage.contentView.children[0]
    host.present({ targetId: page.targetId, bounds: { x: 40, y: 50, width: 500, height: 400 }, visible: true })
    const content = window.contentView as unknown as { children: unknown[] }
    expect(content.children).toEqual([view])
    expect((view as { bounds?: unknown }).bounds).toEqual({ x: 40, y: 50, width: 500, height: 400 })
    expect(stage.contentView.children).toEqual([])
    const before = [...content.children]
    for (const bounds of [
      { x: -1, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 1001, height: 100 },
      { x: 0, y: 0, width: 0, height: 100 },
    ]) host.present({ targetId: page.targetId, bounds, visible: true })
    expect(content.children).toEqual(before)
    host.present({ targetId: page.targetId, bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: false })
    expect(content.children).toEqual([])
    expect(stage.contentView.children).toEqual([view])
    host.conceal()
    host.dispose()
  })

  it('按上下文关闭页面，默认上下文不可释放，Cookie 落在分区 session 上', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    const context = host.createContext()
    expect(context).not.toBe(host.defaultContext())
    const page = await host.createPage(context, 'about:blank')
    expect(host.list()).toHaveLength(1)
    host.disposeContext(context)
    expect(host.list()).toEqual([])
    host.disposeContext(host.defaultContext())
    await expect(host.getCookies(host.defaultContext())).resolves.toEqual([])
    const session = electron.partitions.get('persist:ego-default')
    expect(session?.cookies).toBeDefined()
    await host.setCookies(host.defaultContext(), [
      { name: 'sid', value: 'value', domain: '.example.test', path: '/', secure: true, httpOnly: true,
        expires: 1700000000, sameSite: 'None' },
      { name: '', value: 'x', domain: 'example.test' },
      { name: 'bad', value: 123, domain: 'example.test' },
      { name: 'nopath', value: 'x', domain: 'example.test' },
    ])
    const set = session?.cookies as { set: { mock: { calls: unknown[][] } } }
    expect(set.set.mock.calls).toHaveLength(2)
    expect(set.set.mock.calls[0]?.[0]).toMatchObject({ url: 'https://example.test/', name: 'sid',
      domain: '.example.test', secure: true, httpOnly: true, expirationDate: 1700000000, sameSite: 'no_restriction' })
    expect(set.set.mock.calls[1]?.[0]).toMatchObject({ url: 'http://example.test/', name: 'nopath', path: '/' })
    expect(page.targetId).toEqual(expect.any(String))
    host.dispose()
  })

  it('默认允许下载并直接落到应用临时目录，明确拒绝时阻止下载', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    const events: EgoDownloadEvent[] = []
    host.onDownload((event) => { events.push(event) })
    await host.createPage(host.defaultContext(), 'about:blank')
    const session = electron.partitions.get('persist:ego-default') as unknown as
      { handlers: Map<string, ((...args: unknown[]) => void)[]> }
    const handler = session.handlers.get('will-download')?.[0]
    expect(handler).toBeDefined()
    const item = {
      getFilename: () => '报告.zip',
      setSavePath: vi.fn(),
      getURL: () => 'https://example.test/报告.zip',
      getReceivedBytes: () => 1,
      getTotalBytes: () => 2,
      on: vi.fn(),
      once: vi.fn(),
    }
    const prevented = { preventDefault: vi.fn() }
    handler!(prevented, item)
    expect(prevented.preventDefault).not.toHaveBeenCalled()
    expect(item.setSavePath).toHaveBeenCalledWith('/tmp/coding-ego-host-test/coding-ego-downloads/报告.zip')
    expect(events[0]).toMatchObject({ kind: 'begin', filename: '报告.zip', url: 'https://example.test/报告.zip' })
    const updated = item.on.mock.calls.find(call => call[0] === 'updated')?.[1] as
      (event: unknown, state: string) => void
    updated({}, 'interrupted')
    expect(events.at(-1)).toMatchObject({ kind: 'progress', state: 'canceled', receivedBytes: 1, totalBytes: 2 })
    host.setDownloadBehavior(host.defaultContext(), { behavior: 'deny' })
    handler!(prevented, item)
    expect(prevented.preventDefault).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('页面自发的本地文件导航被拒绝，普通网页导航放行', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    await host.createPage(host.defaultContext(), 'about:blank')
    const wc = contentsOf(electron.views[0]?.view)
    const preventDefault = vi.fn()
    wc.emit('will-navigate', { url: 'file:///etc/passwd', isMainFrame: true, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    wc.emit('will-navigate', { url: 'https://example.test/next', isMainFrame: true, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    wc.emit('will-navigate', { url: 'about:blank', isMainFrame: true, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    wc.emit('will-redirect', { url: 'not a url', isMainFrame: true, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    host.dispose()
  })

  it('关闭全部页面后端点仍可用，Host 重建页面时再按新上下文建页', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    const context = host.createContext()
    await host.createPage(context, 'about:blank')
    await host.createPage(host.defaultContext(), 'about:blank')
    expect(host.list()).toHaveLength(2)
    host.closeAll()
    expect(host.list()).toEqual([])
    const rebuilt = host.createContext()
    expect(rebuilt).not.toBe(context)
    await expect(host.createPage(rebuilt, 'about:blank')).resolves.toBeDefined()
    expect(host.list()).toHaveLength(1)
    host.dispose()
  })

  it('卸载后不再建页，重复卸载安全', async () => {
    const host = createEgoPageHost({ window: () => appWindow() })
    await host.createPage(host.defaultContext(), 'about:blank')
    host.dispose()
    expect(() => { host.dispose() }).not.toThrow()
    await expect(host.createPage(host.defaultContext(), 'about:blank')).rejects.toThrow('page host is closed')
    const stage = electron.windows[0] as { destroy: { mock: { calls: unknown[] } } }
    expect(stage.destroy.mock.calls).toHaveLength(1)
  })
})
