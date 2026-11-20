/**
 * 笔记页上一次的浏览位置：切到其他页面再回来、或刷新窗口后仍打开同一篇笔记。
 * 只记活动路径、打开的标签与展开目录，正文一律从文件库重新读取。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'

interface NotesUiState {
  /** 当前 Markdown 草稿的相对路径；切到 PPTX 时仍保留以供恢复。 */
  path: string | null
  /** 所有打开的文件路径，PPTX 与 Markdown 共用同一顺序。 */
  tabs?: string[]
  /** 当前选中路径；只有打开的标签才会成为活动文档。 */
  activePath?: string | null
  /** 目录树中展开的目录路径。 */
  expanded: string[]
}

type NotesUiActions = {
  /** 最近一次 Markdown 草稿的路径；切换到 PPTX 不影响它。 */
  rememberNote: (draft: NotesUiState, path: string | null) => void
  /** 用户明确打开 Markdown 标签后才选中它。 */
  openNote: (draft: NotesUiState, path: string) => void
  openPpt: (draft: NotesUiState, path: string) => void
  activateTab: (draft: NotesUiState, path: string) => void
  closeTab: (draft: NotesUiState, path: string) => void
  moveTabs: (draft: NotesUiState, from: string, to: string) => void
  removeTabs: (draft: NotesUiState, path: string) => void
  restoreTabs: (draft: NotesUiState, paths: readonly string[]) => void
  rememberExpanded: (draft: NotesUiState, paths: readonly string[]) => void
}

/**
 * 创建笔记页的浏览位置 store。实例按会话隔离，因此笔记专用模式的会话
 * 重新打开时恢复上次那篇笔记；换到另一个笔记会话则从欢迎页开始。
 * @returns 含标签、活动路径与展开目录动作的 store handle。
 */
export function createNotesUiStore(): EngineStoreHandle<NotesUiState, NotesUiActions> {
  return defineStore({
    init: (): NotesUiState => ({ path: null, tabs: [], expanded: [] }),
    persist: 'dsh.notes.view',
    actions: {
      rememberNote: (draft, path) => {
        draft.path = path
        if (path !== null) {
          draft.tabs ??= []
          if (!draft.tabs.includes(path)) draft.tabs.push(path)
        }
      },
      openNote: (draft, path) => {
        draft.path = path
        draft.tabs ??= []
        if (!draft.tabs.includes(path)) draft.tabs.push(path)
        draft.activePath = path
      },
      openPpt: (draft, path) => {
        if (!/\.pptx$/iu.test(path)) return
        draft.tabs ??= []
        if (!draft.tabs.includes(path)) draft.tabs.push(path)
        draft.activePath = path
      },
      activateTab: (draft, path) => {
        if ((draft.tabs ?? []).includes(path)) draft.activePath = path
      },
      closeTab: (draft, path) => {
        const tabs = draft.tabs ?? (draft.path === null ? [] : [draft.path])
        const index = tabs.indexOf(path)
        draft.tabs = tabs.filter(tab => tab !== path)
        if (draft.activePath === path) draft.activePath = draft.tabs[index] ?? draft.tabs[index - 1] ?? null
        if (draft.path === path) draft.path = null
      },
      moveTabs: (draft, from, to) => {
        const remap = (path: string) => path === from ? to
          : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
        draft.tabs = [...new Set((draft.tabs ?? (draft.path === null ? [] : [draft.path])).map(remap))]
        if (draft.path !== null) draft.path = remap(draft.path)
        if (draft.activePath !== null && draft.activePath !== undefined) draft.activePath = remap(draft.activePath)
      },
      removeTabs: (draft, path) => {
        const removed = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`)
        draft.tabs = (draft.tabs ?? (draft.path === null ? [] : [draft.path])).filter(tab => !removed(tab))
        if (draft.path !== null && removed(draft.path)) draft.path = null
        if (draft.activePath !== null && draft.activePath !== undefined && removed(draft.activePath)) {
          draft.activePath = draft.tabs[0] ?? null
        }
      },
      restoreTabs: (draft, paths) => {
        const valid = new Set(paths)
        draft.tabs = (draft.tabs ?? (draft.path === null ? [] : [draft.path])).filter(path => valid.has(path))
        if (draft.path !== null && !valid.has(draft.path)) draft.path = null
        if (draft.activePath !== null && draft.activePath !== undefined && !valid.has(draft.activePath)) {
          draft.activePath = draft.tabs[0] ?? null
        }
      },
      rememberExpanded: (draft, paths) => { draft.expanded = [...paths] },
    },
  })
}
