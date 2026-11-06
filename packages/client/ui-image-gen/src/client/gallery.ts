/** 单会话画廊：旧读取可取消，新图提交后重新读取 Host 权威目录。 */
import { createSnapshotStore, type SnapshotStore } from 'coding-client-runtime/client'
import { generateImage, imageUrl, importReference, readGallery, readState, type GalleryItem, type ImageOutput, type ImageState } from './wire.ts'
import type { CanvasViewState } from './canvas.ts'
import type { ImageSettingsFace } from './settings.ts'

/** 只保留图片元数据与读取状态，原始字节由浏览器访问同会话受限地址。 */
export interface GalleryViewState {
  phase: 'loading' | 'ready' | 'error'
  state: ImageState | null
  items: GalleryItem[]
  generating: boolean
  uploading: boolean
  lastResultId: string | null
  failed: boolean
}

/** 画廊的只读源、请求、工作台设置及画布放置动作。 */
export interface GalleryFace {
  hooks: {
    gallery: SnapshotStore<GalleryViewState>
    imageCanvas: SnapshotStore<CanvasViewState>
    imageSettings: ImageSettingsFace['hooks']['imageSettings']
  }
  show: (shown: boolean) => void
  refresh: () => void
  generate: (prompt: string, imageId?: string | readonly string[], output?: ImageOutput) => Promise<boolean>
  importReference: (file: File) => Promise<GalleryItem | undefined>
  place: (imageId: string) => Promise<boolean>
  saveSettings: ImageSettingsFace['save']
  url: (id: string) => string
  canvas: {
    show: (shown: boolean) => void
    refresh: () => void
    add: (node: import('./wire.ts').CanvasNode) => Promise<boolean>
    select: (id: string | null) => void
    move: (id: string, x: number, y: number) => Promise<boolean>
    remove: () => Promise<boolean>
    clear: () => Promise<boolean>
    url: (id: string) => string
  }
}

/** 每个 Session 独占一个目录控制器，隐藏与卸载均取消请求。 */
export class GalleryController {
  readonly view = createSnapshotStore<GalleryViewState>({ phase: 'loading', state: null, items: [], generating: false,
    uploading: false, lastResultId: null, failed: false })
  private abort: AbortController | undefined
  private generation = 0
  private shown = false
  private disposed = false
  private poll: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined

  private active(): boolean { return this.shown && !this.disposed }

  /** @param sessionId - 图片所属的会话。 */
  constructor(readonly sessionId: string) {}

  /** 组件隐藏时取消请求；返回后重取，以包含其他入口产生的新图片。 */
  show(shown: boolean): void {
    if (this.shown === shown || this.disposed) return
    this.shown = shown
    if (shown) {
      void this.refresh()
      this.poll = setInterval(() => { if (this.inFlight === undefined) void this.refresh() }, 3_000)
    } else {
      this.abort?.abort()
      if (this.poll !== undefined) clearInterval(this.poll)
      this.poll = undefined
    }
  }

  /** 同时刷新状态与目录，已加载的图片在刷新期间继续显示。 */
  async refresh(): Promise<void> {
    if (this.disposed || !this.shown) return
    if (this.inFlight !== undefined) {
      this.abort?.abort()
      await this.inFlight
      if (this.abort?.signal.aborted && this.poll === undefined) return
    }
    this.abort?.abort()
    const controller = new AbortController()
    this.abort = controller
    const generation = ++this.generation
    if (this.view.getSnapshot().items.length === 0) this.view.update((draft) => { draft.phase = 'loading' })
    const reading = Promise.all([
      readState(this.sessionId, controller.signal), readGallery(this.sessionId, controller.signal),
    ])
    this.inFlight = reading.then(() => {}, () => {})
    try {
      const [state, gallery] = await reading
      if (controller.signal.aborted || generation !== this.generation) return
      this.view.update((draft) => { draft.phase = 'ready'; draft.state = state; draft.items = gallery.items })
    } catch {
      if (generation !== this.generation || controller.signal.aborted) return
      this.view.update((draft) => { draft.phase = 'error' })
    } finally {
      if (generation === this.generation) this.inFlight = undefined
    }
  }

  /**
   * 保存新图后刷新，目录仍由 Host 的会话索引作准；失败不伪造本地图片项。
   * @param prompt - 非空用户描述。
   * @param imageId - 编辑时的同会话图片 id。
   * @returns 请求是否成功。
   */
  async generate(prompt: string, imageId?: string | readonly string[], output?: ImageOutput): Promise<boolean> {
    if (!this.shown || this.disposed || this.view.getSnapshot().generating || this.view.getSnapshot().uploading
      || this.view.getSnapshot().state?.available !== true || !prompt.trim()) return false
    this.view.update((draft) => { draft.generating = true; draft.failed = false })
    try {
      const item = await generateImage(this.sessionId, prompt.trim(), imageId, output)
      if (this.poll === undefined) return false
      await this.refresh()
      this.view.update((draft) => { draft.lastResultId = item.id })
      return true
    } catch {
      if (this.poll !== undefined) this.view.update((draft) => { draft.failed = true })
      return false
    } finally {
      if (this.poll !== undefined) this.view.update((draft) => { draft.generating = false })
    }
  }

  /**
   * 参考图先由 Host 附件服务准入并记入当前会话图库，再交给编辑操作引用。
   * @param file - 用户从本机选择的单张原始图。
   * @returns 持久图库项；失败或已卸载返回 undefined。
   */
  async importReference(file: File): Promise<GalleryItem | undefined> {
    if (!this.shown || this.disposed || this.view.getSnapshot().uploading || this.view.getSnapshot().generating) return undefined
    this.view.update((draft) => { draft.uploading = true; draft.failed = false })
    try {
      const item = await importReference(this.sessionId, file)
      if (!this.active()) return undefined
      await this.refresh()
      return item
    } catch {
      if (this.active()) this.view.update((draft) => { draft.failed = true })
      return undefined
    } finally {
      if (this.active()) this.view.update((draft) => { draft.uploading = false })
    }
  }

  /** 从 Host 图片路由取原字节的地址。 */
  url(id: string): string { return imageUrl(this.sessionId, id) }

  /** 卸载会话时释放请求，避免迟到的旧结果覆盖下一次挂载。 */
  dispose(): void {
    this.disposed = true
    this.abort?.abort()
    if (this.poll !== undefined) clearInterval(this.poll)
  }
}
