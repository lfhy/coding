/** 工作台只能调整由页面宿主创建的页面位置；任何越权请求在这里拒绝。 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { EgoPageHostHandle } from './ego-page-host.ts'

const CHANNEL = 'coding:ego-present'
/** target 与 Session 之外的字段一律不接受，边界值必须是整数像素。 */
const ID = /^[a-zA-Z0-9._~-]{1,128}$/u

/** 工作台上报的页面矩形；`visible: false` 表示撤回呈现。 */
interface Presentation {
  targetId: string
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

let activeInstallation: (() => void) | undefined
let epoch = 0

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受 `{targetId, visible, bounds}` 这一种形状；缺字段与多余字段都拒绝。 */
function presentation(value: unknown, window: BrowserWindow): Presentation | undefined {
  if (!record(value) || Object.keys(value).sort().join() !== 'bounds,targetId,visible') return undefined
  const { targetId, visible, bounds } = value
  if (typeof targetId !== 'string' || !ID.test(targetId) || typeof visible !== 'boolean') return undefined
  if (!record(bounds) || Object.keys(bounds).sort().join() !== 'height,width,x,y') return undefined
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(item => typeof item === 'number' && Number.isSafeInteger(item))) return undefined
  const area = { x: x as number, y: y as number, width: width as number, height: height as number }
  if (area.x < 0 || area.y < 0 || area.width < 0 || area.height < 0) return undefined
  if (visible && (area.width < 1 || area.height < 1)) return undefined
  const content = window.getContentBounds()
  if (area.x + area.width > content.width || area.y + area.height > content.height) return undefined
  return { targetId, visible, bounds: area }
}

function hostURL(value: string, origin: string): boolean {
  if (!value.startsWith(origin) || !['/', '?', '#'].includes(value.charAt(origin.length))) return false
  try {
    const url = new URL(value)
    return url.origin === origin && url.username === '' && url.password === ''
  } catch { return false }
}

function originOf(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(value)
  return match !== null && Number(match[1]) <= 65535
}

/**
 * 授权当前窗口的 Host 主 frame 上报页面矩形。
 *
 * 呈现只影响原生视图的位置，不传递页面内容，因此这里不接触 IPC 载荷以外的东西；
 * 但越权窗口、子 frame 与跨站页面仍然一律拒绝，避免宿主的页面被别的页面搬动。
 * @returns 幂等卸载函数；窗口销毁或 Host 主 frame 换页时自动撤销。
 */
export function installEgoPresentationIpc(options: {
  window: BrowserWindow
  origin: string
  pages: EgoPageHostHandle
}): () => void {
  const { window, origin, pages } = options
  if (!originOf(origin)) throw new Error('Invalid Agent browser presentation origin')
  activeInstallation?.()
  const contents = window.webContents
  const installationEpoch = ++epoch
  let disposed = false
  let present: { targetId: string } | undefined

  const conceal = (): void => {
    const current = present
    present = undefined
    if (current === undefined) return
    try { pages.present({ targetId: current.targetId, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }) }
    catch { /* 页面可能已经被关闭。 */ }
  }

  const frameURL = (event: IpcMainInvokeEvent): string | null => {
    const sender = event.sender
    if (sender !== contents || window.isDestroyed()) return null
    const frame = event.senderFrame
    if (frame !== sender.mainFrame) return null
    const url = frame.url
    return hostURL(url, origin) ? url : null
  }

  const handler = (event: IpcMainInvokeEvent, input: unknown): void => {
    if (disposed || installationEpoch !== epoch) throw new Error('Agent browser presentation is unauthorized')
    if (frameURL(event) === null) throw new Error('Agent browser presentation is unauthorized')
    const value = presentation(input, window)
    if (value === undefined) throw new Error('Invalid Agent browser presentation')
    if (!value.visible) { conceal(); return }
    pages.present({ targetId: value.targetId, bounds: value.bounds, visible: true })
    present = { targetId: value.targetId }
  }

  ipcMain.handle(CHANNEL, handler)

  const onNavigation = (_event: unknown, ...rest: unknown[]): void => {
    const details = rest[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
    if (details?.isMainFrame === false || details?.isSameDocument === true) return
    // 换页或 reload 后旧位置不再可信：先撤下页面，等新主 frame 重新上报。
    // 每次调用都会独立复核来源，因此不需要连带撤销整次安装。
    conceal()
  }
  const onDestroyed = (): void => { dispose() }

  contents.on('did-start-navigation', onNavigation)
  window.once('closed', onDestroyed)

  function dispose(): void {
    if (disposed) return
    disposed = true
    conceal()
    ipcMain.removeHandler(CHANNEL)
    contents.removeListener('did-start-navigation', onNavigation)
    if (!window.isDestroyed()) window.removeListener('closed', onDestroyed)
    if (activeInstallation === dispose) activeInstallation = undefined
  }

  activeInstallation = dispose
  return dispose
}
