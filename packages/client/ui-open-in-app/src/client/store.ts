/** 文件、终端与浏览器共用的工作台标签状态；根 store 按 Session 保留各自内容。 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFilesPayload } from './wire.ts'

/** 已打开文件；segments 原样来自 Host provider。 */
export interface WorkbenchFileTab {
  type: 'file'
  id: string
  name: string
  segments: string[]
}

/** 会话级文件管理器标签，文件树筛选与展开状态仍由工作台保存。 */
export interface WorkbenchFileManagerTab {
  type: 'file-manager'
  id: 'file-manager'
}

/** 独占一个 PTY 的终端标签；编号在所属 Session 内递增。 */
export interface WorkbenchTerminalTab {
  type: 'terminal'
  id: string
  name?: string
  number: number
}

/** Host 浏览器标签在工作台中的投影。 */
export interface WorkbenchBrowserTab {
  type: 'browser'
  id: string
  name: string
  browserTabId: string
}

/** 标签类型决定工作台内容和关闭行为。 */
export type WorkbenchTab = WorkbenchFileTab | WorkbenchFileManagerTab | WorkbenchTerminalTab | WorkbenchBrowserTab

/** 一层目录的读取状态。 */
export interface WorkbenchFileLevel {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly segments: readonly string[]
  readonly listing: WorkspaceFilesPayload | undefined
}

/** 单个 Session 的标签、当前视图与文件树状态。 */
export type WorkbenchState = {
  view: 'menu' | 'files' | 'browser' | 'terminal'
  tabs: WorkbenchTab[]
  activeId: string | null
  nextTerminalNumber: number
  activeBrowserTabId: string | null
  filesQuery: string
  filesExpanded: readonly string[]
  filesLevels: Readonly<Record<string, WorkbenchFileLevel | undefined>>
}

interface OpenFileInput {
  readonly name: string
  readonly segments: readonly string[]
}

interface BrowserTabInput {
  readonly id: string
  readonly name: string
}

type WorkbenchActions = {
  setView: (draft: WorkbenchState, view: WorkbenchState['view']) => void
  openFile: (draft: WorkbenchState, file: OpenFileInput) => void
  openFileManager: (draft: WorkbenchState) => void
  openTerminal: (draft: WorkbenchState) => void
  activateTab: (draft: WorkbenchState, id: string) => void
  closeTab: (draft: WorkbenchState, id: string) => void
  activateFile: (draft: WorkbenchState, id: string) => void
  closeFile: (draft: WorkbenchState, id: string) => void
  syncBrowserTabs: (draft: WorkbenchState, tabs: readonly BrowserTabInput[], activeBrowserTabId?: string | null) => void
  setFilesQuery: (draft: WorkbenchState, query: string) => void
  toggleFilesExpanded: (draft: WorkbenchState, key: string) => void
  setFilesLevel: (draft: WorkbenchState, segments: readonly string[], phase: 'loading' | 'error') => void
  setFilesListing: (draft: WorkbenchState, segments: readonly string[], listing: WorkspaceFilesPayload) => void
}

/** 根级工作台保存的各 Session 状态。 */
export type RetainedWorkbenchState = {
  sessions: Record<string, WorkbenchState>
}

type RetainedWorkbenchActions = {
  initSession: (draft: RetainedWorkbenchState, sessionId: SessionId) => void
  retainSessions: (draft: RetainedWorkbenchState, sessionIds: readonly SessionId[]) => void
} & {
  [Action in keyof WorkbenchActions]: WorkbenchActions[Action] extends
  (draft: WorkbenchState, ...args: infer Args) => void
    ? (draft: RetainedWorkbenchState, sessionId: SessionId, ...args: Args) => void : never
}

/**
 * 为 provider segment 链生成不解释分隔符的标签 identity。
 * @param segments - Host 返回的 segment 链。
 * @returns 可逆且不会混淆 Windows／POSIX 分隔符的 JSON identity。
 */
export function tabIdForSegments(segments: readonly string[]): string {
  return JSON.stringify(segments)
}

function initialWorkbenchState(): WorkbenchState {
  return {
    view: 'menu',
    tabs: [],
    activeId: null,
    nextTerminalNumber: 1,
    activeBrowserTabId: null,
    filesQuery: '',
    filesExpanded: [],
    filesLevels: {},
  }
}

function viewForTab(tab: WorkbenchTab): Exclude<WorkbenchState['view'], 'menu'> {
  return tab.type === 'file' || tab.type === 'file-manager' ? 'files' : tab.type
}

function selectTab(draft: WorkbenchState, tab: WorkbenchTab): void {
  draft.activeId = tab.id
  draft.view = viewForTab(tab)
  if (tab.type === 'browser') draft.activeBrowserTabId = tab.browserTabId
}

function retainLevel(
  level: WorkbenchFileLevel | undefined,
  segments: readonly string[],
  phase: 'loading' | 'error',
): WorkbenchFileLevel {
  return { phase, segments: [...segments], listing: level?.listing }
}

const workbenchActions: WorkbenchActions = {
  setView: (draft, view) => {
    draft.view = view
    if (view === 'menu') return
    const active = draft.tabs.find(tab => tab.id === draft.activeId && viewForTab(tab) === view)
    const rememberedBrowser = view === 'browser'
      ? draft.tabs.find(tab => tab.type === 'browser' && tab.browserTabId === draft.activeBrowserTabId)
      : undefined
    const next = rememberedBrowser ?? active ?? draft.tabs.find(tab => viewForTab(tab) === view)
    draft.activeId = next?.id ?? null
  },
  openFile: (draft, file) => {
    const id = tabIdForSegments(file.segments)
    if (!draft.tabs.some(tab => tab.id === id)) {
      draft.tabs.push({ type: 'file', id, name: file.name, segments: [...file.segments] })
    }
    draft.activeId = id
    draft.view = 'files'
  },
  openFileManager: (draft) => {
    let tab = draft.tabs.find((candidate): candidate is WorkbenchFileManagerTab => candidate.type === 'file-manager')
    if (tab === undefined) {
      tab = { type: 'file-manager', id: 'file-manager' }
      draft.tabs.push(tab)
    }
    selectTab(draft, tab)
  },
  openTerminal: (draft) => {
    const number = draft.nextTerminalNumber++
    const tab: WorkbenchTerminalTab = { type: 'terminal', id: `terminal:${String(number)}`, number }
    draft.tabs.push(tab)
    selectTab(draft, tab)
  },
  activateTab: (draft, id) => {
    const tab = draft.tabs.find(tab => tab.id === id)
    if (tab !== undefined) selectTab(draft, tab)
  },
  closeTab: (draft, id) => {
    const index = draft.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return
    draft.tabs.splice(index, 1)
    if (draft.tabs.length === 0) {
      draft.activeId = null
      draft.view = 'menu'
      return
    }
    if (draft.activeId !== id) return
    const next = draft.tabs[index] ?? draft.tabs[index - 1]
    if (next !== undefined) selectTab(draft, next)
  },
  activateFile: (draft, id) => {
    if (draft.tabs.some(tab => tab.id === id && tab.type === 'file')) workbenchActions.activateTab(draft, id)
  },
  closeFile: (draft, id) => {
    if (draft.tabs.some(tab => tab.id === id && tab.type === 'file')) workbenchActions.closeTab(draft, id)
  },
  syncBrowserTabs: (draft, tabs, activeBrowserTabId) => {
    const byId = new Map(tabs.map(tab => [`browser:${tab.id}`, tab]))
    const previousBrowserCount = draft.tabs.filter(tab => tab.type === 'browser').length
    const activeIndex = draft.tabs.findIndex(tab => tab.id === draft.activeId)
    const nextTabs = draft.tabs.flatMap((tab): WorkbenchTab[] => {
      if (tab.type !== 'browser') return [tab]
      const incoming = byId.get(tab.id)
      if (incoming === undefined) return []
      byId.delete(tab.id)
      return [tab.name === incoming.name ? tab : { ...tab, name: incoming.name }]
    })
    for (const [id, tab] of byId) {
      nextTabs.push({ type: 'browser', id, name: tab.name, browserTabId: tab.id })
    }
    if (nextTabs.length !== draft.tabs.length || nextTabs.some((tab, index) => tab !== draft.tabs[index])) {
      draft.tabs = nextTabs
    }
    const browsers = nextTabs.filter(tab => tab.type === 'browser')
    const requestedId = activeBrowserTabId === undefined ? draft.activeBrowserTabId : activeBrowserTabId
    const selected = browsers.find(tab => tab.browserTabId === requestedId) ?? browsers[0]
    draft.activeBrowserTabId = selected?.browserTabId ?? null

    // Host 浏览器活动页更新不会抢走文件或终端；首次空 browser 视图保留加载入口。
    if (draft.view === 'browser' && selected !== undefined) {
      draft.activeId = selected.id
    } else if ((draft.activeId !== null && !nextTabs.some(tab => tab.id === draft.activeId))
      || (draft.view === 'browser' && previousBrowserCount > 0 && browsers.length === 0)) {
      const next = nextTabs[activeIndex] ?? nextTabs[activeIndex - 1] ?? nextTabs[0]
      if (next === undefined) {
        draft.activeId = null
        if (draft.view !== 'menu') draft.view = 'menu'
      } else if (draft.view === 'menu') {
        draft.activeId = next.id
      } else {
        selectTab(draft, next)
      }
    }
  },
  setFilesQuery: (draft, query) => { draft.filesQuery = query },
  toggleFilesExpanded: (draft, key) => {
    const next = new Set(draft.filesExpanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    draft.filesExpanded = [...next]
  },
  setFilesLevel: (draft, segments, phase) => {
    const key = tabIdForSegments(segments)
    draft.filesLevels = {
      ...draft.filesLevels,
      [key]: retainLevel(draft.filesLevels[key], segments, phase),
    }
  },
  setFilesListing: (draft, segments, listing) => {
    const key = tabIdForSegments(segments)
    draft.filesLevels = {
      ...draft.filesLevels,
      [key]: { phase: 'ready', segments: [...segments], listing },
    }
  },
}

function sessionState(draft: RetainedWorkbenchState, sessionId: SessionId): WorkbenchState {
  return draft.sessions[sessionId] ??= initialWorkbenchState()
}

/**
 * 创建单个 Session 的工作台 store，供独立组件与状态测试使用。
 * @returns 包含统一标签动作的 store handle。
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({ init: initialWorkbenchState, actions: workbenchActions })
}

/**
 * 创建按 Session 保留内容的根级工作台 store；移除会话时删除其全部状态。
 * @returns 由根 slot 实例化、动作以 Session id 为首参的 store handle。
 */
export function createRetainedWorkbenchStore(): EngineStoreHandle<RetainedWorkbenchState, RetainedWorkbenchActions> {
  return defineStore({
    init: (): RetainedWorkbenchState => ({ sessions: {} }),
    actions: {
      initSession: (draft, id: SessionId) => { sessionState(draft, id) },
      retainSessions: (draft, ids: readonly SessionId[]) => {
        const retained = new Set<string>(ids)
        if (Object.keys(draft.sessions).every(id => retained.has(id))) return
        draft.sessions = Object.fromEntries(Object.entries(draft.sessions).filter(([id]) => retained.has(id)))
      },
      setView: (draft, id: SessionId, view: WorkbenchState['view']) => {
        workbenchActions.setView(sessionState(draft, id), view)
      },
      openFile: (draft, id: SessionId, file: OpenFileInput) => {
        workbenchActions.openFile(sessionState(draft, id), file)
      },
      openFileManager: (draft, id: SessionId) => { workbenchActions.openFileManager(sessionState(draft, id)) },
      openTerminal: (draft, id: SessionId) => { workbenchActions.openTerminal(sessionState(draft, id)) },
      activateTab: (draft, id: SessionId, tabId: string) => {
        workbenchActions.activateTab(sessionState(draft, id), tabId)
      },
      closeTab: (draft, id: SessionId, tabId: string) => { workbenchActions.closeTab(sessionState(draft, id), tabId) },
      activateFile: (draft, id: SessionId, tabId: string) => {
        workbenchActions.activateFile(sessionState(draft, id), tabId)
      },
      closeFile: (draft, id: SessionId, tabId: string) => { workbenchActions.closeFile(sessionState(draft, id), tabId) },
      syncBrowserTabs: (draft, id: SessionId, tabs: readonly BrowserTabInput[], activeBrowserTabId?: string | null) => {
        workbenchActions.syncBrowserTabs(sessionState(draft, id), tabs, activeBrowserTabId)
      },
      setFilesQuery: (draft, id: SessionId, query: string) => {
        workbenchActions.setFilesQuery(sessionState(draft, id), query)
      },
      toggleFilesExpanded: (draft, id: SessionId, key: string) => {
        workbenchActions.toggleFilesExpanded(sessionState(draft, id), key)
      },
      setFilesLevel: (draft, id: SessionId, segments: readonly string[], phase: 'loading' | 'error') => {
        workbenchActions.setFilesLevel(sessionState(draft, id), segments, phase)
      },
      setFilesListing: (draft, id: SessionId, segments: readonly string[], listing: WorkspaceFilesPayload) => {
        workbenchActions.setFilesListing(sessionState(draft, id), segments, listing)
      },
    },
  })
}
