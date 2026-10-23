/** 主进程独占的租约输入屏障；不绘制指针，也不属于 guest 的 DOM 或观测。 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView } from 'electron'

const document = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }</style>`

/**
 * 创建不可由 guest 操纵的透明原生输入屏障。原生 hit-test 和焦点拦截人工输入；
 * 指针由独立的点击穿透层绘制。屏障失效时调用方必须先卸载 guest，再关闭屏障。
 *
 * 屏障只在宿主窗口本来就是前台窗口时接管键盘焦点：Electron 的
 * `webContents.focus()` 在 macOS 上会让宿主窗口 `makeKeyAndOrderFront`，后台运行的
 * Agent 操作一旦调用就会把整个客户端弹到用户正在使用的其他应用之前。宿主窗口留在
 * 后台时不移交焦点也不激活应用，等它随后获得焦点再补上，租约内的键盘输入仍被挡住。
 * @param window - 拥有该视图的宿主窗口。
 * @param onFailure - 加载失败或原生页面丢失时的 fail-closed 回调。
 * @returns 屏障的附着、就绪与销毁操作；调用方负责租约与页面复核。
 */
export function createBrowserInputOverlay(window: BrowserWindow, onFailure: () => void) {
  const view = new WebContentsView({ webPreferences: {
    partition: `dsh-browser-overlay-${randomUUID()}`, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
    backgroundThrottling: false,
  } })
  const wc = view.webContents
  try {
    view.setBackgroundColor('#00000000')
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    wc.session.setPermissionCheckHandler(() => false)
    wc.session.on('will-download', (event) => { event.preventDefault() })
    wc.on('will-navigate', (event) => { event.preventDefault() })
    wc.on('before-input-event', (event) => { event.preventDefault() })
    wc.on('before-mouse-event', (event) => { event.preventDefault() })
    let attached = false
    let closed = false
    const failed = () => { if (!closed) onFailure() }
    // 焦点移交的唯一入口：宿主窗口在前台时才调用，避免后台呈现把应用激活。
    const takeFocus = (): void => {
      if (closed || !attached || wc.isDestroyed()) return
      let frontmost = false
      try { frontmost = !window.isDestroyed() && window.isFocused() } catch { return }
      if (frontmost) wc.focus()
    }
    wc.on('render-process-gone', failed)
    wc.on('destroyed', failed)
    const ready = wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
    void ready.catch(failed)
    return {
      view,
      ready,
      attach(bounds: { x: number; y: number; width: number; height: number }) {
        if (closed) throw new Error('browser input overlay closed')
        view.setBounds(bounds)
        if (!attached) {
          window.contentView.addChildView(view)
          attached = true
          // 用户之后把窗口切回前台时补交焦点；此时窗口已经在前台，不会再抢别人的焦点。
          window.on('focus', takeFocus)
        }
        takeFocus()
      },
      close() {
        if (closed) return
        closed = true
        window.removeListener('focus', takeFocus)
        if (attached && !window.isDestroyed() && window.contentView.children.includes(view)) {
          window.contentView.removeChildView(view)
        }
        attached = false
        if (!wc.isDestroyed()) wc.close()
      },
    }
  } catch (error) {
    if (!wc.isDestroyed()) wc.close()
    throw error
  }
}
