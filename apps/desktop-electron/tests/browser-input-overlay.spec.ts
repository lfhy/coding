import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createBrowserInputOverlay } from '../src/browser-input-overlay.ts'

const native = vi.hoisted(() => ({ html: '', view: undefined as unknown as {
  setBounds: ReturnType<typeof vi.fn>
  webContents: {
    focus: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    events: Map<string, (event: { preventDefault(): void }) => void>
  }
} }))
vi.mock('electron', () => ({
  WebContentsView: class {
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    webContents = {
      focus: vi.fn(), close: vi.fn(), isDestroyed: vi.fn(() => false),
      events: new Map<string, (event: { preventDefault(): void }) => void>(),
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
      on: (name: string, callback: (event: { preventDefault(): void }) => void) => {
        this.webContents.events.set(name, callback)
      },
      loadURL: async (url: string) => { native.html = decodeURIComponent(url.split(',').slice(1).join(',')) },
    }
    constructor() { native.view = this }
  },
}))

/** 宿主窗口替身：`focused` 可改，用来模拟用户把窗口切回前台。 */
function host(focused = true) {
  const hostState = { focused }
  const listeners = new Map<string, () => void>()
  const children: unknown[] = []
  const window = {
    isDestroyed: () => false,
    isFocused: () => hostState.focused,
    on: (name: string, listener: () => void) => { listeners.set(name, listener) },
    removeListener: (name: string) => { listeners.delete(name) },
    contentView: { children,
      addChildView: (view: unknown) => { children.push(view) },
      removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1) },
    },
  }
  return { window: window as unknown as BrowserWindow, hostState, listeners, children }
}

describe('原生输入屏障', () => {
  it('只透明拦截人工输入，不绘制指针或轨迹，并在租约结束时卸载', async () => {
    const desktop = host()
    const overlay = createBrowserInputOverlay(desktop.window, vi.fn())
    await overlay.ready
    expect(native.html).toContain('background:transparent')
    expect(native.html).not.toContain('id="pointer"')
    expect(native.html).not.toContain('id="trail"')
    expect(native.html).not.toContain('<script')
    overlay.attach({ x: 20, y: 30, width: 500, height: 400 })
    expect(native.view.setBounds).toHaveBeenCalledWith({ x: 20, y: 30, width: 500, height: 400 })
    expect(desktop.children).toHaveLength(1)
    expect(native.view.webContents.focus).toHaveBeenCalledOnce()
    for (const name of ['before-mouse-event', 'before-input-event']) {
      const event = { preventDefault: vi.fn() }
      native.view.webContents.events.get(name)?.(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    overlay.close()
    expect(desktop.children).toHaveLength(0)
    expect(native.view.webContents.close).toHaveBeenCalledOnce()
    expect(desktop.listeners.size).toBe(0)
  })

  it('宿主窗口在后台时不抢系统焦点，切回前台才接管键盘', async () => {
    const desktop = host(false)
    const overlay = createBrowserInputOverlay(desktop.window, vi.fn())
    await overlay.ready
    overlay.attach({ x: 0, y: 0, width: 500, height: 400 })
    // 后台运行不移交焦点：macOS 上 webContents.focus() 会把宿主窗口置前并激活应用。
    expect(native.view.webContents.focus).not.toHaveBeenCalled()
    expect(desktop.children).toHaveLength(1)
    desktop.hostState.focused = true
    desktop.listeners.get('focus')?.()
    expect(native.view.webContents.focus).toHaveBeenCalledOnce()
    overlay.attach({ x: 0, y: 0, width: 500, height: 400 })
    expect(native.view.webContents.focus).toHaveBeenCalledTimes(2)
    overlay.close()
    expect(desktop.listeners.size).toBe(0)
  })
})
