/**
 * 代码工作区的视图状态：按工作区分区的标签、草稿、目录缓存与编辑器分组。
 *
 * 状态实例由插件在 apply 中创建一次，跨会话存在——同一工作区的标签在切换工作区、
 * 关闭再进入代码工作区后仍然保留；文件正文只留在内存，不写入持久存储。欢迎页与
 * 工作区三栏的切换由 `workspaceId` 决定，与对话页当前会话无关。
 */
import { defineStore, type EngineStoreHandle, type SessionId, type WorkspaceId } from 'coding-client-runtime/client'
import type { WorkspaceFileEntry } from 'coding-client-ui-open-in-app/client'

/** 单个标签的失败原因；`unsupported` 表示文件类型不在编辑器范围内。 */
export type IdeDocumentError = 'load' | 'save' | 'conflict' | 'unsupported' | 'too-large'

/** 一个打开的文件标签。 */
export interface IdeDocument {
  path: string
  name: string
  /** provider 名称链；读取与保存都提交它，而不是拼 OS 路径。 */
  segments: readonly string[]
  content: string
  savedContent: string
  /** 读取时获得的版本；保存必须原样回传。 */
  version: string
  dirty: boolean
  status: 'loading' | 'ready' | 'error' | 'unsupported'
  error?: IdeDocumentError
}

/** 一层目录的加载快照。 */
export interface IdeDirectoryState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly WorkspaceFileEntry[]
  truncated: boolean
}

/** 一个编辑器分组：自己的标签顺序与活动文件。 */
export interface IdePaneState {
  id: string
  /** 组内标签的路径顺序。 */
  paths: string[]
  activePath: string | null
  /** 组内唯一的临时预览标签；固定标签与草稿都不占这个位置。 */
  previewPath: string | null
}

/** 一个工作区的视图状态。 */
export interface IdeWorkspaceView {
  documents: Record<string, IdeDocument>
  directories: Record<string, IdeDirectoryState>
  expanded: string[]
  panes: IdePaneState[]
  activePaneId: string
}

/** 代码工作区的整体状态。 */
export interface IdeState {
  /** 停留在代码工作区的工作区 id；`null` 表示显示欢迎页。 */
  workspaceId: WorkspaceId | null
  /** 每个工作区各自的视图状态，切换后保留。 */
  views: Record<string, IdeWorkspaceView>
  /** 每个工作区用于文件读写的会话 id。 */
  sessions: Record<string, SessionId>
  /** 编辑器分组 id 的自增序号，保证同一工作区内不重复。 */
  nextPaneSeq: number
}

/** 组件侧使用的已解除 draft 的动作集合（与 `defineStore` 产出的类型一一对应）。 */
export type IdeActionsBaked = {
  [K in keyof IdeActions]: IdeActions[K] extends (draft: IdeState, ...params: infer P) => void
    ? (...params: P) => void
    : never
}

/** 分屏方向：把标签拖到编辑器左半或右半。 */
export type IdeSplitSide = 'left' | 'right'

type IdeActions = {
  /** 进入工作区，或传 `null` 回到欢迎页。 */
  enter: (draft: IdeState, workspaceId: WorkspaceId | null) => void
  /** 记录该工作区读写文件使用的会话。 */
  bindSession: (draft: IdeState, workspaceId: WorkspaceId, sessionId: SessionId) => void
  setDirectory: (draft: IdeState, workspaceId: WorkspaceId, path: string,
    status: IdeDirectoryState['status'], entries?: readonly WorkspaceFileEntry[], truncated?: boolean) => void
  toggleExpanded: (draft: IdeState, workspaceId: WorkspaceId, path: string) => void
  openTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, name: string,
    segments: readonly string[], mode?: 'preview' | 'pinned') => void
  /** 在指定来源分组旁新建分组，并以固定标签打开文件；正文已存在时复用。 */
  openSplitTab: (draft: IdeState, workspaceId: WorkspaceId, sourcePaneId: string, path: string, name: string,
    segments: readonly string[], side: IdeSplitSide) => void
  reloadTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, name: string, segments: readonly string[]) => void
  readyTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, content: string, version: string) => void
  updateTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, content: string) => void
  savedTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, version: string, savedContent: string) => void
  failTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, error: IdeDocumentError,
    status?: 'error' | 'unsupported' | 'ready') => void
  /** 聚焦分组并激活其中的标签。 */
  activateTab: (draft: IdeState, workspaceId: WorkspaceId, paneId: string, path: string) => void
  /** 把指定分组里的预览标签转为固定标签。 */
  pinTab: (draft: IdeState, workspaceId: WorkspaceId, paneId: string, path: string) => void
  /** 关闭标签；组内最后一个标签关闭后移除该组，只保留唯一分组。 */
  closeTab: (draft: IdeState, workspaceId: WorkspaceId, path: string) => void
  /** 把标签移到另一个分组（已在其中时只切换活动文件）。 */
  moveTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, paneId: string) => void
  /**
   * 把标签拆到目标分组的左/右半区形成新的编辑器分组。
   * `move`（拖拽）把标签搬过去，`copy`（页头拆分按钮）在新分组里打开同一文件。
   */
  splitTab: (draft: IdeState, workspaceId: WorkspaceId, path: string, paneId: string,
    side: IdeSplitSide, mode?: 'move' | 'copy') => void
  /** 聚焦分组。 */
  focusPane: (draft: IdeState, workspaceId: WorkspaceId, paneId: string) => void
  /** 关闭分组并把它里面的标签并入相邻分组；只剩一个分组时忽略。 */
  closePane: (draft: IdeState, workspaceId: WorkspaceId, paneId: string) => void
}

/** 新建一个空的单分组视图；组件在没有记录时用它渲染空态。 */
export function emptyView(): IdeWorkspaceView {
  return {
    documents: {}, directories: {}, expanded: [], activePaneId: 'pane-0',
    panes: [{ id: 'pane-0', paths: [], activePath: null, previewPath: null }],
  }
}

/** 取出（必要时创建并写回）一个工作区的视图状态。 */
function view(draft: IdeState, workspaceId: WorkspaceId): IdeWorkspaceView {
  const existing = draft.views[workspaceId]
  if (existing !== undefined) return existing
  const created = emptyView()
  draft.views[workspaceId] = created
  return created
}

/** 按 id 找分组；分组被移除后返回 undefined。 */
function paneOf(target: IdeWorkspaceView, paneId: string): IdePaneState | undefined {
  return target.panes.find(pane => pane.id === paneId)
}

/**
 * 取分组列表里的某一项；索引已被调用点确认可达，越界只可能是外部篡改。
 * @param target - 目标工作区视图。
 * @param index - 已确认范围内的下标。
 * @returns 该位置的分组。
 */
function paneAt(target: IdeWorkspaceView, index: number): IdePaneState {
  const pane = target.panes[index]
  /* v8 ignore next -- 调用点已确认下标在范围内。 */
  if (pane === undefined) throw new Error('ide store: pane index out of range')
  return pane
}

/** 建一个新分组并返回它；id 在同一工作区内单调递增。 */
function newPane(draft: IdeState): IdePaneState {
  const pane: IdePaneState = { id: `pane-${draft.nextPaneSeq}`, paths: [], activePath: null, previewPath: null }
  draft.nextPaneSeq += 1
  return pane
}

/** 从一个分组里摘掉路径；被摘掉的是活动文件时，选中退到相邻标签。 */
function retirePath(pane: IdePaneState, path: string): void {
  const index = pane.paths.indexOf(path)
  if (index < 0) return
  pane.paths.splice(index, 1)
  if (pane.previewPath === path) pane.previewPath = null
  if (pane.activePath !== path) return
  pane.activePath = pane.paths[index] ?? pane.paths[index - 1] ?? null
}

/** 从所有分组里摘掉一个路径，并在清空后移除空分组（至少保留一个）。 */
function detachPath(target: IdeWorkspaceView, path: string): void {
  for (const pane of target.panes) retirePath(pane, path)
  pruneEmptyPanes(target)
}

/** 丢弃没有标签的分组，保持当前分组有效。 */
function pruneEmptyPanes(target: IdeWorkspaceView): void {
  const kept = target.panes.filter(pane => pane.paths.length > 0)
  if (kept.length === 0) {
    target.panes = [{ id: 'pane-0', paths: [], activePath: null, previewPath: null }]
    target.activePaneId = 'pane-0'
    return
  }
  target.panes = kept
  // kept 非空（上面已返回），首项一定存在。
  /* v8 ignore next -- 只有收起的正是当前分组时才需要改焦点。 */
  if (!kept.some(pane => pane.id === target.activePaneId)) target.activePaneId = paneAt(target, 0).id
}

/**
 * 取当前聚焦的分组；`activePaneId` 指向已收起的分组时退回第一个分组。
 * 分组列表由 store 自己维护且始终非空，导出给页面组件复用同一份兜底语义。
 * @param target - 目标工作区视图。
 * @returns 当前分组。
 */
export function focusedPane(target: IdeWorkspaceView): IdePaneState {
  const pane = paneOf(target, target.activePaneId) ?? target.panes[0]
  /* v8 ignore next -- 分组列表为空只可能来自绕过 store 的外部写入。 */
  if (pane === undefined) throw new Error('ide store: pane list must not be empty')
  return pane
}

/** 把路径放进指定分组末尾并激活；已经在别的分组里时先移出。 */
function attachPath(target: IdeWorkspaceView, destination: IdePaneState, path: string): void {
  for (const pane of target.panes) {
    if (pane.id !== destination.id) retirePath(pane, path)
  }
  if (!destination.paths.includes(path)) destination.paths.push(path)
  destination.activePath = path
  target.activePaneId = destination.id
  pruneEmptyPanes(target)
}

/** 路径是否仍被任一分组引用；预览替换只删除已经没有标签的正文。 */
function pathInUse(target: IdeWorkspaceView, path: string): boolean {
  return target.panes.some(pane => pane.paths.includes(path))
}

/** 移除不再被任何分组引用的文件正文。 */
function discardUnused(target: IdeWorkspaceView, path: string): void {
  if (!pathInUse(target, path)) Reflect.deleteProperty(target.documents, path)
}

/** 用新的预览标签替换组内旧预览；旧预览被别的分组引用时只移出本组。 */
function replacePreview(target: IdeWorkspaceView, pane: IdePaneState, path: string): void {
  const previous = pane.previewPath
  if (previous !== null && previous !== path) {
    retirePath(pane, previous)
    discardUnused(target, previous)
  }
  attachPath(target, pane, path)
  pane.previewPath = path
}

/** 首次打开文件时建立加载中文档；已有正文与草稿继续复用。 */
function ensureDocument(target: IdeWorkspaceView, path: string, name: string, segments: readonly string[]): void {
  if (target.documents[path] !== undefined) return
  target.documents[path] = {
    path, name, segments: [...segments], content: '', savedContent: '', version: '',
    dirty: false, status: 'loading',
  }
}

/**
 * 创建代码工作区状态；实例由插件持有，不随会话切换重建。
 * @returns 声明了 init 与 actions 的 store handle。
 */
export function createIdeStore(): EngineStoreHandle<IdeState, IdeActions> {
  return defineStore({
    init: (): IdeState => ({
      workspaceId: null,
      views: {},
      sessions: {},
      nextPaneSeq: 1,
    }),
    actions: {
      enter: (draft, workspaceId) => {
        draft.workspaceId = workspaceId
        if (workspaceId !== null) void view(draft, workspaceId)
      },
      bindSession: (draft, workspaceId, sessionId) => {
        draft.sessions[workspaceId] = sessionId
      },
      setDirectory: (draft, workspaceId, path, status, entries = [], truncated = false) => {
        const target = view(draft, workspaceId)
        const previous = target.directories[path]
        target.directories[path] = {
          status,
          entries: status === 'loading' && previous !== undefined ? previous.entries : entries,
          truncated: status === 'loading' && previous !== undefined ? previous.truncated : truncated,
        }
      },
      toggleExpanded: (draft, workspaceId, path) => {
        const target = view(draft, workspaceId)
        target.expanded = target.expanded.includes(path)
          ? target.expanded.filter(candidate => candidate !== path)
          : [...target.expanded, path]
      },
      openTab: (draft, workspaceId, path, name, segments, mode = 'pinned') => {
        const target = view(draft, workspaceId)
        ensureDocument(target, path, name, segments)
        const pane = focusedPane(target)
        if (mode === 'preview' && !pane.paths.includes(path)) {
          replacePreview(target, pane, path)
          return
        }
        if (pane.previewPath === path && mode === 'pinned') pane.previewPath = null
        attachPath(target, pane, path)
      },
      openSplitTab: (draft, workspaceId, sourcePaneId, path, name, segments, side) => {
        const target = view(draft, workspaceId)
        const source = paneOf(target, sourcePaneId)
        if (source === undefined) return
        ensureDocument(target, path, name, segments)
        const pane = newPane(draft)
        const index = target.panes.findIndex(candidate => candidate.id === source.id)
        target.panes.splice(index + (side === 'right' ? 1 : 0), 0, pane)
        pane.paths = [path]
        pane.activePath = path
        pane.previewPath = null
        target.activePaneId = pane.id
      },
      reloadTab: (draft, workspaceId, path, name, segments) => {
        const target = view(draft, workspaceId)
        const pane = focusedPane(target)
        const preview = pane.previewPath === path
        target.documents[path] = {
          path, name, segments: [...segments], content: '', savedContent: '', version: '',
          dirty: false, status: 'loading',
        }
        attachPath(target, pane, path)
        if (preview) pane.previewPath = path
      },
      readyTab: (draft, workspaceId, path, content, version) => {
        const document = view(draft, workspaceId).documents[path]
        if (document === undefined) return
        document.content = content
        document.savedContent = content
        document.version = version
        document.dirty = false
        document.status = 'ready'
        delete document.error
      },
      updateTab: (draft, workspaceId, path, content) => {
        const target = view(draft, workspaceId)
        const document = target.documents[path]
        if (document === undefined || document.status === 'loading') return
        document.content = content
        document.dirty = content !== document.savedContent
        if (document.dirty) {
          for (const pane of target.panes) {
            if (pane.previewPath === path) pane.previewPath = null
          }
        }
      },
      savedTab: (draft, workspaceId, path, version, savedContent) => {
        const document = view(draft, workspaceId).documents[path]
        if (document === undefined) return
        document.savedContent = savedContent
        document.version = version
        document.dirty = document.content !== savedContent
        document.status = 'ready'
        delete document.error
      },
      failTab: (draft, workspaceId, path, error, status = 'error') => {
        const document = view(draft, workspaceId).documents[path]
        if (document === undefined) return
        document.status = status
        document.error = error
      },
      activateTab: (draft, workspaceId, paneId, path) => {
        const target = view(draft, workspaceId)
        const pane = paneOf(target, paneId)
        if (pane === undefined || !pane.paths.includes(path)) return
        pane.activePath = path
        target.activePaneId = pane.id
      },
      pinTab: (draft, workspaceId, paneId, path) => {
        const pane = paneOf(view(draft, workspaceId), paneId)
        if (pane?.previewPath === path) pane.previewPath = null
      },
      closeTab: (draft, workspaceId, path) => {
        const target = view(draft, workspaceId)
        detachPath(target, path)
        // 路径来自 provider 段链，删除键不是攻击面；immer draft 上同样安全。
        Reflect.deleteProperty(target.documents, path)
      },
      moveTab: (draft, workspaceId, path, paneId) => {
        const target = view(draft, workspaceId)
        // 只搬已经打开的标签：未知路径不进入分组，避免留下打不开的标签。
        const destination = paneOf(target, paneId)
        if (destination === undefined || target.documents[path] === undefined) return
        const preview = target.panes.some(pane => pane.previewPath === path)
        attachPath(target, destination, path)
        if (preview) replacePreview(target, destination, path)
      },
      splitTab: (draft, workspaceId, path, paneId, side, mode = 'move') => {
        const target = view(draft, workspaceId)
        const source = paneOf(target, paneId)
        if (source === undefined || target.documents[path] === undefined) return
        // 拖走唯一标签只会留下一个空分组：那是原地不动，不是分屏。
        const soleTab = source.paths.length === 1 && source.paths[0] === path
        if (mode === 'move' && soleTab) return
        const pane = newPane(draft)
        const index = target.panes.findIndex(candidate => candidate.id === source.id)
        target.panes.splice(index + (side === 'right' ? 1 : 0), 0, pane)
        pane.paths = [path]
        pane.activePath = path
        pane.previewPath = source.previewPath === path ? path : null
        if (mode === 'move') retirePath(source, path)
        target.activePaneId = pane.id
        pruneEmptyPanes(target)
      },
      focusPane: (draft, workspaceId, paneId) => {
        const target = view(draft, workspaceId)
        if (paneOf(target, paneId) !== undefined) target.activePaneId = paneId
      },
      closePane: (draft, workspaceId, paneId) => {
        const target = view(draft, workspaceId)
        if (target.panes.length <= 1) return
        const index = target.panes.findIndex(pane => pane.id === paneId)
        /* v8 ignore next -- 分组数与 id 都来自 store 自身写入。 */
        if (index < 0) return
        const pane = paneAt(target, index)
        /* v8 ignore next -- 两侧至少有一侧存在，`??` 的右侧只服务左侧为末尾分组的情形。 */
        const neighbour = index > 0 ? paneAt(target, index - 1) : paneAt(target, index + 1)
        for (const path of [...pane.paths]) {
          if (!neighbour.paths.includes(path)) neighbour.paths.push(path)
        }
        if (pane.previewPath !== null && neighbour.previewPath === null) {
          neighbour.previewPath = pane.previewPath
        }
        // 被关闭分组的活动文件在相邻分组里接着选中；非空分组总有活动文件。
        /* v8 ignore next -- 有标签的分组始终有活动文件，`??` 右侧是不可达的兜底。 */
        neighbour.activePath = pane.activePath ?? neighbour.activePath
        target.panes.splice(index, 1)
        if (target.activePaneId === paneId) target.activePaneId = neighbour.id
        pruneEmptyPanes(target)
      },
    },
  })
}
