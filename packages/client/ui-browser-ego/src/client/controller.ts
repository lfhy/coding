/** 会话级画面控制器；严格按面板显隐持有 SSE、请求与输入状态。 */
import { createSnapshotStore } from 'coding-client-runtime/client'
import { appendAction, type EgoAction } from './actions.ts'
import {
  parseActions, parseActivity, parseFrame, parseSpaces, parseStatus, parseVideoStatus,
  type EgoFrame, type EgoPage, type EgoStatus, type EgoVideo, validId,
} from './wire.ts'

/** 面板订阅的投影视图，不保存页面 DOM 或模型可见内容。 */
export interface BrowserEgoView {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly pages: readonly EgoPage[]
  readonly selectedId: string | null
  readonly frame: EgoFrame | null
  readonly relayOff: boolean
  readonly pending: boolean
  readonly closing: string | null
  readonly status: EgoStatus | null
  readonly video: EgoVideo
  readonly actions: readonly EgoAction[]
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
type StreamFactory = (url: string) => EventSource

const INITIAL: BrowserEgoView = {
  phase: 'loading', pages: [], selectedId: null, frame: null, relayOff: false, pending: false,
  closing: null, status: null, video: { available: false, mime: null }, actions: [],
}

function streamUrl(sessionId: string, path: string): string {
  return `${path}?${new URLSearchParams({ sessionId }).toString()}`
}

/**
 * 一次显隐周期只持有一条会话过滤的画面流和一条活动流；卸载、切换或隐藏会丢弃全部旧帧。
 * @param sessionId - Host 已授权且 Client 正展示的会话身份。
 * @param fetcher - 同源请求载体。
 * @param connect - 会话画面事件载体。
 * @param connectActivity - 只报告工具动作的全局事件载体；失败时动作历史仍可经 HTTP 读取。
 */
export class BrowserEgoController {
  readonly view = createSnapshotStore<BrowserEgoView>(INITIAL)
  private shown = false
  private viewers = new Set<string>()
  private selectedViewId: string | null = null
  private epoch = 0
  private listVersion = 0
  private request: AbortController | null = null
  private frameRequest: AbortController | null = null
  private input: AbortController | null = null
  private stream: EventSource | null = null
  private activity: EventSource | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sessionId: string,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
    private readonly connect: StreamFactory = url => new EventSource(url),
    private readonly connectActivity: StreamFactory = url => new EventSource(url)) {
    if (!validId(sessionId)) throw new Error('invalid session id')
  }

  /** 多个工作台页面共享一条会话流；切换时跟随当前可见页面，最后隐藏时释放。 */
  show(visible: boolean, viewId = 'default'): void {
    if (visible) {
      this.viewers.add(viewId)
      if (this.selectedViewId !== viewId) {
        this.selectedViewId = viewId
        if (validId(viewId)) this.select(viewId)
      }
    } else {
      this.viewers.delete(viewId)
      if (this.selectedViewId === viewId) {
        this.selectedViewId = this.viewers.values().next().value ?? null
        if (this.selectedViewId !== null && validId(this.selectedViewId)) this.select(this.selectedViewId)
      }
    }
    const showing = this.viewers.size > 0
    if (this.shown === showing) return
    this.shown = showing
    this.epoch++
    this.listVersion++
    this.request?.abort()
    this.request = null
    this.cancelFrameRefresh()
    this.input?.abort()
    this.input = null
    this.closeStream()
    this.closeActivity()
    this.clearTimer()
    this.view.set(INITIAL)
    if (showing) {
      void this.refresh()
      this.openStream(this.epoch)
      this.openActivity(this.epoch)
    }
  }

  /** 插件撤销时释放所有保留标签的订阅与输入，即使视图尚在隐藏状态。 */
  dispose(): void {
    this.viewers.clear()
    this.selectedViewId = null
    this.show(false)
  }

  /** 同时刷新页面目录、浏览器状态与最近动作；迟到响应不能覆盖更新的 SSE 列表。 */
  async refresh(): Promise<void> {
    if (!this.shown) return
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    const epoch = this.epoch
    const listVersion = this.listVersion
    try {
      await Promise.all([this.loadPages(request, epoch, listVersion), this.loadOverview(request, epoch)])
    } finally {
      if (this.request === request) this.request = null
    }
  }

  private async loadPages(request: AbortController, epoch: number, listVersion: number): Promise<void> {
    try {
      const response = await this.fetcher(streamUrl(this.sessionId, '/api/ego/spaces'), {
        signal: request.signal, cache: 'no-store',
      })
      if (!response.ok) throw new Error('page list unavailable')
      const payload: unknown = await response.json()
      if (!this.current(epoch, request)) return
      if (typeof payload !== 'object' || payload === null || !('ok' in payload) || payload.ok !== true
        || !('spaces' in payload)) throw new Error('invalid page list')
      const pages = parseSpaces(payload.spaces)
      const relayOff = 'frameRelay' in payload && payload.frameRelay === false
      if (listVersion === this.listVersion) {
        this.acceptPages(pages, relayOff)
        if (!relayOff) this.refreshSelectedFrame()
      } else if (this.view.getSnapshot().selectedId !== null) this.refreshSelectedFrame()
      if (relayOff) this.closeStream()
    } catch {
      if (this.current(epoch, request) && listVersion === this.listVersion) {
        this.view.set({ ...this.view.getSnapshot(), phase: 'error' })
      }
    }
  }

  private async loadOverview(request: AbortController, epoch: number): Promise<void> {
    const [status, actions, video] = await Promise.all([
      this.statusOf(request).catch(() => null),
      this.historyOf(request).catch(() => null),
      this.videoOf(request).catch(() => null),
    ])
    if (!this.current(epoch, request)) return
    const view = this.view.getSnapshot()
    this.view.set({ ...view, status, actions: actions ?? view.actions,
      video: video ?? { available: false, mime: null } })
  }

  private async statusOf(request: AbortController): Promise<EgoStatus | null> {
    const response = await this.fetcher(streamUrl(this.sessionId, '/api/ego/status'), {
      signal: request.signal, cache: 'no-store',
    })
    return response.ok ? parseStatus(await response.json() as unknown) : null
  }

  /** 视频后端状态只决定画面形态；不可用时面板继续使用单帧画面。 */
  private async videoOf(request: AbortController): Promise<EgoVideo> {
    const response = await this.fetcher('/api/ego/video/status', {
      signal: request.signal, cache: 'no-store',
    })
    return response.ok ? parseVideoStatus(await response.json() as unknown) : { available: false, mime: null }
  }

  private async historyOf(request: AbortController): Promise<readonly EgoAction[] | null> {
    const response = await this.fetcher(streamUrl(this.sessionId, '/api/ego/history'), {
      signal: request.signal, cache: 'no-store',
    })
    return response.ok ? parseActions(await response.json() as unknown) : null
  }

  /**
   * 仅请求已列入本会话页面目录的目标；切换时旧的画面与输入立即失效。
   * @param targetId - 被选中的页面身份。
   */
  select(targetId: string): void {
    const view = this.view.getSnapshot()
    if (!this.shown || !validId(targetId) || view.selectedId === targetId
      || !view.pages.some(page => page.targetId === targetId)) return
    this.cancelFrameRefresh()
    this.view.set({ ...view, selectedId: targetId, frame: null })
    this.refreshSelectedFrame()
  }

  /** 仅导航本会话页面；空白目录时允许 Host 为本会话建立第一张页面。 */
  async navigate(targetId: string | undefined, action: 'navigate' | 'reload' | 'back' | 'forward', url?: string): Promise<boolean> {
    const view = this.view.getSnapshot()
    const create = targetId === undefined && action === 'navigate' && view.pages.length === 0
    if (!this.shown || view.pending || !create && (!validId(targetId)
      || !view.pages.some(page => page.targetId === targetId))) return false
    const epoch = this.epoch
    this.cancelFrameRefresh()
    this.view.set({ ...view, frame: view.selectedId === targetId ? null : view.frame, pending: true })
    try {
      const response = await this.fetcher('/api/ego/navigation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, ...(targetId === undefined ? {} : { targetId }),
          action, ...(url === undefined ? {} : { url }) }),
      })
      if (!response.ok || epoch !== this.epoch) return false
      await this.refresh()
      return true
    } catch { return false }
    finally {
      if (epoch === this.epoch) this.view.set({ ...this.view.getSnapshot(), pending: false })
    }
  }

  /**
   * 用户主动要求时把浏览器换成可见窗口（登录扫码、人机验证需要）。
   *
   * 只有这个动作会让浏览器获得前台窗口；自动打开面板与工具调用都不会。
   * @returns Host 是否接受了请求；浏览器进程的最终状态仍由画面流反映。
   */
  async raiseWindow(): Promise<boolean> {
    if (!this.shown) return false
    try {
      const response = await this.fetcher('/api/ego/window', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId }),
      })
      return response.ok
    } catch { return false }
  }

  /**
   * 关闭本会话的一个页面；成功后刷新目录，失败只回传布尔值由面板显示固定文案。
   * @param targetId - 已列入当前会话目录的页面身份。
   * @returns Host 是否接受关闭；隐藏后的迟到结果按成功处理，避免已不可见的面板弹出提示。
   */
  async close(targetId: string): Promise<boolean> {
    const view = this.view.getSnapshot()
    if (!this.shown || !validId(targetId) || view.closing !== null
      || !view.pages.some(page => page.targetId === targetId)) return false
    const epoch = this.epoch
    this.view.set({ ...view, closing: targetId })
    try {
      const response = await this.fetcher('/api/ego/close', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, targetId }),
      })
      if (epoch !== this.epoch) return true
      if (!response.ok) return false
      await this.refresh()
      return true
    } catch { return epoch !== this.epoch }
    finally {
      if (epoch === this.epoch) {
        const current = this.view.getSnapshot()
        if (current.closing === targetId) this.view.set({ ...current, closing: null })
      }
    }
  }

  /** 刷新被选页面的一帧；Host 再次校验 Session 与 targetId 归属。 */
  private refreshSelectedFrame(): void {
    const view = this.view.getSnapshot()
    if (!this.shown || view.relayOff || view.selectedId === null) return
    this.frameRequest?.abort()
    const request = new AbortController()
    this.frameRequest = request
    const epoch = this.epoch
    const targetId = view.selectedId
    const url = `/api/ego/frame?${new URLSearchParams({ sessionId: this.sessionId, targetId }).toString()}`
    void (async () => {
      try {
        const response = await this.fetcher(url, { signal: request.signal, cache: 'no-store' })
        if (!response.ok) return
        const frame = parseFrame(await response.json() as unknown)
        const current = this.view.getSnapshot()
        if (!frame || !this.shown || this.epoch !== epoch || this.frameRequest !== request || request.signal.aborted
          || current.selectedId !== targetId || frame.targetId !== targetId
          || !current.pages.some(page => page.targetId === targetId)
          || current.frame?.targetId === targetId && frame.ts <= current.frame.ts) return
        const page = current.pages.find(item => item.targetId === targetId)
        if (page?.viewportW != null && page.viewportW !== frame.width
          || page?.viewportH != null && page.viewportH !== frame.height) return
        this.view.set({ ...current, frame })
      } catch { /* 页面可能导航或结束；下一次刷新重新取得最新目标。 */ }
      finally { if (this.frameRequest === request) this.frameRequest = null }
    })()
  }

  private cancelFrameRefresh(): void {
    this.frameRequest?.abort()
    this.frameRequest = null
  }

  /**
   * 操作前再校验当前页面和画面身份，输入由 Host 复核会话所有权。
   * @param targetId - 当前显示的页面身份。
   * @param input - 已过画面坐标校验的动作；事件类型必须在本包封闭集合中。
   * @returns 接受输入是否成功；失败时调用者只展示面向用户的固定错误。
   */
  async send(targetId: string, input:
    | { type: 'mousePressed' | 'mouseReleased'; x: number; y: number; button: 'left'; buttons: 0 | 1; clickCount: 1 }
    | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }
    | { type: 'insertText'; text: string }
    | { type: 'keyDown' | 'keyUp'; key: string; code: string; windowsVirtualKeyCode: number }): Promise<boolean> {
    const current = this.view.getSnapshot()
    if (!this.shown || !validId(targetId) || current.phase !== 'ready'
      || current.selectedId !== targetId || current.pending) return false
    const selected = current.pages.find(page => page.targetId === targetId)
    // 视频后端没有 JPEG 帧；操作边界来自该页面自己的视口尺寸。
    const frame = current.frame?.targetId === targetId ? current.frame : null
    const width = frame?.width ?? (current.video.available ? selected?.viewportW ?? null : null)
    const height = frame?.height ?? (current.video.available ? selected?.viewportH ?? null : null)
    if (width === null || height === null || width <= 0 || height <= 0) return false
    if (frame && selected && ((selected.viewportW !== null && frame.width !== selected.viewportW)
      || (selected.viewportH !== null && frame.height !== selected.viewportH))) return false
    if ('x' in input && (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
      || input.x < 0 || input.y < 0 || input.x >= width || input.y >= height)) return false
    if (input.type === 'insertText' && (input.text.length < 1 || input.text.length > 2000)) return false
    if ((input.type === 'keyDown' || input.type === 'keyUp')
      && (!['Enter', 'Backspace', 'Delete', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(input.key)
        || input.code !== input.key || !Number.isSafeInteger(input.windowsVirtualKeyCode)
        || input.windowsVirtualKeyCode < 0 || input.windowsVirtualKeyCode > 255)) return false
    if (input.type === 'mouseWheel' && (![input.deltaX, input.deltaY].every(Number.isFinite)
      || !Number.isSafeInteger(input.deltaX) || !Number.isSafeInteger(input.deltaY)
      || Math.abs(input.deltaX) > 2000 || Math.abs(input.deltaY) > 2000)) return false
    const epoch = this.epoch
    const action = new AbortController()
    this.input = action
    this.view.set({ ...current, pending: true })
    try {
      const response = await this.fetcher('/api/ego/input', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: action.signal,
        body: JSON.stringify({ sessionId: this.sessionId, targetId, ...input }),
      })
      if (epoch !== this.epoch || action.signal.aborted || !response.ok) return false
      return true
    } catch { return false }
    finally {
      if (this.input === action) this.input = null
      if (epoch === this.epoch) {
        this.view.set({ ...this.view.getSnapshot(), pending: false })
      }
    }
  }

  private current(epoch: number, request: AbortController): boolean {
    return this.shown && epoch === this.epoch && this.request === request && !request.signal.aborted
  }

  private acceptPages(pages: readonly EgoPage[], relayOff = false): void {
    this.listVersion++
    const previous = this.view.getSnapshot()
    const selectedId = pages.find(page => page.targetId === this.selectedViewId)?.targetId
      ?? (this.selectedViewId === 'default' ? pages.find(page => page.targetId === previous.selectedId)?.targetId
        ?? pages.find(page => page.active)?.targetId ?? pages[0]?.targetId : null) ?? null
    const selected = pages.find(page => page.targetId === selectedId)
    const oldSelected = previous.pages.find(page => page.targetId === selectedId)
    const changed = selected?.url !== oldSelected?.url
      || selected?.viewportW !== oldSelected?.viewportW || selected?.viewportH !== oldSelected?.viewportH
    if (selectedId !== previous.selectedId || relayOff || changed) this.cancelFrameRefresh()
    this.view.set({ ...previous, phase: 'ready', pages, selectedId,
      frame: !relayOff && !changed && previous.frame?.targetId === selectedId ? previous.frame : null, relayOff })
    if (selectedId !== null && !relayOff && (changed || selectedId !== previous.selectedId
      || this.view.getSnapshot().frame === null)) this.refreshSelectedFrame()
  }

  private openStream(epoch: number): void {
    let stream: EventSource
    try { stream = this.connect(streamUrl(this.sessionId, '/api/ego/stream')) }
    catch { return }
    this.stream = stream
    stream.addEventListener('spaces', (event: MessageEvent) => {
      if (!this.shown || epoch !== this.epoch || typeof event.data !== 'string') return
      try { this.acceptPages(parseSpaces(JSON.parse(event.data) as unknown)) }
      catch { /* 畸形事件不替换上一份合法状态。 */ }
    })
    stream.addEventListener('frame', (event: MessageEvent) => {
      if (!this.shown || epoch !== this.epoch || typeof event.data !== 'string') return
      let frame: EgoFrame | null
      try { frame = parseFrame(JSON.parse(event.data) as unknown) }
      catch { return }
      const view = this.view.getSnapshot()
      if (!frame || view.relayOff || view.phase !== 'ready' || view.selectedId !== frame.targetId
        || !view.pages.some(page => page.targetId === frame.targetId)
        || (view.frame?.targetId === frame.targetId && frame.ts <= view.frame.ts)) return
      const page = view.pages.find(item => item.targetId === frame.targetId)
      if (page?.viewportW != null && page.viewportW !== frame.width
        || page?.viewportH != null && page.viewportH !== frame.height) return
      this.view.set({ ...view, frame })
    })
    stream.addEventListener('error', () => {
      if (!this.shown || epoch !== this.epoch || this.stream !== stream) return
      this.closeStream()
      this.clearTimer()
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null
        if (!this.shown || epoch !== this.epoch) return
        void this.refresh()
        this.openStream(epoch)
      }, 1500)
    })
  }

  /** 活动流只追加本会话的动作；不影响页面目录与画面。 */
  private openActivity(epoch: number): void {
    let stream: EventSource
    try { stream = this.connectActivity('/api/ego/activity') }
    catch { return }
    this.activity = stream
    stream.addEventListener('tool-call', (event: MessageEvent) => {
      if (!this.shown || epoch !== this.epoch || this.activity !== stream || typeof event.data !== 'string') return
      let activity
      try { activity = parseActivity(JSON.parse(event.data) as unknown) }
      catch { return }
      if (!activity || activity.sessionId !== this.sessionId) return
      const view = this.view.getSnapshot()
      this.view.set({ ...view, actions: appendAction(view.actions,
        { kind: activity.kind, at: activity.at ?? Date.now() }) })
    })
    stream.addEventListener('error', () => {
      // 活动流只是增强信息；断线后不再重试，历史接口在下次刷新时补齐。
      if (this.activity !== stream) return
      this.closeActivity()
    })
  }

  private clearTimer(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  private closeStream(): void {
    this.stream?.close()
    this.stream = null
  }

  private closeActivity(): void {
    this.activity?.close()
    this.activity = null
  }
}
