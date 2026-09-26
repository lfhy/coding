import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

const iconPath = fileURLToPath(new URL('../../desktop/packaging/icon.iconset/icon_512x512@2x.png', import.meta.url))
const expectedPreload = fileURLToPath(new URL('../src/preload.cjs', import.meta.url))

const electronMock = vi.hoisted(() => ({
  BrowserWindow: vi.fn<(options: Record<string, unknown>) => unknown>(),
  app: { dock: { setIcon: vi.fn<(image: unknown) => void>() } },
  dialog: { showErrorBox: vi.fn<(title: string, message: string) => void>() },
  nativeImage: { createFromPath: vi.fn((_path: string) => ({ isEmpty: () => false })) },
}))

vi.mock('electron', () => electronMock)

import { createHostWindow, isAllowedHostNavigation } from '../src/window.ts'

const origin = 'http://127.0.0.1:43123'

function fakeWindow() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const windowListeners = new Map<string, (...args: unknown[]) => void>()
  const permissions = {
    setPermissionRequestHandler: vi.fn<(
      handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
    ) => void>(),
    setPermissionCheckHandler: vi.fn<(handler: () => boolean) => void>(),
  }
  const webContents = {
    session: permissions,
    setWindowOpenHandler: vi.fn<(handler: () => { action: 'deny' }) => void>(),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      listeners.set(name, listener)
    }),
    getURL: vi.fn(() => `${origin}/`),
    insertCSS: vi.fn(async () => 'injected-css-key'),
  }
  const window = {
    webContents,
    loadURL: vi.fn(async () => undefined),
    maximize: vi.fn(),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      windowListeners.set(name, listener)
    }),
    close: vi.fn(), destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  electronMock.BrowserWindow.mockImplementation(function BrowserWindow() { return window })
  return { listeners, windowListeners, permissions, webContents, window }
}

function navigationPrevented(listener: (...args: unknown[]) => void, target: string, framed = false): boolean {
  const event = { url: target, isMainFrame: !framed, preventDefault: vi.fn() }
  listener(event)
  return event.preventDefault.mock.calls.length > 0
}

function emitLoadFailure(fixture: ReturnType<typeof fakeWindow>, errorCode: number, isMainFrame: boolean): void {
  fixture.listeners.get('did-fail-load')!({}, errorCode, 'secret error description', `${origin}/?secret=private`, isMainFrame, 1, 1)
}

describe('Host 窗口导航边界', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('只允许精确的 Host 字面地址及其路径', () => {
    expect(isAllowedHostNavigation(origin, `${origin}/`)).toBe(true)
    expect(isAllowedHostNavigation(origin, `${origin}/session?id=1#anchor`)).toBe(true)
    expect(isAllowedHostNavigation(origin, `${origin}?x=1`)).toBe(true)
    for (const target of [
      'https://127.0.0.1:43123/',
      'http://127.0.0.1:43124/',
      'http://localhost:43123/',
      'http://127.1:43123/',
      'http://0x7f000001:43123/',
      'http://127.0.0.1:43123.evil.test/',
      'http://127.0.0.1:43123@evil.test/',
      'javascript:alert(1)',
      'file:///tmp/index.html',
      '/relative',
    ]) {
      expect(isAllowedHostNavigation(origin, target), target).toBe(false)
    }
  })

  it('先拒绝伪造的 Host origin，不创建窗口', () => {
    for (const invalid of [
      'http://localhost:43123',
      'http://127.1:43123',
      'http://127.0.0.1:43123/',
      'http://127.0.0.1:43123/path',
      'http://127.0.0.1:43123?x=1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'https://127.0.0.1:43123',
    ]) {
      expect(() => createHostWindow(invalid), invalid).toThrow('Invalid desktop Host origin')
    }
    expect(electronMock.BrowserWindow).not.toHaveBeenCalled()
  })

  it('关闭 renderer 能力、弹窗、权限与非 Host 导航', () => {
    const fixture = fakeWindow()
    expect(createHostWindow(origin)).toBe(fixture.window)
    expect(electronMock.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        preload: expectedPreload,
      },
    }))
    expect(fixture.window.loadURL).toHaveBeenCalledWith(`${origin}/`)
    expect(fixture.window.maximize).toHaveBeenCalledOnce()
    expect(fixture.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const requestHandler = fixture.permissions.setPermissionRequestHandler.mock.calls[0]?.[0]
    if (!requestHandler) throw new Error('Permission request handler was not registered')
    const permissionCallback = vi.fn()
    requestHandler(fixture.webContents, 'media', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
    expect(fixture.permissions.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)

    const navigate = fixture.listeners.get('will-navigate')!
    expect(navigationPrevented(navigate, `${origin}/other`)).toBe(false)
    expect(navigationPrevented(navigate, 'https://example.com/')).toBe(true)
    expect(navigationPrevented(navigate, 'http://127.0.0.1:43124/')).toBe(true)
    for (const name of ['will-frame-navigate', 'will-redirect']) {
      const listener = fixture.listeners.get(name)!
      expect(navigationPrevented(listener, `${origin}/frame`, true)).toBe(false)
      expect(navigationPrevented(listener, 'https://example.com/', true)).toBe(true)
    }
  })

  it('按显式选项开启 DevTools，且只为受信页面每次注入 macOS 避让值', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const fixture = fakeWindow()
    createHostWindow(origin, { devTools: true, iconPath })
    expect(electronMock.BrowserWindow.mock.calls[0]?.[0]).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 15 },
      webPreferences: { devTools: true },
    })
    expect(electronMock.nativeImage.createFromPath).toHaveBeenCalledWith(expect.stringContaining('icon_512x512@2x.png'))
    expect(electronMock.app.dock.setIcon).toHaveBeenCalledWith(electronMock.nativeImage.createFromPath.mock.results[0]?.value)
    const domReady = fixture.listeners.get('dom-ready')!
    domReady()
    domReady()
    expect(fixture.webContents.insertCSS).toHaveBeenCalledTimes(2)
    expect(fixture.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('--app-safe-area-inset-top: 38px'))
    expect(fixture.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('[data-window-drag-region] { -webkit-app-region: drag !important; }'))
    fixture.webContents.getURL.mockReturnValue('http://127.0.0.1:43124/')
    domReady()
    expect(fixture.webContents.insertCSS).toHaveBeenCalledTimes(2)
  })

  it('Windows 由原生 caption overlay 管理右上角避让', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const fixture = fakeWindow()
    createHostWindow(origin)
    expect(electronMock.BrowserWindow.mock.calls[0]?.[0]).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 40 },
    })
    fixture.listeners.get('dom-ready')!()
    expect(fixture.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('--app-safe-area-inset-right: 138px'))
    expect(fixture.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('[data-window-drag-region] { -webkit-app-region: drag !important; }'))
  })

  it('有原生标题栏的 Linux 不把页面顶栏变成拖拽区域', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const fixture = fakeWindow()
    createHostWindow(origin)
    fixture.listeners.get('dom-ready')!()
    expect(fixture.webContents.insertCSS).toHaveBeenCalledWith(expect.not.stringContaining('[data-window-drag-region]'))
  })

  it('Dock 图标失败仍加载 Host 页面，诊断不泄露底层错误', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electronMock.app.dock.setIcon.mockImplementationOnce(() => {
      throw new Error('sensitive image path')
    })
    const fixture = fakeWindow()
    expect(createHostWindow(origin, { iconPath })).toBe(fixture.window)
    expect(fixture.window.loadURL).toHaveBeenCalledWith(`${origin}/`)
    expect(warning).toHaveBeenCalledWith('Coding Dock 图标加载失败，继续加载 Host 页面。')
    expect(warning.mock.calls.flat().join(' ')).not.toContain('sensitive image path')
  })

  it('Host 首次加载失败会显示不包含连接信息的诊断', async () => {
    const fixture = fakeWindow()
    fixture.window.loadURL.mockRejectedValueOnce(new Error('secret-token?key=private'))
    createHostWindow(origin)
    await vi.waitFor(() => {
      expect(electronMock.dialog.showErrorBox).toHaveBeenCalledTimes(1)
    })
    const [title, message] = electronMock.dialog.showErrorBox.mock.calls[0]!
    expect(`${title} ${message}`).toContain('Host 页面无法加载')
    expect(`${title} ${message}`).not.toMatch(/secret-token|private|127\.0\.0\.1/)
    expect(fixture.window.destroy).toHaveBeenCalledTimes(1)
  })

  it('页面已加载后主 frame 再失败也显示诊断并关闭白屏窗口', async () => {
    const fixture = fakeWindow()
    createHostWindow(origin)
    await Promise.resolve()
    emitLoadFailure(fixture, -105, true)
    expect(electronMock.dialog.showErrorBox).toHaveBeenCalledTimes(1)
    expect(fixture.window.destroy).toHaveBeenCalledTimes(1)
    expect(electronMock.dialog.showErrorBox.mock.calls[0]?.join(' ')).not.toMatch(/secret|private|127\.0\.0\.1/)
  })

  it('正常取消和子 frame 失败不误报', async () => {
    const fixture = fakeWindow()
    createHostWindow(origin)
    await Promise.resolve()
    emitLoadFailure(fixture, -3, true)
    emitLoadFailure(fixture, -105, false)
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(fixture.window.destroy).not.toHaveBeenCalled()
  })

  it('首次失败的事件和 loadURL rejection 只显示一次诊断', async () => {
    const fixture = fakeWindow()
    fixture.window.loadURL.mockRejectedValueOnce(new Error('secret failure'))
    createHostWindow(origin)
    emitLoadFailure(fixture, -105, true)
    await Promise.resolve()
    expect(electronMock.dialog.showErrorBox).toHaveBeenCalledTimes(1)
    expect(fixture.window.destroy).toHaveBeenCalledTimes(1)
  })

  it('首次加载被正常取消时 rejection 不显示错误', async () => {
    const fixture = fakeWindow()
    fixture.window.loadURL.mockRejectedValueOnce(new Error('ERR_ABORTED (-3)'))
    createHostWindow(origin)
    emitLoadFailure(fixture, -3, true)
    await Promise.resolve()
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(fixture.window.destroy).not.toHaveBeenCalled()
  })

  it('关闭中的加载取消不弹出误报', async () => {
    const fixture = fakeWindow()
    fixture.window.loadURL.mockRejectedValueOnce(new Error('ERR_ABORTED'))
    createHostWindow(origin)
    fixture.windowListeners.get('close')!({ defaultPrevented: false })
    await Promise.resolve()
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('macOS 拦截关闭并隐藏后仍能报告后续 Host 加载失败', async () => {
    const fixture = fakeWindow()
    createHostWindow(origin)
    const event = { defaultPrevented: false }
    fixture.windowListeners.get('close')!(event)
    event.defaultPrevented = true
    await Promise.resolve()
    emitLoadFailure(fixture, -105, true)
    expect(electronMock.dialog.showErrorBox).toHaveBeenCalledOnce()
    expect(fixture.window.destroy).toHaveBeenCalledOnce()
  })
})
