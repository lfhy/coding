/**
 * 工作台下载列表的 IPC。
 *
 * 主进程把下载的开始与进度推给 Host 页面，Host 页面只能读取列表并对某一项执行
 * 取消、另存为、打开或显示位置；每次调用都复核来源与目标，越权请求一律拒绝。
 */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { EgoDownloadEvent, EgoPageHostHandle } from './ego-page-host.ts'

const CHANNEL = 'coding:ego-downloads'
/** 主进程向页面推送下载状态的通道；载荷只有下载记录本身。 */
export const EGO_DOWNLOADS_EVENT = 'coding:ego-downloads-event'
const ID = /^[a-zA-Z0-9._~-]{1,128}$/u

/** 页面可以发起的四种下载操作。 */
type DownloadRequest =
  | { action: 'list' }
  | { action: 'cancel' | 'save' | 'reveal' | 'open'; id: string }

let activeInstallation: (() => void) | undefined

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格按动作校验载荷：多余字段、未知动作与非法标识都拒绝。 */
function parseRequest(value: unknown): DownloadRequest | undefined {
  if (!record(value)) return undefined
  const keys = Object.keys(value).sort().join()
  if (value.action === 'list') return keys === 'action' ? { action: 'list' } : undefined
  const { action } = value
  if (action !== 'cancel' && action !== 'save' && action !== 'reveal' && action !== 'open') return undefined
  if (keys !== 'action,id' || typeof value.id !== 'string' || !ID.test(value.id)) return undefined
  return { action, id: value.id }
}

function originOf(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(value)
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
 * 授权当前窗口操作下载列表。
 * @param options.window 承载 Host 页面的窗口。
 * @param options.origin Host 的回环 origin。
 * @param options.pages 页面宿主，下载记录与动作都由它持有。
 * @returns 幂等卸载函数；窗口销毁时也会自动卸载。
 */
export function installEgoDownloadsIpc(options: {
  window: BrowserWindow
  origin: string
  pages: EgoPageHostHandle
}): () => void {
  const { window, origin, pages } = options
  if (!originOf(origin)) throw new Error('Invalid Agent download origin')
  activeInstallation?.()
  const contents = window.webContents
  let disposed = false

  const authorized = (event: IpcMainInvokeEvent): boolean => {
    if (disposed || window.isDestroyed() || contents.isDestroyed() || event.sender !== contents) return false
    const frame = event.senderFrame
    if (frame !== contents.mainFrame) return false
    return hostURL(frame.url, origin)
  }

  const handler = async (event: IpcMainInvokeEvent, input: unknown): Promise<unknown> => {
    if (!authorized(event)) throw new Error('Agent download operation is unauthorized')
    const request = parseRequest(input)
    if (request === undefined) throw new Error('Invalid Agent download request')
    if (request.action === 'list') return { ok: true, downloads: pages.downloads() }
    const target = pages.downloads().find(item => item.id === request.id)
    if (target === undefined) return { ok: false }
    if (request.action === 'cancel') return { ok: pages.cancelDownload(request.id) }
    if (request.action === 'reveal') { shell.showItemInFolder(target.path); return { ok: true } }
    if (request.action === 'open') return { ok: (await shell.openPath(target.path)) === '' }
    // 系统保存对话框只给默认位置：标题与按钮交给操作系统本地化。
    const choice = await dialog.showSaveDialog(window, { defaultPath: target.path })
    if (choice.canceled || choice.filePath.length === 0) {
      return { ok: false, canceled: true }
    }
    const path = await pages.saveDownload(request.id, choice.filePath)
    return { ok: true, path }
  }

  const unsubscribe = pages.onDownload((payload: EgoDownloadEvent) => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()) return
    contents.send(EGO_DOWNLOADS_EVENT, payload)
  })
  ipcMain.handle(CHANNEL, handler)

  function dispose(): void {
    if (disposed) return
    disposed = true
    unsubscribe()
    ipcMain.removeHandler(CHANNEL)
    if (!window.isDestroyed()) window.removeListener('closed', dispose)
    if (activeInstallation === dispose) activeInstallation = undefined
  }

  window.once('closed', dispose)
  activeInstallation = dispose
  return dispose
}
