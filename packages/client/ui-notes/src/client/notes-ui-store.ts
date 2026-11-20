/**
 * 笔记页上一次的浏览位置：切到其他页面再回来、或刷新窗口后仍打开同一篇笔记。
 * 只记活动路径、打开的标签与展开目录，正文一律从文件库重新读取。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'

interface NotesUiState {
  /** 上次打开的笔记路径，相对笔记根目录；null 表示停在欢迎页。 */
  path: string | null
  /** 已打开的笔记路径，按首次打开顺序排列；旧存档没有此字段。 */
  tabs?: string[]
  /** 目录树中展开的目录路径。 */
  expanded: string[]
}

type NotesUiActions = {
  rememberNote: (draft: NotesUiState, path: string | null) => void
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
      closeTab: (draft, path) => {
        draft.tabs = (draft.tabs ?? (draft.path === null ? [] : [draft.path])).filter(tab => tab !== path)
        if (draft.path === path) draft.path = null
      },
      moveTabs: (draft, from, to) => {
        const remap = (path: string) => path === from ? to
          : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
        draft.tabs = [...new Set((draft.tabs ?? (draft.path === null ? [] : [draft.path])).map(remap))]
        if (draft.path !== null) draft.path = remap(draft.path)
      },
      removeTabs: (draft, path) => {
        const removed = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`)
        draft.tabs = (draft.tabs ?? (draft.path === null ? [] : [draft.path])).filter(tab => !removed(tab))
        if (draft.path !== null && removed(draft.path)) draft.path = null
      },
      restoreTabs: (draft, paths) => {
        const valid = new Set(paths)
        draft.tabs = (draft.tabs ?? (draft.path === null ? [] : [draft.path])).filter(path => valid.has(path))
        if (draft.path !== null && !valid.has(draft.path)) draft.path = null
      },
      rememberExpanded: (draft, paths) => { draft.expanded = [...paths] },
    },
  })
}
