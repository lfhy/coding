import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron'

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url))

/** 显示器完整边界，字段与 Electron `Display.bounds`／`workArea` 一致。 */
export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 计算铺满显示器的初始窗口边界。
 *
 * macOS 的 `maximize()` 取屏幕「可用区域」：侧边 Dock（即便设成自动隐藏）照样让出约 47px，
 * 于是最大化后右侧露出一条桌面。这里在屏幕两侧被让出时改用整屏宽度，
 * 同时保留菜单栏高度与工作区底边；系统 Dock 始终绘制在窗口之上，不会被盖住。
 * @param bounds 显示器完整边界。
 * @param workArea 扣除菜单栏与 Dock 后的可用区域。
 * @param platform 运行平台，只有 macOS 走这套边界。
 * @returns 目标边界；返回 null 表示交给系统 `maximize()`（底部 Dock 或非 macOS）。
 */
export function fillBounds(bounds: DisplayRect, workArea: DisplayRect, platform: NodeJS.Platform): DisplayRect | null {
  if (platform !== 'darwin') return null
  if (workArea.width >= bounds.width) return null
  return { x: bounds.x, y: workArea.y, width: bounds.width, height: workArea.height }
}

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
    ...(isMacOS ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 18 } } : {}),
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
  // 侧边 Dock 会让 macOS 的可用区域窄一条，直接取整屏宽度铺满；其余情况仍用系统最大化。
  const display = screen.getDisplayMatching(window.getBounds())
  const target = fillBounds(display.bounds, display.workArea, process.platform)
  if (target === null) window.maximize()
  else window.setBounds(target)

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
    // 交通灯自 x=20 起、总宽约 52px：导航列取 76px，让灯组与卡片左右边框各留 12px；
    // 灯顶 y=18 高出卡片 16px 圆角，整组按钮落在窄导航的直边之内，不会顶着圆角。
    const rail = isMacOS ? '--app-rail-inline-size: 76px;' : ''
    const drag = isMacOS || isWindows
      ? '[data-window-drag-region] { -webkit-app-region: drag !important; }'
      : ''
    void window.webContents.insertCSS(`:root { --app-safe-area-inset-top: ${top}; --app-safe-area-inset-right: ${right}; ${rail} } ${drag}`)
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
