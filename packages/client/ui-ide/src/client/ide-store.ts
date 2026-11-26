/** IDE 页内共享的文件树、标签与草稿；实例由 shell.page 按会话隔离。 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { WorkspaceFileEntry } from 'coding-client-ui-open-in-app/client'

export type IdeDocumentError = 'load' | 'save' | 'conflict' | 'unsupported' | 'too-large'

export interface IdeDocument {
  path: string
  name: string
  segments: readonly string[]
  content: string
  savedContent: string
  version: string
  dirty: boolean
  status: 'loading' | 'ready' | 'error' | 'unsupported'
  error?: IdeDocumentError
}

export interface IdeDirectoryState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly WorkspaceFileEntry[]
  truncated: boolean
}

interface IdeWorkspaceState {
  directories: Record<string, IdeDirectoryState>
  expanded: string[]
  tabs: IdeDocument[]
  activePath: string | null
}

type IdeWorkspaceActions = {
  setDirectory: (draft: IdeWorkspaceState, path: string, status: IdeDirectoryState['status'], entries?: readonly WorkspaceFileEntry[], truncated?: boolean) => void
  toggleExpanded: (draft: IdeWorkspaceState, path: string) => void
  openTab: (draft: IdeWorkspaceState, path: string, name: string, segments: readonly string[]) => void
  reloadTab: (draft: IdeWorkspaceState, path: string, name: string, segments: readonly string[]) => void
  activateTab: (draft: IdeWorkspaceState, path: string) => void
  readyTab: (draft: IdeWorkspaceState, path: string, content: string, version: string) => void
  updateTab: (draft: IdeWorkspaceState, path: string, content: string) => void
  savedTab: (draft: IdeWorkspaceState, path: string, version: string, savedContent: string) => void
  failTab: (draft: IdeWorkspaceState, path: string, error: IdeDocumentError, status?: 'error' | 'unsupported' | 'ready') => void
  closeTab: (draft: IdeWorkspaceState, path: string) => void
}

/** 创建会话内 IDE 视图状态；不持久化文件正文或版本。 */
export function createIdeWorkspaceStore(): EngineStoreHandle<IdeWorkspaceState, IdeWorkspaceActions> {
  return defineStore({
    init: (): IdeWorkspaceState => ({ directories: {}, expanded: [], tabs: [], activePath: null }),
    actions: {
      setDirectory: (draft, path, status, entries = [], truncated = false) => {
        const previous = draft.directories[path]
        draft.directories[path] = {
          status,
          entries: status === 'loading' && previous !== undefined ? previous.entries : entries,
          truncated: status === 'loading' && previous !== undefined ? previous.truncated : truncated,
        }
      },
      toggleExpanded: (draft, path) => {
        draft.expanded = draft.expanded.includes(path)
          ? draft.expanded.filter(candidate => candidate !== path)
          : [...draft.expanded, path]
      },
      openTab: (draft, path, name, segments) => {
        if (!draft.tabs.some(tab => tab.path === path)) {
          draft.tabs.push({
            path, name, segments: [...segments], content: '', savedContent: '', version: '',
            dirty: false, status: 'loading',
          })
        }
        draft.activePath = path
      },
      reloadTab: (draft, path, name, segments) => {
        const index = draft.tabs.findIndex(tab => tab.path === path)
        const tab: IdeDocument = {
          path, name, segments: [...segments], content: '', savedContent: '', version: '',
          dirty: false, status: 'loading',
        }
        if (index < 0) draft.tabs.push(tab)
        else draft.tabs[index] = tab
        draft.activePath = path
      },
      activateTab: (draft, path) => {
        if (draft.tabs.some(tab => tab.path === path)) draft.activePath = path
      },
      readyTab: (draft, path, content, version) => {
        const tab = draft.tabs.find(candidate => candidate.path === path)
        if (tab === undefined) return
        tab.content = content
        tab.savedContent = content
        tab.version = version
        tab.dirty = false
        tab.status = 'ready'
        delete tab.error
      },
      updateTab: (draft, path, content) => {
        const tab = draft.tabs.find(candidate => candidate.path === path)
        if (tab === undefined || tab.status === 'loading') return
        tab.content = content
        tab.dirty = content !== tab.savedContent
      },
      savedTab: (draft, path, version, savedContent) => {
        const tab = draft.tabs.find(candidate => candidate.path === path)
        if (tab === undefined) return
        tab.savedContent = savedContent
        tab.version = version
        tab.dirty = tab.content !== savedContent
        tab.status = 'ready'
        delete tab.error
      },
      failTab: (draft, path, error, status = 'error') => {
        const tab = draft.tabs.find(candidate => candidate.path === path)
        if (tab === undefined) return
        tab.status = status
        tab.error = error
      },
      closeTab: (draft, path) => {
        const index = draft.tabs.findIndex(tab => tab.path === path)
        if (index < 0) return
        draft.tabs.splice(index, 1)
        if (draft.activePath !== path) return
        draft.activePath = draft.tabs[index]?.path ?? draft.tabs[index - 1]?.path ?? null
      },
    },
  })
}
