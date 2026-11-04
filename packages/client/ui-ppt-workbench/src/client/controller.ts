/**
 * 面板控制器：持有右侧工作台的会话级状态，负责与 `/api/ppt/*` 往返、轮询外部改动，
 * 并把每次编辑串行化。视图只读快照、只调这里的方法，不自己发请求。
 * @module coding-ppt-workbench/client/controller
 */

import { createSnapshotStore } from 'coding-client-runtime/client'
import type { PptElementKind, PptPage, SlideTransition } from 'coding-ppt-model'
import {
  errorOf, parseExport, parseSnapshot, parseState,
  type PptProjectView, type PptSnapshotView,
} from './wire.ts'

/** 面板底部的一条反馈。 */
export type PptNotice =
  | { readonly tone: 'saved'; readonly revision: number }
  | { readonly tone: 'exported'; readonly path: string }
  | { readonly tone: 'exporting' }
  | { readonly tone: 'conflict'; readonly revision: number }
  | { readonly tone: 'error'; readonly reason: string }

/** 面板订阅的完整状态。 */
export interface PptPanelState {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly root: string
  readonly projects: readonly PptProjectView[]
  readonly project: PptSnapshotView | null
  /** 当前页在 `project.deck.pages` 中的下标。 */
  readonly pageIndex: number
  readonly selectedId: string | null
  readonly editingId: string | null
  readonly busy: boolean
  readonly notice: PptNotice | null
  /** 最近一次质检的问题列表；未检查时为 null。 */
  readonly issues: readonly {
    readonly severity: 'error' | 'warning'
    readonly code: string
    readonly pageName: string
    readonly message: string
  }[] | null
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** 面板状态的可写视图：快照对外只读，控制器内部的 mutator 需要可写。 */
type MutablePanelState = { -readonly [K in keyof PptPanelState]: PptPanelState[K] }

const INITIAL: PptPanelState = {
  phase: 'loading', root: '', projects: [], project: null, pageIndex: 0,
  selectedId: null, editingId: null, busy: false, notice: null, issues: null,
}

const POLL_MS = 3000

/**
 * 一个会话一份控制器；同一工作台的所有可见实例共享它。
 */
export class PptPanelController {
  /** 渲染层订阅的快照。 */
  readonly view = createSnapshotStore<PptPanelState>(INITIAL)
  private visible = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly sessionId: string,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {}

  /**
   * 面板显隐；隐藏时停止轮询，显示时立即刷新一次。
   * @param shown - 面板是否可见。
   */
  show(shown: boolean): void {
    this.visible = Math.max(0, this.visible + (shown ? 1 : -1))
    if (this.visible > 0 && this.timer === null) {
      void this.refresh()
      this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
    } else if (this.visible === 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 卸载时停止轮询，之后的异步结果一律丢弃。 */
  dispose(): void {
    this.disposed = true
    this.visible = 0
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private patch(mutator: (draft: MutablePanelState) => void): void {
    if (this.disposed) return
    this.view.update(mutator)
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`/api/ppt/${path}`, init)
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const conflict = response.status === 409
      const reason = errorOf(payload, response.statusText)
      const failure = new Error(reason) as Error & { conflict?: boolean }
      failure.conflict = conflict
      throw failure
    }
    return payload
  }

  private post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, ...body }),
    })
  }

  /** 读取一次整体状态；模型要求打开别的工程时跟随过去。 */
  async refresh(): Promise<void> {
    try {
      const payload = await this.request(`state?${new URLSearchParams({ sessionId: this.sessionId }).toString()}`)
      const state = parseState(payload)
      if (state === null) throw new Error('state payload is malformed')
      if (state.openRequest !== null && state.openRequest.dir !== state.active?.dir) {
        await this.post('open', { dir: state.openRequest.dir })
        await this.post('ack', { at: state.openRequest.at })
        await this.refresh()
        return
      }
      const current = this.view.getSnapshot()
      const project = state.active
      const pageIndex = project === null ? 0 : clampPageIndex(project, current.pageIndex)
      this.patch((draft) => {
        draft.phase = 'ready'
        draft.root = state.root
        draft.projects = state.projects
        draft.project = project
        draft.pageIndex = pageIndex
        if (project !== null && current.selectedId !== null
          && !currentPage(project, pageIndex)?.elements.some(element => element.id === current.selectedId)) {
          draft.selectedId = null
        }
      })
    } catch (reason) {
      this.patch((draft) => {
        draft.phase = 'error'
        draft.notice = { tone: 'error', reason: reason instanceof Error ? reason.message : String(reason) }
      })
    }
  }

  /**
   * 打开一个工程。
   * @param dir - 工作区相对目录。
   */
  async open(dir: string): Promise<void> {
    await this.run(async () => {
      const payload = await this.post('open', { dir })
      this.adopt(payload)
    })
  }

  /**
   * 新建工程并打开。
   * @param title - 演示文稿标题。
   */
  async create(title: string): Promise<void> {
    await this.run(async () => {
      const payload = await this.post('create', { title })
      this.adopt(payload)
    })
  }

  private adopt(payload: unknown): void {
    const snapshot = parseSnapshot((payload as { project?: unknown } | null)?.project)
    if (snapshot === null) throw new Error('project payload is malformed')
    this.patch((draft) => {
      draft.phase = 'ready'
      draft.project = snapshot
      draft.pageIndex = clampPageIndex(snapshot, draft.pageIndex)
      draft.selectedId = null
      draft.editingId = null
      draft.notice = { tone: 'saved', revision: snapshot.revision }
    })
  }

  /**
   * 依次执行一次互斥的服务端操作；期间面板显示忙碌态。
   * @param task - 需要独占的操作。
   */
  private async run(task: () => Promise<void>): Promise<void> {
    this.patch((draft) => { draft.busy = true })
    const next = this.inflight.then(task, task)
    this.inflight = next.catch(() => undefined)
    try {
      await next
    } catch (reason) {
      const conflict = (reason as { conflict?: boolean }).conflict === true
      this.patch((draft) => {
        draft.notice = conflict
          ? { tone: 'conflict', revision: draft.project?.revision ?? 0 }
          : { tone: 'error', reason: reason instanceof Error ? reason.message : String(reason) }
      })
    } finally {
      this.patch((draft) => { draft.busy = false })
    }
  }

  /**
   * 提交一次编辑；成功时用返回的工程替换本地状态。
   * @param ops - 已构造好的编辑步骤。
   */
  async edit(ops: readonly unknown[]): Promise<void> {
    const project = this.view.getSnapshot().project
    if (project === null) return
    await this.run(async () => {
      const payload = await this.post('edit', { dir: project.dir, baseRevision: project.revision, ops })
      this.adopt(payload)
    })
  }

  /** 撤销一步。 */
  async undo(): Promise<void> {
    await this.run(async () => { this.adopt(await this.post('undo', {})) })
  }

  /** 重做一步。 */
  async redo(): Promise<void> {
    await this.run(async () => { this.adopt(await this.post('redo', {})) })
  }

  /** 导出当前版本为 .pptx。 */
  async exportDeck(): Promise<void> {
    this.patch((draft) => { draft.notice = { tone: 'exporting' } })
    await this.run(async () => {
      const payload = await this.post('export', {})
      const result = parseExport(payload)
      if (result === null) throw new Error('export payload is malformed')
      this.patch((draft) => { draft.notice = { tone: 'exported', path: result.path } })
    })
  }

  /**
   * 选中一页；同时清掉元素选择。
   * @param index - 页码下标。
   */
  selectPage(index: number): void {
    this.patch((draft) => { draft.pageIndex = index; draft.selectedId = null })
  }

  /**
   * 选中元素。
   * @param id - 元素 id，null 表示取消选择。
   */
  selectElement(id: string | null): void {
    this.patch((draft) => { draft.selectedId = id })
  }

  /**
   * 进入或退出就地文字编辑。
   * @param id - 正在编辑的元素 id，null 表示结束。
   */
  setEditing(id: string | null): void {
    this.patch((draft) => { draft.editingId = id })
  }

  /** 追加一页并切换过去。 */
  async addPage(): Promise<void> {
    await this.edit([{ op: 'add_page' }])
    const project = this.view.getSnapshot().project
    if (project !== null) this.selectPage(project.deck.pages.length - 1)
  }

  /**
   * 删除某一页。
   * @param pageId - 页面 id。
   */
  async removePage(pageId: string): Promise<void> {
    await this.edit([{ op: 'remove_page', page: pageId }])
    const project = this.view.getSnapshot().project
    if (project !== null) this.selectPage(clampPageIndex(project, this.view.getSnapshot().pageIndex))
  }

  /**
   * 调整页序。
   * @param pageId - 页面 id。
   * @param to - 目标下标。
   */
  async movePage(pageId: string, to: number): Promise<void> {
    await this.edit([{ op: 'move_page', page: pageId, to }])
    this.selectPage(to)
  }

  /**
   * 在当前页追加一个元素。
   * @param kind - 元素种类。
   */
  async addElement(kind: PptElementKind): Promise<void> {
    const state = this.view.getSnapshot()
    const page = currentPage(state.project, state.pageIndex)
    const project = state.project
    if (page === null || project === null) return
    await this.edit([{ op: 'add_element', page: page.id, element: newElement(kind, page.elements.length) }])
  }

  /**
   * 删除元素。
   * @param elementId - 元素 id。
   */
  async removeElement(elementId: string): Promise<void> {
    const state = this.view.getSnapshot()
    const page = currentPage(state.project, state.pageIndex)
    if (page === null) return
    this.selectElement(null)
    await this.edit([{ op: 'remove_element', page: page.id, element: elementId }])
  }

  /**
   * 修改元素。
   * @param elementId - 元素 id。
   * @param patch - 位置尺寸、文字、填充或描边。
   */
  async updateElement(elementId: string, patch: {
    frame?: Partial<{ x: number; y: number; w: number; h: number }>
    text?: Partial<{ content: string; size: number; color: string; bold: boolean; align: string; valign: string }>
    fill?: string
    color?: string
    width?: number
  }): Promise<void> {
    const state = this.view.getSnapshot()
    const page = currentPage(state.project, state.pageIndex)
    if (page === null) return
    await this.edit([{ op: 'update_element', page: page.id, element: elementId, ...patch }])
  }

  /**
   * 复制元素。
   * @param elementId - 元素 id。
   */
  async duplicateElement(elementId: string): Promise<void> {
    const page = currentPage(this.view.getSnapshot().project, this.view.getSnapshot().pageIndex)
    if (page === null) return
    await this.edit([{ op: 'duplicate_element', page: page.id, element: elementId }])
  }

  /**
   * 调整元素层级。
   * @param elementId - 元素 id。
   * @param to - 置顶、置底、上移一层或下移一层。
   */
  async reorderElement(elementId: string, to: 'front' | 'back' | 'forward' | 'backward'): Promise<void> {
    const page = currentPage(this.view.getSnapshot().project, this.view.getSnapshot().pageIndex)
    if (page === null) return
    await this.edit([{ op: 'reorder_element', page: page.id, element: elementId, to }])
  }

  /**
   * 上传一张图片到工程并插入当前页。
   * @param file - 浏览器选择的图片文件。
   */
  async insertImage(file: File): Promise<void> {
    const state = this.view.getSnapshot()
    const page = currentPage(state.project, state.pageIndex)
    if (page === null) return
    await this.run(async () => {
      const buffer = new Uint8Array(await file.arrayBuffer())
      const upload = await this.post('upload', { dir: state.project?.dir, name: file.name, base64: toBase64(buffer) })
      const source = (upload as { source?: unknown } | null)?.source
      if (typeof source !== 'string') throw new Error('upload payload is malformed')
      const payload = await this.post('edit', {
        dir: state.project?.dir,
        baseRevision: state.project?.revision,
        ops: [{
          op: 'add_element', page: page.id,
          element: { kind: 'image', source, fit: 'cover', x: 160, y: 120, w: 640, h: 360 },
        }],
      })
      this.adopt(payload)
    })
  }

  /** 运行一次规则质检并把结果挂到状态上。 */
  async checkDeck(): Promise<void> {
    await this.run(async () => {
      const payload = await this.post('check', {})
      const check = (payload as { check?: unknown } | null)?.check
      const issues = parseCheck(check)
      if (issues === null) throw new Error('check payload is malformed')
      this.patch((draft) => { draft.issues = issues })
    })
  }

  /**
   * 修改当前页的名称、底色或转场。
   * @param patch - 页面属性。
   */
  async updatePage(patch: { name?: string; background?: string | null; transition?: SlideTransition }): Promise<void> {
    const state = this.view.getSnapshot()
    const page = currentPage(state.project, state.pageIndex)
    if (page === null) return
    await this.edit([{ op: 'update_page', page: page.id, ...patch }])
  }

  /**
   * 修改整份演示文稿的标题、画布或主题。
   * @param patch - 文稿属性。
   */
  async updateDeck(patch: { title?: string; size?: '16:9' | '4:3'; theme?: string }): Promise<void> {
    await this.edit([{ op: 'update_deck', ...patch }])
  }
}

/**
 * 取当前页。
 * @param project - 工程快照。
 * @param index - 页码下标。
 * @returns 页面；没有工程或下标越界时 null。
 */
export function currentPage(project: PptSnapshotView | null, index: number): PptPage | null {
  if (project === null) return null
  return project.deck.pages[index] ?? null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 解析质检响应。
 * @param value - 响应里的 `check` 字段。
 * @returns 问题列表；结构不完整时 null。
 */
export function parseCheck(value: unknown): PptPanelState['issues'] {
  if (typeof value !== 'object' || value === null) return null
  const issues = (value as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return null
  return issues.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const severity = record.severity === 'error' ? 'error' : record.severity === 'warning' ? 'warning' : null
    if (severity === null || typeof record.code !== 'string'
      || typeof record.pageName !== 'string' || typeof record.message !== 'string') return []
    return [{ severity, code: record.code, pageName: record.pageName, message: record.message }]
  })
}

function clampPageIndex(project: PptSnapshotView, index: number): number {
  return Math.min(Math.max(index, 0), Math.max(project.deck.pages.length - 1, 0))
}

/** 新元素的默认几何：按已有元素数量错位摆放，避免完全重叠。 */
function newElement(kind: PptElementKind, count: number): Record<string, unknown> {
  const offset = (count % 6) * 24
  const base = { x: 120 + offset, y: 140 + offset }
  if (kind === 'table') {
    return {
      kind, ...base, w: 720, h: 264, rows: 3, columns: 3, header: true,
      cells: [
        [{ content: '项目' }, { content: '本期' }, { content: '上期' }],
        [{ content: '' }, { content: '' }, { content: '' }],
        [{ content: '' }, { content: '' }, { content: '' }],
      ],
    }
  }
  if (kind === 'text') {
    return {
      kind, ...base, w: 520, h: 96,
      text: { content: '双击编辑文字', size: 32, bold: false, align: 'left', valign: 'top' },
    }
  }
  if (kind === 'line') return { kind, ...base, w: 640, h: 0, color: '#9aa7b4', width: 4 }
  return { kind, ...base, w: 320, h: 200, fill: '#4f8cff' }
}
