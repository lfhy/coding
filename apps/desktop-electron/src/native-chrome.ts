/**
 * 桌面原生菜单与 macOS 状态栏入口；只对主进程持有的 Host 窗口执行固定动作。
 * @module @deepseek-ai/dsh-desktop-electron/native-chrome
 */

import { app, dialog, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { isAllowedHostNavigation } from './window.ts'

const newSessionScript = `(() => {
  const button = document.querySelector('button[aria-label="新建会话"], button[aria-label="New session"], button[aria-label="New Session"]');
  if (button instanceof HTMLButtonElement) button.click();
})()`

/** 原生入口仅接收已由主进程创建并验证的窗口，不向页面提供原生调用接口。 */
export interface NativeChromeOptions {
  window: BrowserWindow
  origin: string
  /** macOS 状态栏图标的绝对路径，由开发或打包入口提供。 */
  iconPath?: string
}

/** 主进程持有该句柄直到窗口关闭或应用退出；dispose 可重复调用。 */
export interface NativeChrome {
  showWindow(): void
  hideWindow(): void
  closeWindow(): void
  dispose(): void
}

/**
 * 注册平台菜单与 macOS 托盘，托盘引用和退出清理由返回的句柄持有。
 * @param options 已验证的 Host origin、窗口及 macOS 状态栏图标路径。
 * @returns 仅包含窗口动作与清理操作的主进程句柄。
 */
export function createNativeChrome({ window, origin, iconPath }: NativeChromeOptions): NativeChrome {
  if (!isAllowedHostNavigation(origin, `${origin}/`)) throw new Error('Invalid desktop Host origin')
  const isMacOS = process.platform === 'darwin'
  if (isMacOS && !iconPath) throw new Error('macOS tray iconPath is required')

  let disposed = false
  const showWindow = () => {
    if (disposed || window.isDestroyed()) return
    if (isMacOS) app.show()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    if (isMacOS) app.focus({ steal: true })
  }
  const hideWindow = () => {
    if (disposed || window.isDestroyed()) return
    if (isMacOS) app.hide()
    else window.close()
  }
  const closeWindow = () => {
    hideWindow()
  }
  const newSession = () => {
    if (disposed || window.isDestroyed()) return
    // Origin 在回调时再次核验：菜单的生命周期可长于页面的一次导航。
    if (!isAllowedHostNavigation(origin, window.webContents.getURL())) return
    void window.webContents.executeJavaScript(newSessionScript).catch(() => undefined)
  }
  const reload = () => {
    if (!disposed && !window.isDestroyed()) window.webContents.reload()
  }
  const toggleFullscreen = () => {
    if (!disposed && !window.isDestroyed()) window.setFullScreen(!window.isFullScreen())
  }
  const about = () => {
    if (disposed || window.isDestroyed()) return
    void dialog.showMessageBox(window, {
      type: 'info', title: 'Coding', message: 'Coding 桌面客户端', buttons: ['好'],
    })
  }

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑', submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '粘贴并匹配样式', role: 'pasteAndMatchStyle' },
      { label: '删除', role: 'delete' },
      { label: '全选', role: 'selectAll' },
    ],
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMacOS ? [{ label: 'Coding', submenu: [
      { label: '关于 Coding', click: about },
      { type: 'separator' as const },
      { label: '隐藏 Coding', role: 'hide' as const },
      { label: '隐藏其他应用', role: 'hideOthers' as const },
      { label: '显示全部', role: 'unhide' as const },
      { type: 'separator' as const },
      { label: '退出 Coding', click: () => { app.quit() } },
    ] }] : []),
    { label: '文件', submenu: [
      { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: newSession },
      { type: 'separator' },
      { label: isMacOS ? '隐藏窗口' : '关闭窗口', accelerator: 'CmdOrCtrl+W', click: closeWindow },
    ] },
    editMenu,
    { label: '视图', submenu: [
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: reload },
      { label: '切换全屏', accelerator: 'CmdOrCtrl+F', click: toggleFullscreen },
    ] },
    { label: '窗口', submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '缩放', role: 'zoom' },
    ] },
    { label: '帮助', submenu: [{ label: '关于 Coding', click: about }] },
  ]

  const previousMenu = Menu.getApplicationMenu()
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  let tray: Tray | undefined
  try {
    if (isMacOS) {
      const image = nativeImage.createFromPath(iconPath as string)
      if (image.isEmpty()) throw new Error('Invalid macOS tray icon')
      tray = new Tray(image.resize({ width: 22, height: 22 }))
      tray.setToolTip('Coding')
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示 Coding', click: showWindow },
        { label: '隐藏 Coding', click: hideWindow },
        { type: 'separator' },
        { label: '退出 Coding', click: () => { app.quit() } },
      ]))
    }
  } catch (error) {
    tray?.destroy()
    Menu.setApplicationMenu(previousMenu)
    throw error
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    tray?.destroy()
    tray = undefined
    if (Menu.getApplicationMenu() === menu) Menu.setApplicationMenu(previousMenu)
    app.removeListener('before-quit', dispose)
  }
  app.once('before-quit', dispose)
  return { showWindow, hideWindow, closeWindow, dispose }
}
