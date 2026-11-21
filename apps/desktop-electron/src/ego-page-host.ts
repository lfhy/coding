/**
 * 桌面端 Agent 页面的载体：每个页面就是一个 Electron `WebContentsView`，
 * 模型经虚拟 CDP 端点（`ego-cdp-broker.ts`）驱动它，用户在工作台里看到的是同一份渲染结果。
 *
 * 未呈现的页面停在一个永不显示的私有窗口里，保留布局与绘制，因此后台页面仍能取值、
 * 点击与截图；呈现时把同一个视图移进应用窗口，不再经过截图或视频流。
 */
import { randomUUID } from 'node:crypto'
import { session, WebContentsView, type BrowserWindow, type Session } from 'electron'
import { createBackgroundStage } from './browser-guest-stage.ts'
import type { EgoHostedPage, EgoPageHost } from './ego-cdp-broker.ts'

const DEFAULT_CONTEXT = 'desktop-default'
const DEFAULT_PARTITION = 'persist:ego-default'
const BACKGROUND_VIEWPORT = { width: 1280, height: 800 }
const MAX_COOKIE_FIELD = 4096
/** 页面只获得写入剪贴板的权限；读取剪贴板、相机、通知等继续拒绝。 */
const GRANTED_PERMISSIONS = new Set(['clipboard-sanitized-write'])
/** 页面自己发起的本地文件导航一律拒绝；显式加载仍由宿主发起。 */
const LOCAL_SCHEMES = new Set(['file:', 'data:'])

/** 呈现请求：工作台内容区在窗口内的 CSS 像素矩形。 */
export interface EgoPresentation {
  targetId: string
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
}

/** 页面宿主对外能力：broker 面向的接口加呈现控制。 */
export interface EgoPageHostHandle extends EgoPageHost {
  /** 把页面移进应用窗口并给出矩形；`visible: false` 时退回后台承载。 */
  present(presentation: EgoPresentation): void
  /** 关闭全部页面但保留端点；Host 重启后页面由它自己重建。 */
  closeAll(): void
  /** 撤下当前呈现的页面。 */
  conceal(): void
  /** 关闭所有页面与后台承载窗口。 */
  dispose(): void
}

interface Entry {
  readonly targetId: string
  readonly contextId: string
  readonly view: WebContentsView
  readonly listeners: Set<(method: string, params: Record<string, unknown>) => void>
  debuggerWired: boolean
}

function cookieString(value: unknown, max = MAX_COOKIE_FIELD): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

/** CDP 的 SameSite 名称映射到 Electron 的写入取值；未知取值保持不指定。 */
function cookieSameSite(value: string): { sameSite?: 'no_restriction' | 'lax' | 'strict' } {
  if (value === 'none') return { sameSite: 'no_restriction' }
  if (value === 'lax' || value === 'strict') return { sameSite: value }
  return {}
}

/**
 * 创建页面宿主。
 *
 * 窗口按需读取：端点必须在 Host 启动前就位，而窗口是 Host 就绪之后才建立的，
 * 因此这里不接受固定实例。窗口销毁或重建期间，宿主暂停建页与呈现。
 * @param options.window 返回当前应用窗口的取值函数。
 * @returns 页面、上下文与呈现的完整句柄；调用方在退出时 `dispose()`。
 */
export function createEgoPageHost(options: { window: () => BrowserWindow | undefined }): EgoPageHostHandle {
  const { window } = options
  const pages = new Map<string, Entry>()
  /** 上下文 id → Electron session 的分区名。 */
  const partitions = new Map<string, string>([[DEFAULT_CONTEXT, DEFAULT_PARTITION]])
  const configured = new Set<string>()
  const stage = createBackgroundStage()
  /** 每个页面只有一个对外对象：broker 用它做身份比较，不能每次读取都新建。 */
  const handles = new WeakMap<Entry, EgoHostedPage>()
  let presented: { targetId: string; bounds: EgoPresentation['bounds'] } | undefined
  let disposed = false

  function partitionFor(contextId: string): string {
    const existing = partitions.get(contextId)
    if (existing) return existing
    const partition = `ego-${contextId}`
    partitions.set(contextId, partition)
    return partition
  }

  /** 每个分区只配置一次权限与下载策略。 */
  function sessionFor(contextId: string): Session {
    const partition = partitionFor(contextId)
    const current = session.fromPartition(partition)
    if (!configured.has(partition)) {
      configured.add(partition)
      current.setPermissionRequestHandler((_contents, permission, callback) => { callback(GRANTED_PERMISSIONS.has(permission)) })
      current.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission))
      current.on('will-download', (event) => { event.preventDefault() })
    }
    return current
  }

  function ownerWindow(): BrowserWindow | undefined {
    const current = window()
    return current === undefined || current.isDestroyed() ? undefined : current
  }

  function park(entry: Entry): void {
    const owner = ownerWindow()
    if (owner && owner.contentView.children.includes(entry.view)) owner.contentView.removeChildView(entry.view)
    stage.attach(entry.view, BACKGROUND_VIEWPORT)
  }

  function closeEntry(entry: Entry): void {
    pages.delete(entry.targetId)
    entry.listeners.clear()
    if (presented?.targetId === entry.targetId) presented = undefined
    const owner = ownerWindow()
    if (owner && owner.contentView.children.includes(entry.view)) owner.contentView.removeChildView(entry.view)
    stage.detach(entry.view)
    try { if (entry.view.webContents.debugger.isAttached()) entry.view.webContents.debugger.detach() } catch { /* 已销毁。 */ }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  }

  function wireDebugger(entry: Entry): void {
    const wc = entry.view.webContents
    if (!entry.debuggerWired) {
      entry.debuggerWired = true
      wc.debugger.on('message', (_event, method, params) => {
        for (const listener of entry.listeners) listener(method, (params ?? {}) as Record<string, unknown>)
      })
    }
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  }

  function createPageObject(entry: Entry): EgoHostedPage {
    return {
      targetId: entry.targetId,
      contextId: entry.contextId,
      async send(method, params) {
        const wc = entry.view.webContents
        if (wc.isDestroyed()) throw new Error('page is closed')
        if (!wc.debugger.isAttached()) wireDebugger(entry)
        return await wc.debugger.sendCommand(method, params) as unknown
      },
      onEvent(listener) {
        entry.listeners.add(listener)
        return () => { entry.listeners.delete(listener) }
      },
      close() { closeEntry(entry) },
      describe() {
        const wc = entry.view.webContents
        if (wc.isDestroyed()) return { url: 'about:blank', title: '' }
        return { url: wc.getURL(), title: wc.getTitle() }
      },
    }
  }

  function pageOf(entry: Entry): EgoHostedPage {
    const existing = handles.get(entry)
    if (existing) return existing
    const created = createPageObject(entry)
    handles.set(entry, created)
    return created
  }

  function denyNavigation(event: { url: string; isMainFrame?: boolean; preventDefault(): void }): void {
    if (event.url === 'about:blank') return
    try {
      if (!LOCAL_SCHEMES.has(new URL(event.url).protocol)) return
    } catch { /* 无法解析的地址按拒绝处理。 */ }
    if (event.isMainFrame !== false) event.preventDefault()
  }

  return {
    list: () => [...pages.values()].map(pageOf),
    find: (targetId) => { const entry = pages.get(targetId); return entry ? pageOf(entry) : undefined },
    defaultContext: () => DEFAULT_CONTEXT,

    createContext() {
      // 缺少持久命名依据：任务空间上下文按运行期随机 id 分配内存分区，
      // 登录态由默认分区在创建时播种，不跨重启保留。
      const contextId = randomUUID()
      partitions.set(contextId, `ego-${contextId}`)
      return contextId
    },

    disposeContext(contextId) {
      for (const entry of [...pages.values()]) { if (entry.contextId === contextId) closeEntry(entry) }
      if (contextId !== DEFAULT_CONTEXT) partitions.delete(contextId)
    },

    createPage(contextId, url) {
      if (disposed) return Promise.reject(new Error('page host is closed'))
      if (!ownerWindow()) return Promise.reject(new Error('window is closed'))
      const partition = partitionFor(contextId)
      sessionFor(contextId)
      const view = new WebContentsView({ webPreferences: {
        partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        webviewTag: false, devTools: false, spellcheck: false,
        // 未呈现的页面也要保持布局与绘制，后台取值与截图才有效。
        backgroundThrottling: false,
      } })
      const wc = view.webContents
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('will-navigate', denyNavigation)
      wc.on('will-frame-navigate', denyNavigation)
      wc.on('will-redirect', denyNavigation)
      const entry: Entry = { targetId: randomUUID(), contextId, view,
        listeners: new Set(), debuggerWired: false }
      pages.set(entry.targetId, entry)
      wireDebugger(entry)
      stage.attach(view, BACKGROUND_VIEWPORT)
      // 加载结果由页面状态体现：网络失败不应让建页命令失败。
      void wc.loadURL(url).catch(() => undefined)
      return Promise.resolve(pageOf(entry))
    },

    async getCookies(contextId) {
      const current = sessionFor(contextId ?? DEFAULT_CONTEXT)
      const cookies = await current.cookies.get({})
      return cookies.map(cookie => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        expires: cookie.session ? -1 : cookie.expirationDate ?? -1,
        httpOnly: cookie.httpOnly, secure: cookie.secure, session: cookie.session,
        sameSite: cookie.sameSite, hostOnly: cookie.hostOnly,
      }))
    },

    async setCookies(contextId, cookies) {
      const current = sessionFor(contextId)
      for (const cookie of cookies) {
        const name = cookieString(cookie.name)
        const value = typeof cookie.value === 'string' && cookie.value.length <= MAX_COOKIE_FIELD ? cookie.value : undefined
        const domain = cookieString(cookie.domain)
        if (!name || value === undefined || !domain) continue
        const path = cookieString(cookie.path, 1024) ?? '/'
        const secure = cookie.secure === true
        const sameSite = typeof cookie.sameSite === 'string' ? cookie.sameSite.toLowerCase() : ''
        const expirationDate = typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : undefined
        try {
          await current.cookies.set({
            url: `${secure ? 'https' : 'http'}://${domain.replace(/^\./u, '')}${path}`,
            name, value, domain, path, secure,
            httpOnly: cookie.httpOnly === true,
            ...expirationDate === undefined ? {} : { expirationDate },
            ...cookieSameSite(sameSite),
          })
        } catch { /* 单条非法 Cookie 不阻断其余播种。 */ }
      }
    },

    present(presentation) {
      if (disposed) return
      const entry = pages.get(presentation.targetId)
      if (!entry) return
      if (!presentation.visible) {
        if (presented?.targetId === presentation.targetId) presented = undefined
        park(entry)
        return
      }
      const owner = ownerWindow()
      if (!owner) return
      const { x, y, width, height } = presentation.bounds
      if (![x, y, width, height].every(item => Number.isSafeInteger(item) && item >= 0) || width < 1 || height < 1) return
      const content = owner.getContentBounds()
      if (x + width > content.width || y + height > content.height) return
      if (presented && presented.targetId !== presentation.targetId) {
        const previous = pages.get(presented.targetId)
        if (previous) park(previous)
      }
      stage.detach(entry.view)
      if (!owner.contentView.children.includes(entry.view)) owner.contentView.addChildView(entry.view)
      entry.view.setBounds({ x, y, width, height })
      presented = { targetId: entry.targetId, bounds: { x, y, width, height } }
    },

    closeAll() {
      for (const entry of [...pages.values()]) closeEntry(entry)
      for (const contextId of [...partitions.keys()]) {
        if (contextId !== DEFAULT_CONTEXT) partitions.delete(contextId)
      }
    },

    conceal() {
      const current = presented ? pages.get(presented.targetId) : undefined
      presented = undefined
      if (current) park(current)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of [...pages.values()]) closeEntry(entry)
      presented = undefined
      stage.dispose()
    },
  }
}
