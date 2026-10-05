/** Host 主 frame 只能调整已由主进程创建的浏览器 guest 位置。 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { BrowserGuestManager, BrowserGuestPresentation } from './browser-guest.ts'

const CHANNEL = 'coding:browser-present'
const ID = /^[a-zA-Z0-9._~-]{1,128}$/u
let activeInstallation: (() => void) | undefined
let epoch = 0

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function presentation(value: unknown, window: BrowserWindow): BrowserGuestPresentation | undefined {
  if (!record(value) || Object.keys(value).sort().join() !== 'bounds,sessionId,tabId,visible' ||
    typeof value.sessionId !== 'string' || !ID.test(value.sessionId) ||
    typeof value.tabId !== 'string' || !ID.test(value.tabId) || typeof value.visible !== 'boolean' ||
    !record(value.bounds) || Object.keys(value.bounds).sort().join() !== 'height,width,x,y') return undefined
  const { x, y, width, height } = value.bounds
  if (![x, y, width, height].every(item => typeof item === 'number' && Number.isSafeInteger(item)) ||
    (x as number) < 0 || (y as number) < 0 || (width as number) < 0 || (height as number) < 0 ||
    (value.visible && ((width as number) < 1 || (height as number) < 1))) return undefined
  const bounds = window.getContentBounds()
  if ((x as number) + (width as number) > bounds.width || (y as number) + (height as number) > bounds.height) return undefined
  return value as unknown as BrowserGuestPresentation
}

function validOrigin(origin: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin)
  return match !== null && Number(match[1]) <= 65535
}

function hostURL(value: string, origin: string): boolean {
  if (!value.startsWith(origin) || !['/', '?', '#'].includes(value.charAt(origin.length))) return false
  try {
    const url = new URL(value)
    return url.origin === origin && url.username === '' && url.password === ''
  } catch { return false }
}

/**
 * 授权当前窗口的 Host 主 frame；跨站导航、reload 或 renderer 崩溃期间撤销呈现能力。
 * @returns 幂等卸载函数，窗口销毁时也自动调用。
 */
export function installBrowserIpc(options: { window: BrowserWindow; origin: string; manager: BrowserGuestManager }): () => void {
  const { window, origin, manager } = options
  if (!validOrigin(origin)) throw new Error('Invalid browser presentation Host origin')
  activeInstallation?.()
  const installationEpoch = ++epoch
  let disposed = false
  let ready = true
  let lastPresentation: BrowserGuestPresentation | undefined
  const hidePresented = (): void => {
    const previous = lastPresentation
    lastPresentation = undefined
    if (!previous) return
    // Host 重载或崩溃后 renderer 已失去 IPC 授权；由主进程直接移开旧原生视图。
    try { manager.present({ ...previous, visible: false }) } catch { /* guest 可能已经关闭。 */ }
  }
  const current = (): boolean => !window.isDestroyed() && !window.webContents.isDestroyed() &&
    !window.webContents.mainFrame.isDestroyed() && hostURL(window.webContents.mainFrame.url, origin)
  const authorized = (event: IpcMainInvokeEvent): boolean => !disposed && ready && epoch === installationEpoch &&
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && current()
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean; url: string }): void => {
    if (!details.isMainFrame || details.isSameDocument) return
    ready = false
    hidePresented()
    if (!hostURL(details.url, origin)) dispose()
  }
  const onRendererGone = (): void => {
    ready = false
    hidePresented()
  }
  const onLoaded = (): void => { if (!disposed && current()) ready = true }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    hidePresented()
    if (epoch === installationEpoch) { ++epoch; activeInstallation = undefined; ipcMain.removeHandler(CHANNEL) }
    window.webContents.removeListener('did-start-navigation', onNavigation)
    window.webContents.removeListener('render-process-gone', onRendererGone)
    window.webContents.removeListener('did-finish-load', onLoaded)
    window.webContents.removeListener('destroyed', dispose)
    window.removeListener('closed', dispose)
  }
  window.webContents.on('did-start-navigation', onNavigation)
  window.webContents.on('render-process-gone', onRendererGone)
  window.webContents.on('did-finish-load', onLoaded)
  window.webContents.on('destroyed', dispose)
  window.on('closed', dispose)
  ipcMain.handle(CHANNEL, (event, input: unknown) => {
    if (!authorized(event)) throw new Error('Browser presentation IPC unauthorized')
    const value = presentation(input, window)
    if (!value) throw new Error('Invalid browser presentation IPC request')
    manager.present(value)
    if (value.visible) lastPresentation = value
    else if (lastPresentation?.sessionId === value.sessionId && lastPresentation.tabId === value.tabId) {
      lastPresentation = undefined
    }
  })
  activeInstallation = dispose
  return dispose
}
