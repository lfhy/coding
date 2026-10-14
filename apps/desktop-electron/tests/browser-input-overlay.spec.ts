import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createBrowserInputOverlay } from '../src/browser-input-overlay.ts'

const native = vi.hoisted(() => ({ html: '', view: undefined as unknown as {
  setBounds: ReturnType<typeof vi.fn>
  webContents: {
    focus: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
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

describe('原生输入屏障', () => {
  it('只透明拦截人工输入，不绘制指针或轨迹，并在租约结束时卸载', async () => {
    const children: unknown[] = []
    const window = { isDestroyed: () => false,
      contentView: { children,
        addChildView: (view: unknown) => { children.push(view) },
        removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1) },
      } } as unknown as BrowserWindow
    const overlay = createBrowserInputOverlay(window, vi.fn())
    await overlay.ready
    expect(native.html).toContain('background:transparent')
    expect(native.html).not.toContain('id="pointer"')
    expect(native.html).not.toContain('id="trail"')
    expect(native.html).not.toContain('<script')
    overlay.attach({ x: 20, y: 30, width: 500, height: 400 })
    expect(native.view.setBounds).toHaveBeenCalledWith({ x: 20, y: 30, width: 500, height: 400 })
    expect(children).toHaveLength(1)
    expect(native.view.webContents.focus).toHaveBeenCalledOnce()
    for (const name of ['before-mouse-event', 'before-input-event']) {
      const event = { preventDefault: vi.fn() }
      native.view.webContents.events.get(name)?.(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    overlay.close()
    expect(children).toHaveLength(0)
    expect(native.view.webContents.close).toHaveBeenCalledOnce()
  })
})
