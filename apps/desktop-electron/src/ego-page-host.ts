/**
 * 桌面端 Agent 页面的载体：每个页面就是一个 Electron `WebContentsView`，
 * 模型经虚拟 CDP 端点（`ego-cdp-broker.ts`）驱动它，用户在工作台里看到的是同一份渲染结果。
 *
 * 未呈现的页面停在一个永不显示的私有窗口里，保留布局与绘制，因此后台页面仍能取值、
 * 点击与截图；呈现时把同一个视图移进应用窗口，不再经过截图或视频流。
 */
import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, session, WebContentsView, type BrowserWindow, type DownloadItem, type Session } from 'electron'
import { createBackgroundStage } from './browser-guest-stage.ts'
import type { EgoHostedPage, EgoPageHost } from './ego-cdp-broker.ts'
import { captureEgoViewport } from './ego-screenshot.ts'

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

/** 下载决定：ego 用 `Browser.setDownloadBehavior` 表达；缺省由应用临时目录接住。 */
export interface EgoDownloadSettings {
  behavior: 'allow' | 'deny' | 'default'
  downloadPath?: string
}

/** 一次下载的可见状态；工作台的下载列表与 CDP 事件都用它。 */
export interface EgoDownloadRecord {
  id: string
  contextId: string
  filename: string
  /** 实际落盘路径；完成后可直接复制到用户选择的位置。 */
  path: string
  url: string
  state: 'progressing' | 'completed' | 'canceled'
  receivedBytes: number
  totalBytes: number
  startedAt: number
}

/** 下载事件：开始与进度都由页面宿主发出，broker 再翻译成 CDP 事件。 */
export interface EgoDownloadEvent {
  kind: 'begin' | 'progress'
  record: EgoDownloadRecord
}

/** 运行时没有指定目录时，页面自己触发的下载落到系统下载目录。 */
const DEFAULT_DOWNLOAD_SUBDIR = ''

/** 页面宿主对外能力：broker 面向的接口加呈现控制。 */
export interface EgoPageHostHandle extends EgoPageHost {
  /** 把页面移进应用窗口并给出矩形；`visible: false` 时退回后台承载。 */
  present(presentation: EgoPresentation): void
  /** 记录某个上下文（缺省为默认上下文）的下载决定，供后续下载使用。 */
  setDownloadBehavior(contextId: string | undefined, settings: EgoDownloadSettings): void
  /** 订阅下载开始与进度；返回取消订阅函数。 */
  onDownload(listener: (event: EgoDownloadEvent) => void): () => void
  /** 最近下载的新到旧列表，供工作台展示。 */
  downloads(): readonly EgoDownloadRecord[]
  /** 取消进行中的下载；下载已经结束时返回 false。 */
  cancelDownload(id: string): boolean
  /** 把已完成的下载复制到目标路径，返回实际写入的路径。 */
  saveDownload(id: string, target: string): Promise<string>
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
  /** 每个上下文的下载决定；未登记的上下文按允许落到应用临时目录处理。 */
  const downloads = new Map<string, EgoDownloadSettings>()
  const downloadListeners = new Set<(event: EgoDownloadEvent) => void>()
  /** 最近的下载记录（新到旧）与仍可取消的下载句柄。 */
  const downloadRecords = new Map<string, EgoDownloadRecord>()
  const downloadItems = new Map<string, DownloadItem>()
  let presented: { targetId: string; bounds: EgoPresentation['bounds'] } | undefined
  let disposed = false

  function partitionFor(contextId: string): string {
    const existing = partitions.get(contextId)
    if (existing) return existing
    const partition = `ego-${contextId}`
    partitions.set(contextId, partition)
    return partition
  }

  /** 下载落点：ego 给的目录优先，否则用系统下载目录，绝不让系统弹保存框。 */
  function downloadDirectory(contextId: string): string {
    const settings = downloads.get(contextId)
    if (settings?.downloadPath !== undefined && settings.downloadPath.length > 0) return settings.downloadPath
    return join(app.getPath('downloads'), DEFAULT_DOWNLOAD_SUBDIR)
  }

  /**
   * 运行时的下载路径由它自己按 suggestedFilename 拼出来，因此指定目录时不得改名；
   * 只有落到系统下载目录（页面自己触发）时才避开已存在的同名文件。
   */
  function uniqueDownloadPath(directory: string, filename: string): string {
    const candidate = join(directory, filename)
    if (!existsSync(candidate)) return candidate
    const extension = extname(filename)
    const stem = extension === '' ? filename : filename.slice(0, -extension.length)
    for (let index = 1; index < 1000; index += 1) {
      const next = join(directory, `${stem} (${index})${extension}`)
      if (!existsSync(next)) return next
    }
    return join(directory, `${stem}-${randomUUID()}${extension}`)
  }

  /**
   * 每个分区只配置一次权限与下载处理。
   *
   * 下载默认允许并直接落到下载目录：ego 的 `ego_download` 用
   * `Browser.setDownloadBehavior` 指定目录后等待 `Page.downloadWillBegin`，
   * 因此这里既不能弹保存框，也不能静默丢弃；拒绝只发生在 ego 明确要求时。
   */
  function sessionFor(contextId: string): Session {
    const partition = partitionFor(contextId)
    const current = session.fromPartition(partition)
    if (!configured.has(partition)) {
      configured.add(partition)
      current.setPermissionRequestHandler((_contents, permission, callback) => { callback(GRANTED_PERMISSIONS.has(permission)) })
      current.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission))
      current.on('will-download', (event, item) => {
        if (downloads.get(contextId)?.behavior === 'deny') { event.preventDefault(); return }
        const guid = randomUUID()
        const filename = item.getFilename()
        const directory = downloadDirectory(contextId)
        try { mkdirSync(directory, { recursive: true }) } catch { /* 目录不可用时仍让 Chromium 自己决定落点。 */ }
        const explicit = downloads.get(contextId)?.downloadPath
        const target = explicit !== undefined && explicit.length > 0
          ? join(directory, filename) : uniqueDownloadPath(directory, filename)
        item.setSavePath(target)
        // 事件里的文件名必须是真实落盘名：运行时按它拼 download.path()。
        const record: EgoDownloadRecord = {
          id: guid, contextId, filename: basename(target), path: target, url: item.getURL(),
          state: 'progressing', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
          startedAt: Date.now(),
        }
        downloadRecords.set(guid, record)
        downloadItems.set(guid, item)
        trimDownloads()
        const notify = (kind: EgoDownloadEvent['kind']): void => {
          for (const listener of [...downloadListeners]) listener({ kind, record })
        }
        notify('begin')
        const update = (state: EgoDownloadRecord['state']): void => {
          record.state = state
          record.receivedBytes = item.getReceivedBytes()
          record.totalBytes = item.getTotalBytes()
          if (state !== 'progressing') {
            const saved = item.getSavePath()
            if (saved.length > 0) record.path = saved
            downloadItems.delete(guid)
          }
          notify('progress')
        }
        // `updated` 只会带 progressing／interrupted，两者分别映射为下载中与已中断。
        item.on('updated', (_event, state) => { update(state === 'interrupted' ? 'canceled' : 'progressing') })
        item.once('done', (_event, state) => { update(state === 'completed' ? 'completed' : 'canceled') })
      })
    }
    return current
  }

  /** 下载列表只保留最近 50 条，避免一次会话把内存撑大。 */
  function trimDownloads(): void {
    while (downloadRecords.size > 50) {
      const oldest = downloadRecords.keys().next().value
      if (oldest === undefined) return
      downloadRecords.delete(oldest)
    }
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
        if (method === 'Page.captureScreenshot') return captureEgoViewport(wc.debugger, params)
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
    list() {
      // 此端点没有 DevTools HTTP 的最近使用顺序。将实际呈现的页放在首位，
      // 运行时仍先按任务空间过滤，显式选页也仍优先于这份默认顺序。
      const active = presented && pages.get(presented.targetId)
      const result = active ? [pageOf(active)] : []
      for (const entry of pages.values()) { if (entry !== active) result.push(pageOf(entry)) }
      return result
    },
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

    setDownloadBehavior(contextId, settings) {
      downloads.set(contextId ?? DEFAULT_CONTEXT, settings)
    },

    onDownload(listener) {
      downloadListeners.add(listener)
      return () => { downloadListeners.delete(listener) }
    },

    downloads: () => [...downloadRecords.values()].reverse(),

    cancelDownload(id) {
      const item = downloadItems.get(id)
      if (item === undefined) return false
      try { item.cancel(); return true } catch { return false }
    },

    async saveDownload(id, target) {
      const record = downloadRecords.get(id)
      if (record === undefined) throw new Error('download not found')
      if (record.state !== 'completed') throw new Error('download is not finished')
      await copyFile(record.path, target)
      return target
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
