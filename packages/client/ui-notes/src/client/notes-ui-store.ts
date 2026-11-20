/**
 * 笔记页上一次的浏览位置：切到其他页面再回来、或刷新窗口后仍打开同一篇笔记。
 * 只记路径与展开的目录，正文一律从文件库重新读取，不缓存草稿内容。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'

interface NotesUiState {
  /** 上次打开的笔记路径，相对笔记根目录；null 表示停在欢迎页。 */
  path: string | null
  /** 目录树中展开的目录路径。 */
  expanded: string[]
}

type NotesUiActions = {
  rememberNote: (draft: NotesUiState, path: string | null) => void
  rememberExpanded: (draft: NotesUiState, paths: readonly string[]) => void
}

/**
 * 创建笔记页的浏览位置 store。实例按会话隔离，因此笔记专用模式的会话
 * 重新打开时恢复上次那篇笔记；换到另一个笔记会话则从欢迎页开始。
 * @returns 含路径与展开目录动作的 store handle。
 */
export function createNotesUiStore(): EngineStoreHandle<NotesUiState, NotesUiActions> {
  return defineStore({
    init: (): NotesUiState => ({ path: null, expanded: [] }),
    persist: 'dsh.notes.view',
    actions: {
      rememberNote: (draft, path) => { draft.path = path },
      rememberExpanded: (draft, paths) => { draft.expanded = [...paths] },
    },
  })
}
