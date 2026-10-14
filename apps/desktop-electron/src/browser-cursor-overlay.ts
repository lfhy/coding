/** Electron 主进程独占的常驻指针显示层；与按租约创建的输入屏障分离。 */
import { randomUUID } from 'node:crypto'
import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron'
import { POINTER_PATH, POINTER_TIP } from './browser-input-overlay.ts'

const SIZE = 36

const document = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
#pointer { width:32px; height:32px; overflow:visible; filter:drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
#pointer path { fill:rgba(44,44,44,.9); stroke:rgba(255,255,255,.85); stroke-width:28; stroke-linejoin:round; paint-order:stroke fill; }
</style><svg id="pointer" viewBox="0 0 1024 1024"><path transform="translate(${-POINTER_TIP.x} ${-POINTER_TIP.y})" d="${POINTER_PATH}"/></svg>`

/** guest 在宿主内容区内的矩形，以及指针在 guest 视口内的 CSS 坐标。 */
export interface CursorPlacement {
  bounds: { x: number; y: number; width: number; height: number }
  point: { x: number; y: number }
}

/**
 * 创建原生点击穿透的指针窗口。调用方在页面不再呈现时负责 dispose；
 * 加载失败只移除指针，不可替代租约期间的输入屏障。
 * @param parent - 拥有 guest 的宿主窗口。
 * @returns 更新位置、查询存活及销毁指针窗口的操作。
 */
export function createBrowserCursorOverlay(parent: BrowserWindow) {
  const window = new BaseWindow({ parent, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', focusable: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false })
  const view = (() => {
    try {
      return new WebContentsView({ webPreferences: {
        partition: `dsh-browser-cursor-${randomUUID()}`, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
      } })
    } catch (error) {
      try { window.destroy() } catch { /* 构造失败的窗口可能已经不可用。 */ }
      throw error
    }
  })()
  const wc = view.webContents
  let closed = false
  let loaded = false
  let shown = false
  let hidden = false
  let current: CursorPlacement | undefined
  let lastBounds: { x: number; y: number; width: number; height: number } | undefined
  const position = (): boolean => {
    if (closed || !current || parent.isDestroyed() || window.isDestroyed()) return false
    const { bounds, point } = current
    if (bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    const x = Math.min(Math.max(point.x, 0), bounds.width - 1)
    const y = Math.min(Math.max(point.y, 0), bounds.height - 1)
    const content = parent.getContentBounds()
    const next = { x: content.x + bounds.x + x, y: content.y + bounds.y + y,
      width: Math.min(SIZE, bounds.width - x), height: Math.min(SIZE, bounds.height - y) }
    if (lastBounds && Object.keys(next).every(key => next[key as keyof typeof next] ===
      lastBounds?.[key as keyof typeof next])) return true
    window.setBounds(next)
    view.setBounds({ x: 0, y: 0, width: next.width, height: next.height })
    lastBounds = next
    return true
  }
  const clean = (run: () => void): void => { try { run() } catch { /* 展示层失败不应影响 guest。 */ } }
  const onPosition = (): void => { try { position() } catch { dispose() } }
  const hideWithParent = (): void => {
    hidden = true
    if (shown && !closed && !window.isDestroyed()) {
      try { window.hide() } catch { dispose() }
    }
  }
  const showIfReady = (): void => {
    if (closed || !loaded || !current || parent.isDestroyed() || window.isDestroyed() || hidden || !parent.isVisible()) return
    let valid = false
    try { valid = position() } catch { dispose(); return }
    if (!valid || (shown && window.isVisible())) return
    try {
      window.showInactive()
      shown = true
    } catch { dispose() }
  }
  const showWithParent = (): void => { hidden = false; showIfReady() }
  const dispose = (): void => {
    if (closed) return
    closed = true
    current = undefined
    clean(() => parent.removeListener('move', onPosition))
    clean(() => parent.removeListener('resize', onPosition))
    clean(() => parent.removeListener('show', showWithParent))
    clean(() => parent.removeListener('restore', showWithParent))
    clean(() => parent.removeListener('hide', hideWithParent))
    clean(() => parent.removeListener('minimize', hideWithParent))
    clean(() => parent.removeListener('closed', dispose))
    clean(() => window.removeListener('closed', dispose))
    // BaseWindow 不会自动关闭所附 WebContentsView；两个原生资源均需独立尝试回收。
    clean(() => { if (!wc.isDestroyed()) wc.close() })
    clean(() => { if (!window.isDestroyed()) window.destroy() })
  }
  try {
    window.setIgnoreMouseEvents(true)
    view.setBackgroundColor('#00000000')
    window.contentView.addChildView(view)
    parent.on('move', onPosition)
    parent.on('resize', onPosition)
    parent.on('show', showWithParent)
    parent.on('restore', showWithParent)
    parent.on('hide', hideWithParent)
    parent.on('minimize', hideWithParent)
    parent.on('closed', dispose)
    window.on('closed', dispose)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    wc.session.setPermissionCheckHandler(() => false)
    wc.session.on('will-download', (event) => { event.preventDefault() })
    wc.on('will-navigate', (event) => { event.preventDefault() })
    wc.on('render-process-gone', dispose)
    wc.on('destroyed', dispose)
    const ready = wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
    void ready.then(() => {
      if (closed) return
      loaded = true
      showIfReady()
    }).catch(dispose)
    return {
      get alive() { return !closed },
      show(placement: CursorPlacement): void {
        if (closed) return
        current = placement
        if (shown && window.isVisible()) onPosition()
        else showIfReady()
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
