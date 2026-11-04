/** 会话级画布队列：本地操作按 Host revision 顺序写入，冲突不覆盖远端。 */
import { createSnapshotStore, type SnapshotStore } from 'coding-client-runtime/client'
import { readCanvas, writeCanvas, type CanvasDocument, type CanvasNode, type CanvasSnapshot, type ImageNode } from './wire.ts'

/** 一次会话画布的用户可见状态。 */
export interface CanvasViewState {
  phase: 'loading' | 'ready' | 'error'
  nodes: CanvasNode[]
  selectedId: string | null
  saving: boolean
  issue: 'save' | 'conflict' | null
}

/** 会话画布的动作及渲染数据源。 */
export interface CanvasFace {
  hooks: { imageCanvas: SnapshotStore<CanvasViewState> }
  show: (shown: boolean) => void
  refresh: () => void
  add: (node: CanvasNode) => Promise<boolean>
  select: (id: string | null) => void
  move: (id: string, x: number, y: number) => Promise<boolean>
  remove: () => Promise<boolean>
  clear: () => Promise<boolean>
  url: (id: string) => string
}

/** 保存冲突前暂停编辑，用户明确刷新后才能继续；避免静默丢失改动。 */
export class CanvasController {
  readonly view = createSnapshotStore<CanvasViewState>({
    phase: 'loading', nodes: [], selectedId: null, saving: false, issue: null,
  })
  private snapshot: CanvasSnapshot | undefined
  private shown = false
  private disposed = false
  private request: AbortController | undefined
  private generation = 0
  private writes: Promise<void> = Promise.resolve()
  private loading: Promise<void> | undefined
  private queuedImages: ImageNode[] = []

  /** @param sessionId - 此画布的唯一持久化会话。 @param imageUrl - 同会话图片地址生成器。 */
  constructor(readonly sessionId: string, private readonly imageUrl: (id: string) => string) {}

  /** 隐藏只停止读取，不丢掉尚未保存的本地节点。 */
  show(shown: boolean): void {
    if (this.shown === shown || this.disposed) return
    this.shown = shown
    if (shown && this.snapshot === undefined) void this.refresh()
    else if (!shown) this.request?.abort()
  }

  /** 请求旧结果若已被新请求取代或组件隐藏则丢弃。 */
  async refresh(): Promise<void> {
    if (this.disposed || !this.shown) return
    await this.writes
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    const generation = ++this.generation
    this.view.update((draft) => { draft.phase = 'loading' })
    const loading = readCanvas(this.sessionId, request.signal).then(async (snapshot) => {
      if (request.signal.aborted || generation !== this.generation) return
      this.snapshot = snapshot
      this.view.update((draft) => {
        draft.phase = 'ready'; draft.nodes = snapshot.state.nodes; draft.selectedId = null; draft.issue = null
      })
      const queued = this.queuedImages.splice(0)
      for (const node of queued) {
        if (!await this.add(node)) break
      }
    }).catch(() => {
      if (generation !== this.generation || request.signal.aborted) return
      this.view.update((draft) => { draft.phase = 'error' })
    })
    this.loading = loading
    await loading
    if (this.loading === loading) this.loading = undefined
  }

  /** 画廊图片落在画布上：只保存 ID，不存图片副本。 */
  async addImage(imageId: string, width: number, height: number): Promise<boolean> {
    const scale = Math.min(360 / Math.max(width, 1), 360 / Math.max(height, 1), 1)
    const node: ImageNode = { id: crypto.randomUUID(), type: 'image', imageId, x: 24, y: 24,
      width: Math.min(936, Math.round(width * scale) || 320),
      height: Math.min(616, Math.round(height * scale) || 320) }
    if (this.snapshot !== undefined && this.view.getSnapshot().phase === 'ready') return this.add(node)
    this.queuedImages.push(node)
    if (!this.shown) {
      this.shown = true
      try { await this.refresh() } finally { this.shown = false }
    } else if (this.loading !== undefined) await this.loading
    else await this.refresh()
    return this.view.getSnapshot().issue === null && this.view.getSnapshot().nodes.some(item => item.id === node.id)
  }

  /** @returns 同会话、受 Host 逐请求校验的原图地址。 */
  url(id: string): string { return this.imageUrl(id) }

  /** @param id - 要选中的节点；不存在时清除选择。 */
  select(id: string | null): void {
    this.view.update((draft) => { draft.selectedId = draft.nodes.some(node => node.id === id) ? id : null })
  }

  /** @param node - 一条完整轨迹或会话图片。 @returns 保存成功状态。 */
  add(node: CanvasNode): Promise<boolean> {
    return this.mutate(nodes => [...nodes, node])
  }

  /** @param id - 被移动的图片节点。 @param x - 新横坐标。 @param y - 新纵坐标。 */
  move(id: string, x: number, y: number): Promise<boolean> {
    return this.mutate(nodes => nodes.map(node => node.id === id && node.type === 'image'
      ? { ...node, x: Math.max(0, Math.min(960 - node.width, x)),
        y: Math.max(0, Math.min(640 - node.height, y)) } satisfies ImageNode : node))
  }

  /** @returns 删除当前选中节点的保存结果。 */
  remove(): Promise<boolean> {
    const selected = this.view.getSnapshot().selectedId
    if (selected === null) return Promise.resolve(false)
    return this.mutate(nodes => nodes.filter(node => node.id !== selected))
  }

  /** @returns 清空节点的保存结果；图库不受影响。 */
  clear(): Promise<boolean> { return this.mutate(() => []) }

  private mutate(transform: (nodes: CanvasNode[]) => CanvasNode[]): Promise<boolean> {
    if (this.disposed || this.view.getSnapshot().phase !== 'ready' || this.view.getSnapshot().issue === 'conflict') return Promise.resolve(false)
    const next = transform(this.view.getSnapshot().nodes)
    this.view.update((draft) => { draft.nodes = next; draft.selectedId = null; draft.saving = true; draft.issue = null })
    const document: CanvasDocument = { version: 1, nodes: next }
    const task = this.writes.then(async () => {
      if (this.disposed || this.snapshot === undefined || this.view.getSnapshot().issue === 'conflict') return false
      try {
        this.snapshot = await writeCanvas(this.sessionId, { revision: this.snapshot.revision, state: document })
        if (this.request?.signal.aborted !== true) this.view.update((draft) => { draft.saving = false })
        return true
      } catch (error) {
        if (this.request?.signal.aborted !== true) this.view.update((draft) => {
          draft.saving = false
          draft.issue = error instanceof Error && error.message.includes('409') ? 'conflict' : 'save'
        })
        return false
      }
    })
    this.writes = task.then(() => {})
    return task
  }

  /** 卸载即停止读取；已发往 Host 的写入按其自然结算，不再发布状态。 */
  dispose(): void { this.disposed = true; this.request?.abort() }
}
