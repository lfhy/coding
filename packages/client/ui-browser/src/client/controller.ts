/** 会话浏览器轮询、修订版栅栏与截图 URL 的唯一所有者。 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { parseBrowserState, type BrowserState } from './wire.ts'

export type BrowserView =
  | { readonly phase: 'loading' | 'empty'; readonly state: null; readonly frameUrl: null }
  | { readonly phase: 'error'; readonly state: BrowserState | null; readonly frameUrl: string | null; readonly message: string }
  | { readonly phase: 'ready'; readonly state: BrowserState; readonly frameUrl: string | null }

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
const POLL_MS = 750
const INITIAL: BrowserView = { phase: 'loading', state: null, frameUrl: null }

function hostUrl(path: string, sessionId: string): URL {
  const base = globalThis.location.origin === 'null' ? 'http://dsh.internal' : globalThis.location.origin
  const url = new URL(path, base)
  url.searchParams.set('sessionId', sessionId)
  return url
}

/** 每个 Session 一个控制器；start/stop 由持续挂载的 slot 组件持有。 */
export class BrowserMirrorController {
  readonly view: SnapshotStore<BrowserView> = createSnapshotStore<BrowserView>(INITIAL)
  private active = false
  private initialized = false
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: AbortController | undefined
  private imageUrl: string | null = null
  private last: BrowserState | null = null
  private readonly retiredGenerations = new Set<string>()
  private opened: string | null = null
  private pendingOpen: string | null = null
  private onRevision: (() => void) | undefined

  /**
   * @param sessionId - 所属 Session，作为 Host 路由查询参数。
   * @param fetcher - 可替换的同源请求载体。
   */
  constructor(private readonly sessionId: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}

  /**
   * 开始轮询；首次已存在的观测作为基线，不抢用户当前文件视图。
   * @param onRevision - 挂载后新观测到达时打开浏览器视图。
   * @returns 停止轮询和撤销图片 URL 的 disposer。
   */
  start(onRevision: () => void): () => void {
    if (this.active) throw new Error('browser mirror already started')
    this.active = true
    this.onRevision = onRevision
    this.view.set(INITIAL)
    void this.poll(this.epoch)
    return () => { this.stop() }
  }

  /** 用户显式重试会清除错误并立即读取；不会制造并发请求。 */
  retry(): void {
    if (!this.active || this.pending) return
    this.clearTimer()
    this.view.set(INITIAL)
    void this.poll(this.epoch)
  }

  /** 插件及组件都可安全调用，退出后旧请求无法重新发布。 */
  stop(): void {
    this.active = false
    this.epoch++
    this.clearTimer()
    this.pending?.abort()
    this.pending = undefined
    this.releaseImage()
    this.last = null
    this.retiredGenerations.clear()
    this.initialized = false
    this.opened = null
    this.pendingOpen = null
    this.onRevision = undefined
    this.view.set(INITIAL)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private releaseImage(): void {
    if (this.imageUrl !== null) URL.revokeObjectURL(this.imageUrl)
    this.imageUrl = null
  }

  private current(epoch: number, pending: AbortController): boolean {
    return this.active && epoch === this.epoch && !pending.signal.aborted
  }

  private async poll(epoch: number): Promise<void> {
    if (!this.active || epoch !== this.epoch || this.pending) return
    const pending = new AbortController()
    this.pending = pending
    try {
      const response = await this.fetcher(hostUrl('/browser-use/state', this.sessionId), {
        signal: pending.signal, cache: 'no-store',
      })
      if (!this.current(epoch, pending)) return
      if (response.status === 204) {
        this.initialized = true
        this.last = null
        this.opened = null
        this.pendingOpen = null
        this.releaseImage()
        if (this.view.getSnapshot().phase !== 'empty') this.view.set({ phase: 'empty', state: null, frameUrl: null })
        return
      }
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const state = parseBrowserState(await response.json() as unknown)
      if (!this.current(epoch, pending)) return
      const previous = this.last
      const sameGeneration = previous?.generation === state.generation
      if (this.retiredGenerations.has(state.generation)) return
      if (sameGeneration && state.revision < previous.revision) return
      const changed = !sameGeneration || state.revision !== previous.revision
      if (!changed && this.view.getSnapshot().phase === 'ready') return
      const fresh = this.initialized && changed
      const key = `${state.generation}:${String(state.revision)}`
      if (fresh) this.pendingOpen = key
      this.initialized = true
      if (previous !== null && !sameGeneration) this.retiredGenerations.add(previous.generation)
      this.last = state
      if (state.hasFrame && (changed || this.imageUrl === null)) {
        const frame = hostUrl('/browser-use/frame', this.sessionId)
        frame.searchParams.set('generation', state.generation)
        frame.searchParams.set('revision', String(state.revision))
        const picture = await this.fetcher(frame, { signal: pending.signal, cache: 'no-store' })
        if (!this.current(epoch, pending)) return
        if (!picture.ok) throw new Error(`画面 HTTP ${String(picture.status)}`)
        if (picture.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('浏览器画面格式无效')
        const blob = await picture.blob()
        if (!this.current(epoch, pending)) return
        if (blob.size === 0 || blob.size > 2 * 1024 * 1024) throw new Error('浏览器画面大小无效')
        const url = URL.createObjectURL(blob)
        this.releaseImage()
        this.imageUrl = url
      } else if (!state.hasFrame) this.releaseImage()
      if (changed || this.view.getSnapshot().phase !== 'ready') {
        this.view.set({ phase: 'ready', state, frameUrl: this.imageUrl })
        if (this.pendingOpen === key && this.opened !== key) {
          this.opened = key
          this.pendingOpen = null
          this.onRevision?.()
        }
      }
    } catch (error) {
      if (!this.current(epoch, pending)) return
      const published = this.view.getSnapshot().state
      if (published?.generation !== this.last?.generation || published?.revision !== this.last?.revision) this.releaseImage()
      this.view.set({ phase: 'error', state: this.last, frameUrl: this.imageUrl,
        message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.pending === pending) this.pending = undefined
      if (this.current(epoch, pending)) this.timer = setTimeout(() => { void this.poll(epoch) }, POLL_MS)
    }
  }
}
