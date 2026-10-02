/** 会话浏览器轮询、人工命令和截图 URL 的唯一所有者。 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrowserHumanCommand } from '@deepseek-ai/dsh-browser/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { parseBrowserState, parseBrowserStateOrLock, type BrowserState } from './wire.ts'

export type BrowserView =
  | { readonly phase: 'loading' | 'empty'; readonly state: null; readonly frameUrl: null; readonly pending: boolean }
  | { readonly phase: 'busy'; readonly state: null; readonly frameUrl: null; readonly pending: boolean }
  | { readonly phase: 'error'; readonly state: BrowserState | null; readonly frameUrl: string | null; readonly message: string; readonly pending: boolean }
  | { readonly phase: 'ready'; readonly state: BrowserState; readonly frameUrl: string | null; readonly pending: boolean }

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Control = ConnectionHandle['api']['browser']['control']
const POLL_MS = 750
const INITIAL: BrowserView = { phase: 'loading', state: null, frameUrl: null, pending: false }

function hostUrl(path: string, sessionId: string): URL {
  const base = globalThis.location.origin === 'null' ? 'http://dsh.internal' : globalThis.location.origin
  const url = new URL(path, base)
  url.searchParams.set('sessionId', sessionId)
  return url
}

/** 每个 Session 一个控制器；两个 slot 共享同一个稳定快照。 */
export class BrowserMirrorController {
  readonly view: SnapshotStore<BrowserView> = createSnapshotStore<BrowserView>(INITIAL)
  private active = false
  private initialized = false
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: AbortController | undefined
  private action: AbortController | undefined
  private imageUrl: string | null = null
  private last: BrowserState | null = null
  private readonly retiredGenerations = new Set<string>()
  private opened: string | null = null
  private pendingOpen: string | null = null
  private urgent = false
  private onRevision: ((state: BrowserState) => void) | undefined

  /**
   * @param sessionId - 当前会话。
   * @param fetcher - 同源状态和画面载体。
   * @param control - 经过连接服务的人工命令入口。
   */
  constructor(private readonly sessionId: string,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly control?: Control) {}

  /**
   * 内容 slot 挂载期间轮询；基线状态不抢占文件视图。
   * @param onRevision - 新观测出现后，以同一份已发布状态执行的导航动作。
   * @returns 终止轮询的 disposer。
   */
  start(onRevision: (state: BrowserState) => void): () => void {
    if (this.active) throw new Error('browser mirror already started')
    this.active = true
    this.onRevision = onRevision
    this.view.set(INITIAL)
    void this.poll(this.epoch)
    return () => { this.stop() }
  }

  /** 只在用户实际打开浏览器视图后幂等建立首标签。 */
  async ensureTab(): Promise<void> {
    if (!this.active || this.last !== null || this.action !== undefined || this.view.getSnapshot().phase === 'busy') return
    await this.command({ kind: 'ensure-tab' })
  }

  /**
   * 执行当前会话的用户浏览器操作。
   * @param command - 经 RPC 严格校验的命令。
   * @returns 命令和对应截图同步完毕。
   */
  async command(command: BrowserHumanCommand): Promise<boolean> {
    if (!this.active || this.action !== undefined || this.control === undefined
      || this.view.getSnapshot().phase === 'busy' || this.view.getSnapshot().state?.operationActive) return false
    if ('target' in command) {
      const { state, frameUrl, phase, pending } = this.view.getSnapshot()
      const observation = state?.observation
      if (phase !== 'ready' || pending || frameUrl === null || !state.hasFrame || !observation
        || state.browserGeneration !== command.target.browserGeneration
        || state.stateRevision !== command.target.stateRevision
        || state.activeTabId !== command.target.tabId
        || observation.generation !== command.target.generation
        || observation.revision !== command.target.revision
        || state.viewport.width !== command.target.viewport.width
        || state.viewport.height !== command.target.viewport.height
        || observation.viewport.width !== command.target.viewport.width
        || observation.viewport.height !== command.target.viewport.height) return false
    }
    this.epoch++
    this.clearTimer()
    this.pending?.abort()
    this.pending = undefined
    const epoch = this.epoch
    const action = new AbortController()
    this.action = action
    this.view.set({ ...this.view.getSnapshot(), pending: true })
    try {
      const response = await this.control({ sessionId: this.sessionId as SessionId, command }, action.signal)
      if (!this.current(epoch, action)) return false
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (response.result.value === null) this.clearState()
      else await this.accept(parseBrowserState(response.result.value), epoch, action, false)
      return true
    } catch (error) {
      if (this.current(epoch, action)) this.fail(error)
      return false
    } finally {
      if (this.action === action) this.action = undefined
      if (this.current(epoch, action)) {
        const view = this.view.getSnapshot()
        if (view.pending) this.view.set({ ...view, pending: false })
        this.schedule(epoch)
      }
    }
  }

  /** 错误后立即读取而不并发。 */
  retry(): void {
    if (!this.active || this.pending || this.action) return
    this.clearTimer()
    void this.poll(this.epoch)
  }

  /** 销毁时旧请求不能发布且释放 Blob。 */
  stop(): void {
    this.active = false
    this.epoch++
    this.clearTimer()
    this.pending?.abort()
    this.action?.abort()
    this.pending = undefined
    this.action = undefined
    this.releaseImage()
    this.last = null
    this.retiredGenerations.clear()
    this.initialized = false
    this.opened = null
    this.pendingOpen = null
    this.urgent = false
    this.onRevision = undefined
    this.view.set(INITIAL)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
  private schedule(epoch: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => { void this.poll(epoch) }, POLL_MS)
  }
  private releaseImage(): void {
    if (this.imageUrl !== null) URL.revokeObjectURL(this.imageUrl)
    this.imageUrl = null
  }
  private current(epoch: number, pending: AbortController): boolean {
    return this.active && epoch === this.epoch && !pending.signal.aborted
  }
  private clearState(): void {
    this.initialized = true
    this.last = null
    this.opened = null
    this.pendingOpen = null
    this.releaseImage()
    this.view.set({ phase: 'empty', state: null, frameUrl: null, pending: false })
  }
  private lockWithoutState(): void {
    this.initialized = true
    this.last = null
    this.opened = null
    this.pendingOpen = null
    this.releaseImage()
    this.view.set({ phase: 'busy', state: null, frameUrl: null, pending: false })
  }
  private fail(error: unknown): void {
    const published = this.view.getSnapshot()
    if (published.state?.browserGeneration !== this.last?.browserGeneration
      || published.state?.stateRevision !== this.last?.stateRevision) this.releaseImage()
    this.view.set({ phase: 'error', state: this.last, frameUrl: this.imageUrl,
      message: error instanceof Error ? error.message : String(error), pending: false })
  }

  private async accept(state: BrowserState, epoch: number, pending: AbortController, autoOpen: boolean): Promise<void> {
    if (!this.current(epoch, pending)) return
    const previous = this.last
    if (this.retiredGenerations.has(state.browserGeneration)
      || (previous?.browserGeneration === state.browserGeneration && state.stateRevision < previous.stateRevision)) return
    const revisionChanged = previous?.browserGeneration !== state.browserGeneration || previous.stateRevision !== state.stateRevision
    const changed = revisionChanged || previous.operationActive !== state.operationActive
    if (!changed && this.view.getSnapshot().phase === 'ready') return
    const fresh = this.initialized && revisionChanged
    const key = `${state.browserGeneration}:${String(state.stateRevision)}`
    if (autoOpen && fresh && state.observation !== null) this.pendingOpen = key
    this.initialized = true
    if (previous && previous.browserGeneration !== state.browserGeneration) this.retiredGenerations.add(previous.browserGeneration)
    this.last = state
    const oldObservation = previous?.observation
    const observation = state.observation
    const sameFrame = previous?.browserGeneration === state.browserGeneration
      && previous.activeTabId === state.activeTabId
      && oldObservation?.generation === observation?.generation
      && oldObservation?.revision === observation?.revision
    if (state.hasFrame && observation && (!sameFrame || this.imageUrl === null)) {
      const frame = hostUrl('/browser-use/frame', this.sessionId)
      frame.searchParams.set('tabId', observation.tabId)
      frame.searchParams.set('browserGeneration', state.browserGeneration)
      frame.searchParams.set('stateRevision', String(state.stateRevision))
      frame.searchParams.set('generation', observation.generation)
      frame.searchParams.set('revision', String(observation.revision))
      const picture = await this.fetcher(frame, { signal: pending.signal, cache: 'no-store' })
      if (!this.current(epoch, pending)) return
      if (picture.status === 409) {
        this.releaseImage()
        this.view.set({ phase: 'ready', state, frameUrl: null, pending: false })
        this.urgent = true
        return
      }
      if (!picture.ok) throw new Error(`画面 HTTP ${String(picture.status)}`)
      if (picture.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('浏览器画面格式无效')
      const blob = await picture.blob()
      if (!this.current(epoch, pending)) return
      if (blob.size === 0 || blob.size > 2 * 1024 * 1024) throw new Error('浏览器画面大小无效')
      const url = URL.createObjectURL(blob)
      this.releaseImage()
      this.imageUrl = url
    } else if (!state.hasFrame || !sameFrame) this.releaseImage()
    if (!this.current(epoch, pending)) return
    this.view.set({ phase: 'ready', state, frameUrl: this.imageUrl, pending: this.action !== undefined })
    if (autoOpen && this.pendingOpen === key && this.opened !== key) {
      this.opened = key
      this.pendingOpen = null
      this.onRevision?.(state)
    }
  }

  private async poll(epoch: number): Promise<void> {
    if (!this.active || epoch !== this.epoch || this.action || this.pending) return
    const pending = new AbortController()
    this.pending = pending
    try {
      const response = await this.fetcher(hostUrl('/browser-use/state', this.sessionId), {
        signal: pending.signal, cache: 'no-store',
      })
      if (!this.current(epoch, pending)) return
      if (response.status === 204) { this.clearState(); return }
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const state = parseBrowserStateOrLock(await response.json() as unknown)
      if ('browserGeneration' in state) await this.accept(state, epoch, pending, true)
      else this.lockWithoutState()
    } catch (error) {
      if (this.current(epoch, pending)) this.fail(error)
    } finally {
      if (this.pending === pending) this.pending = undefined
      if (this.current(epoch, pending)) {
        if (this.urgent) {
          this.urgent = false
          this.timer = setTimeout(() => { void this.poll(epoch) }, 0)
        } else this.schedule(epoch)
      }
    }
  }
}
