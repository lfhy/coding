import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Item = { label?: string; accelerator?: string; role?: string; click?: () => void; submenu?: Item[] }

const electronMock = vi.hoisted(() => {
  const state = {
    applicationMenu: null as { template: unknown[] } | null,
    tray: null as {
      setToolTip: ReturnType<typeof vi.fn>
      setContextMenu: ReturnType<typeof vi.fn<(menu: { template: Item[] }) => void>>
      destroy: ReturnType<typeof vi.fn>
    } | null,
    listeners: new Map<string, () => void>(),
    emptyIcon: false,
  }
  return {
    state,
    app: {
      show: vi.fn(), hide: vi.fn(), focus: vi.fn(), quit: vi.fn(),
      once: vi.fn((name: string, listener: () => void) => { state.listeners.set(name, listener) }),
      removeListener: vi.fn((name: string) => { state.listeners.delete(name) }),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
      setApplicationMenu: vi.fn((menu: { template: unknown[] } | null) => { state.applicationMenu = menu }),
      getApplicationMenu: vi.fn(() => state.applicationMenu),
    },
    nativeImage: {
      createFromPath: vi.fn((_path: string) => ({
        isEmpty: () => state.emptyIcon,
        resize: vi.fn((size: unknown) => ({ size })),
      })),
    },
    Tray: vi.fn(function Tray() {
      const tray = {
        setToolTip: vi.fn(), setContextMenu: vi.fn<(menu: { template: Item[] }) => void>(), destroy: vi.fn(),
      }
      state.tray = tray
      return tray
    }),
  }
})

vi.mock('electron', () => electronMock)

import { createNativeChrome } from '../src/native-chrome.ts'

const origin = 'http://127.0.0.1:43123'

function fakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(), show: vi.fn(), hide: vi.fn(), focus: vi.fn(), close: vi.fn(),
    isFullScreen: vi.fn(() => false), setFullScreen: vi.fn(),
    webContents: {
      getURL: vi.fn(() => `${origin}/`),
      executeJavaScript: vi.fn(async (_script: string) => undefined),
      reload: vi.fn(),
    },
  }
}

function item(label: string, items: Item[] = electronMock.state.applicationMenu?.template as Item[]): Item {
  const found = items.find(candidate => candidate.label === label)
  if (!found) throw new Error(`Missing menu item: ${label}`)
  return found
}

function submenu(label: string): Item[] {
  const entries = item(label).submenu
  if (!entries) throw new Error(`Missing submenu: ${label}`)
  return entries
}

function trayMenu(): Item[] {
  const tray = electronMock.state.tray
  if (!tray) throw new Error('Missing tray')
  return tray.setContextMenu.mock.calls[0]![0].template
}

describe('原生菜单和状态栏', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.clearAllMocks()
    electronMock.state.applicationMenu = null
    electronMock.state.tray = null
    electronMock.state.listeners.clear()
    electronMock.state.emptyIcon = false
  })
  afterEach(() => vi.restoreAllMocks())

  it('拒绝非精确 Host origin，且不创建菜单和托盘', () => {
    const window = fakeWindow()
    for (const invalid of ['http://localhost:43123', `${origin}/path`, 'http://127.0.0.1:0', 'https://127.0.0.1:43123']) {
      expect(() => createNativeChrome({ window: window as never, origin: invalid }), invalid).toThrow('Invalid desktop Host origin')
    }
    expect(electronMock.Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(electronMock.Tray).not.toHaveBeenCalled()
  })

  it('macOS 菜单和托盘保留中文动作、快捷键、编辑角色及图标资源', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const window = fakeWindow()
    createNativeChrome({ window: window as never, origin, iconPath: '/bundle/app-icon.png' })
    expect(electronMock.nativeImage.createFromPath).toHaveBeenCalledWith('/bundle/app-icon.png')
    expect(electronMock.Tray).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 22, height: 22 } }))
    expect(electronMock.state.tray?.setToolTip).toHaveBeenCalledWith('Coding')
    expect(trayMenu().map(entry => entry.label).filter(Boolean)).toEqual(['显示 Coding', '隐藏 Coding', '退出 Coding'])
    expect(submenu('文件')).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '新建会话', accelerator: 'CmdOrCtrl+N' }),
      expect.objectContaining({ label: '隐藏窗口', accelerator: 'CmdOrCtrl+W' }),
    ]))
    expect(submenu('视图')).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '重新加载', accelerator: 'CmdOrCtrl+R' }),
      expect.objectContaining({ label: '切换全屏', accelerator: 'CmdOrCtrl+F' }),
    ]))
    expect(submenu('编辑').filter(entry => entry.role).map(entry => entry.role)).toEqual([
      'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll',
    ])
    expect(item('关于 Coding', submenu('帮助')).click).toBeTypeOf('function')
    expect(submenu('Coding').map(entry => entry.label).filter(Boolean)).toEqual([
      '关于 Coding', '隐藏 Coding', '隐藏其他应用', '显示全部', '退出 Coding',
    ])
  })

  it('macOS 隐藏保留窗口、显示解除应用隐藏并恢复最小化窗口；退出释放状态项', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const window = fakeWindow()
    window.isMinimized.mockReturnValue(true)
    const chrome = createNativeChrome({ window: window as never, origin, iconPath: '/bundle/icon.png' })
    item('隐藏窗口', submenu('文件')).click!()
    item('隐藏 Coding', trayMenu()).click!()
    expect(electronMock.app.hide).toHaveBeenCalledTimes(2)
    expect(window.close).not.toHaveBeenCalled()
    item('显示 Coding', trayMenu()).click!()
    expect(electronMock.app.show).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(electronMock.app.focus).toHaveBeenCalledWith({ steal: true })
    item('退出 Coding', trayMenu()).click!()
    expect(electronMock.app.quit).toHaveBeenCalledOnce()
    electronMock.state.listeners.get('before-quit')!()
    expect(electronMock.state.tray?.destroy).toHaveBeenCalledOnce()
    chrome.dispose()
    expect(electronMock.state.tray?.destroy).toHaveBeenCalledOnce()
    expect(electronMock.state.applicationMenu).toBeNull()
    expect(electronMock.state.listeners.has('before-quit')).toBe(false)
  })

  it('非 macOS 不建托盘，Cmd+W 关闭窗口，后续 window-all-closed 由入口退出', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const window = fakeWindow()
    const chrome = createNativeChrome({ window: window as never, origin })
    expect(electronMock.Tray).not.toHaveBeenCalled()
    expect(submenu('文件')).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '关闭窗口', accelerator: 'CmdOrCtrl+W' }),
    ]))
    item('关闭窗口', submenu('文件')).click!()
    chrome.closeWindow()
    chrome.hideWindow()
    expect(window.close).toHaveBeenCalledTimes(3)
    expect(electronMock.app.hide).not.toHaveBeenCalled()
  })

  it('新建会话只在活着的精确 Host 页面运行固定按钮点击脚本', async () => {
    const window = fakeWindow()
    const chrome = createNativeChrome({ window: window as never, origin })
    const click = item('新建会话', submenu('文件')).click!
    for (const untrusted of [
      'http://127.0.0.1:43124/', 'http://localhost:43123/',
      'http://127.0.0.1:43123.evil.test/', 'file:///tmp/index.html',
      'http://127.0.0.1:43123@evil.test/',
    ]) {
      window.webContents.getURL.mockReturnValueOnce(untrusted)
      click()
    }
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
    click()
    const script = window.webContents.executeJavaScript.mock.calls[0]?.[0]
    expect(script).toContain('button[aria-label="新建会话"]')
    expect(script).toContain('button[aria-label="New session"]')
    expect(script).toContain('button.click()')
    expect(script).not.toContain(origin)
    window.webContents.executeJavaScript.mockRejectedValueOnce(new Error('page closed'))
    click()
    await Promise.resolve()
    window.isDestroyed.mockReturnValue(true)
    click()
    chrome.dispose()
    window.isDestroyed.mockReturnValue(false)
    click()
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('重新加载、全屏和关于操作只作用于窗口，损坏图标不留下菜单', () => {
    const window = fakeWindow()
    createNativeChrome({ window: window as never, origin })
    item('重新加载', submenu('视图')).click!()
    expect(window.webContents.reload).toHaveBeenCalledOnce()
    item('切换全屏', submenu('视图')).click!()
    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    window.isFullScreen.mockReturnValue(true)
    item('切换全屏', submenu('视图')).click!()
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)
    item('关于 Coding', submenu('帮助')).click!()
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({ title: 'Coding' }))

    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electronMock.state.emptyIcon = true
    expect(() => createNativeChrome({ window: window as never, origin, iconPath: '/broken.png' })).toThrow('Invalid macOS tray icon')
    expect(electronMock.state.applicationMenu).not.toBeNull()
    expect(electronMock.Tray).not.toHaveBeenCalled()
  })
})
