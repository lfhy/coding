import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { createBrowserCursorOverlay } from '../src/browser-cursor-overlay.ts'

const native = vi.hoisted(() => ({
  windows: [] as Array<ReturnType<typeof createWindow>>,
  views: [] as Array<ReturnType<typeof createView>>,
  BaseWindow: vi.fn<(options: Record<string, unknown>) => unknown>(),
  WebContentsView: vi.fn<(options: Record<string, unknown>) => unknown>(),
}))

function createWindow() {
  const emitter = new EventEmitter()
  let destroyed = false
  let visible = false
  return Object.assign(emitter, {
    contentView: { addChildView: vi.fn() },
    setIgnoreMouseEvents: vi.fn(), setBounds: vi.fn(), showInactive: vi.fn(() => { visible = true }),
    hide: vi.fn(() => { visible = false }),
    destroy: vi.fn(() => { destroyed = true; emitter.emit('closed') }),
    isDestroyed: vi.fn(() => destroyed), isVisible: vi.fn(() => visible),
  })
}

function createView() {
  const emitter = new EventEmitter()
  let destroyed = false
  const session = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn(),
  }
  const webContents = Object.assign(emitter, {
    session,
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<undefined>>(async () => undefined),
    close: vi.fn(() => { destroyed = true; emitter.emit('destroyed') }),
    isDestroyed: vi.fn(() => destroyed),
  })
  return { webContents, setBackgroundColor: vi.fn(), setBounds: vi.fn() }
}

vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.WebContentsView }))

function parent() {
  const emitter = new EventEmitter()
  let visible = true
  let destroyed = false
  let bounds = { x: 100, y: 200, width: 800, height: 600 }
  return Object.assign(emitter, {
    getContentBounds: vi.fn(() => bounds),
    move: (x: number, y: number) => { bounds = { ...bounds, x, y }; emitter.emit('move') },
    hide: () => { visible = false; emitter.emit('hide') },
    show: () => { visible = true; emitter.emit('show') },
    destroy: () => { destroyed = true; emitter.emit('closed') },
    isVisible: () => visible,
    isDestroyed: () => destroyed,
  }) as unknown as BrowserWindow & { move(x: number, y: number): void; hide(): void; show(): void; destroy(): void }
}

beforeEach(() => {
  vi.clearAllMocks()
  native.windows.length = 0
  native.views.length = 0
  native.BaseWindow.mockImplementation(function () {
    const win = createWindow()
    native.windows.push(win)
    return win
  })
  native.WebContentsView.mockImplementation(function () {
    const view = createView()
    native.views.push(view)
    return view
  })
})

describe('独立原生指针显示层', () => {
  it('仅在静态文档就绪后无焦点展示；点击永久穿透，随宿主移动并手工销毁视图进程', async () => {
    const host = parent()
    const pointer = createBrowserCursorOverlay(host)
    const win = native.windows[0]!
    const view = native.views[0]!
    expect(native.BaseWindow.mock.calls[0]?.[0]).toMatchObject({
      parent: host, show: false, frame: false, transparent: true, focusable: false,
    })
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledOnce()
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    expect(view.webContents.session.setPermissionCheckHandler).toHaveBeenCalled()
    const uri = view.webContents.loadURL.mock.calls[0]?.[0]
    if (!uri) throw new Error('cursor document not loaded')
    expect(uri).toContain('data:text/html')
    const html = decodeURIComponent(uri.split(',').slice(1).join(','))
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
    pointer.show({ bounds: { x: 40, y: 50, width: 300, height: 240 }, point: { x: 20, y: 30 } })
    await vi.waitFor(() => { expect(win.showInactive).toHaveBeenCalledOnce() })
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 160, y: 280, width: 36, height: 36 })
    host.move(300, 400)
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 360, y: 480, width: 36, height: 36 })
    pointer.show({ bounds: { x: 40, y: 50, width: 300, height: 240 }, point: { x: 299, y: 239 } })
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 639, y: 689, width: 1, height: 1 })
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1, height: 1 })
    pointer.dispose()
    pointer.dispose()
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(host.listenerCount('move')).toBe(0)
    expect(pointer.alive).toBe(false)
  })

  it('宿主隐藏期间不延迟重显；恢复、子窗口意外关闭和视图崩溃均回收资源', async () => {
    const host = parent()
    host.hide()
    const pointer = createBrowserCursorOverlay(host)
    pointer.show({ bounds: { x: 0, y: 0, width: 500, height: 400 }, point: { x: 40, y: 50 } })
    await Promise.resolve()
    expect(native.windows[0]!.showInactive).not.toHaveBeenCalled()
    host.show()
    expect(native.windows[0]!.showInactive).toHaveBeenCalledOnce()
    host.hide()
    expect(native.windows[0]!.hide).toHaveBeenCalledOnce()
    host.show()
    expect(native.windows[0]!.showInactive).toHaveBeenCalledTimes(2)
    native.windows[0]!.emit('closed')
    expect(pointer.alive).toBe(false)
    expect(native.views[0]!.webContents.close).toHaveBeenCalledOnce()
    expect(host.listenerCount('show')).toBe(0)

    const second = createBrowserCursorOverlay(host)
    second.show({ bounds: { x: 0, y: 0, width: 500, height: 400 }, point: { x: 40, y: 50 } })
    native.views[1]!.webContents.emit('render-process-gone')
    expect(second.alive).toBe(false)
    expect(native.views[1]!.webContents.close).toHaveBeenCalledOnce()
    expect(native.windows[1]!.destroy).toHaveBeenCalledOnce()
  })

  it('视图构造、加载失败或就绪前销毁不留下孤儿窗口与 webContents', async () => {
    const host = parent()
    native.WebContentsView.mockImplementationOnce(function () { throw new Error('view failed') })
    expect(() => createBrowserCursorOverlay(host)).toThrow('view failed')
    expect(native.windows[0]!.destroy).toHaveBeenCalledOnce()
    const deferred = Promise.withResolvers<undefined>()
    native.WebContentsView.mockImplementationOnce(function () {
      const view = createView()
      view.webContents.loadURL.mockReturnValueOnce(deferred.promise)
      native.views.push(view)
      return view
    })
    const pointer = createBrowserCursorOverlay(host)
    pointer.show({ bounds: { x: 0, y: 0, width: 500, height: 400 }, point: { x: 40, y: 50 } })
    pointer.dispose()
    deferred.resolve(undefined)
    await Promise.resolve()
    expect(native.windows[1]!.showInactive).not.toHaveBeenCalled()
    expect(native.views[0]!.webContents.close).toHaveBeenCalledOnce()

    native.WebContentsView.mockImplementationOnce(function () {
      const view = createView()
      view.webContents.loadURL.mockRejectedValueOnce(new Error('failed to load'))
      native.views.push(view)
      return view
    })
    const rejected = createBrowserCursorOverlay(host)
    rejected.show({ bounds: { x: 0, y: 0, width: 500, height: 400 }, point: { x: 40, y: 50 } })
    await vi.waitFor(() => { expect(rejected.alive).toBe(false) })
    expect(native.views[1]!.webContents.close).toHaveBeenCalledOnce()
    expect(native.windows[2]!.showInactive).not.toHaveBeenCalled()
  })
})
