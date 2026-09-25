import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url))

function validHostOrigin(origin: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin)
  if (!match || Number(match[1]) > 65535) return false
  try {
    return new URL(origin).origin === origin
  } catch {
    return false
  }
}

/**
 * 仅允许当前 Host 的精确回环地址和端口，不能把其他回环别名或端口视为同源。
 * @param origin 已由主进程取得的 Host origin。
 * @param target 待导航的绝对 URL。
 * @returns 目标仍属于该 Host 时为 true。
 */
export function isAllowedHostNavigation(origin: string, target: string): boolean {
  if (!validHostOrigin(origin)) return false
  if (!target.startsWith(origin)) return false
  if (!['/', '?', '#'].includes(target.charAt(origin.length))) return false
  try {
    const url = new URL(target)
    return url.origin === origin && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * 为已验证就绪的独立 Host 建立受限窗口；renderer 只经 sandbox preload
 * 请求主进程逐次授权的 Remote-SSH 方法，不直接持有 Node 或 helper。
 * @param origin 主进程验证的 Host origin，须为随机端口的 127.0.0.1 HTTP 地址。
 * @param options 开发态 DevTools 与由运行模式提供的原生图标路径。
 * @returns 已开始加载 Host 根页面的窗口。
 */
export function createHostWindow(origin: string, options: { devTools?: boolean; iconPath?: string } = {}): BrowserWindow {
  if (!validHostOrigin(origin)) throw new Error('Invalid desktop Host origin')

  const isMacOS = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#f5f5f7',
    ...(isMacOS ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } } : {}),
    ...(isWindows ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#f5f5f7', symbolColor: '#303030', height: 40 },
    } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: options.devTools === true,
      preload: preloadPath,
    },
  })

  // 权限属于 session；这个最小窗口不授予任何站点原生权限。
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (details) => {
    if (!isAllowedHostNavigation(origin, details.url)) details.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (details) => {
    if (!isAllowedHostNavigation(origin, details.url)) details.preventDefault()
  })
  window.webContents.on('will-redirect', (details) => {
    if (!isAllowedHostNavigation(origin, details.url)) details.preventDefault()
  })

  let closing = false
  let failureShown = false
  let initialLoadPending = true
  let initialLoadCancelled = false
  const reportLoadFailure = () => {
    if (closing || window.isDestroyed() || failureShown) return
    failureShown = true
    // 不拼接异常文本或 URL；失败窗口不再保留白屏，macOS 可从 Dock 重新发现 Host。
    dialog.showErrorBox('Coding 窗口加载失败', '本地 Host 页面无法加载。请检查 Host 状态并重新启动桌面端。')
    window.destroy()
  }
  window.on('close', (event) => {
    closing = true
    // macOS 普通关窗由主进程拦截成隐藏；它仍是可复用的同一个窗口。
    queueMicrotask(() => { if (event.defaultPrevented) closing = false })
  })
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (errorCode === -3) {
      if (initialLoadPending && isMainFrame) initialLoadCancelled = true
      return
    }
    if (isMainFrame) reportLoadFailure()
  })

  window.webContents.on('dom-ready', () => {
    if (!isAllowedHostNavigation(origin, window.webContents.getURL())) return
    // 页面每次加载都恢复避让值：macOS 交通灯在左上，Windows caption 在右上。
    const top = isMacOS ? '38px' : '0px'
    const right = isWindows ? '138px' : '0px'
    void window.webContents.insertCSS(`:root { --app-safe-area-inset-top: ${top}; --app-safe-area-inset-right: ${right}; }`)
      .catch(() => undefined)
  })
  if (isMacOS && app.dock && options.iconPath && existsSync(options.iconPath)) {
    try {
      const icon = nativeImage.createFromPath(options.iconPath)
      if (icon.isEmpty()) throw new Error('Empty Dock icon')
      app.dock.setIcon(icon)
    } catch {
      // Dock 图标是开发便利项；错误不影响已验证 Host 页面加载。
      console.warn('Coding Dock 图标加载失败，继续加载 Host 页面。')
    }
  }
  void window.loadURL(`${origin}/`).then(
    () => { initialLoadPending = false },
    () => {
      initialLoadPending = false
      if (!initialLoadCancelled) reportLoadFailure()
    },
  )
  return window
}
