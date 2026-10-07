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

/** 尚未取得 Host 页面 id 的会话链接；失败时保留目标供重试。 */
export interface WorkbenchPendingBrowserTab {
  type: 'browser-pending'
  id: string
  url: string
  error?: string
}

/** 第三方标签的导航参数只接受可序列化的 JSON 值。 */
export type WorkbenchExternalParams = string | number | boolean | null
  | readonly WorkbenchExternalParams[] | { readonly [key: string]: WorkbenchExternalParams }

/** 第三方定义在当前 Session 中打开的标签；kind 用于去重，definitionId 保留初次打开的归属。 */
export interface WorkbenchExternalTab {
  type: 'external'
  id: string
  definitionId: string
  kind: string
  name: string
  address: string
  params?: WorkbenchExternalParams
  revision: number
}

/** 标签类型决定工作台内容和关闭行为。 */
export type WorkbenchTab = WorkbenchFileTab | WorkbenchFileManagerTab | WorkbenchTerminalTab
  | WorkbenchBrowserTab | WorkbenchPendingBrowserTab | WorkbenchExternalTab

/** 一层目录的读取状态。 */
export interface WorkbenchFileLevel {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly segments: readonly string[]
  readonly listing: WorkspaceFilesPayload | undefined
}

/** 单个 Session 的标签、当前视图与文件树状态。 */
export type WorkbenchState = {
  view: 'menu' | 'files' | 'browser' | 'terminal' | 'external'
  tabs: WorkbenchTab[]
  activeId: string | null
  nextTerminalNumber: number
  nextExternalNumber: number
  activeBrowserTabId: string | null
  interactionEpoch: number
  browserAutoRevealed: boolean
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

interface OpenExternalTabInput {
  readonly definitionId: string
  readonly kind: string
  readonly name: string
  readonly address: string
  readonly params?: WorkbenchExternalParams
  readonly multiple?: boolean
}

interface UpdateExternalTabInput {
  readonly name?: string
  readonly address: string
  readonly params?: WorkbenchExternalParams
}

type WorkbenchActions = {
  setView: (draft: WorkbenchState, view: WorkbenchState['view']) => void
  openFile: (draft: WorkbenchState, file: OpenFileInput) => void
  openFileManager: (draft: WorkbenchState) => void
  openTerminal: (draft: WorkbenchState) => void
  openExternalTab: (draft: WorkbenchState, input: OpenExternalTabInput) => void
  updateExternalTab: (draft: WorkbenchState, tabId: string, update: UpdateExternalTabInput) => void
  closeExternalTab: (draft: WorkbenchState, tabId: string) => void
  activateTab: (draft: WorkbenchState, id: string) => void
  closeTab: (draft: WorkbenchState, id: string) => void
  activateFile: (draft: WorkbenchState, id: string) => void
  closeFile: (draft: WorkbenchState, id: string) => void
  syncBrowserTabs: (draft: WorkbenchState, tabs: readonly BrowserTabInput[], activeBrowserTabId?: string | null) => void
  beginBrowserLink: (draft: WorkbenchState, id: string, url: string) => void
  completeBrowserLink: (draft: WorkbenchState, id: string, tabId: string) => void
  failBrowserLink: (draft: WorkbenchState, id: string, message: string) => void
  clearBrowserLinks: (draft: WorkbenchState) => void
  recordInteraction: (draft: WorkbenchState) => void
  autoRevealBrowser: (draft: WorkbenchState, tabId: string, epoch: number) => void
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
  closeExternalByDefinition: (draft: RetainedWorkbenchState, definitionId: string) => void
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
    nextExternalNumber: 1,
    activeBrowserTabId: null,
    interactionEpoch: 0,
    browserAutoRevealed: false,
    filesQuery: '',
    filesExpanded: [],
    filesLevels: {},
  }
}

function viewForTab(tab: WorkbenchTab): Exclude<WorkbenchState['view'], 'menu'> {
  return tab.type === 'file' || tab.type === 'file-manager' ? 'files'
    : tab.type === 'browser-pending' ? 'browser' : tab.type
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

function externalTabId(kind: string, number?: number): string {
  return `external:${JSON.stringify(number === undefined ? [kind] : [kind, number])}`
}

const workbenchActions: WorkbenchActions = {
  setView: (draft, view) => {
    draft.interactionEpoch++
    draft.browserAutoRevealed = false
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
    draft.interactionEpoch++
    const id = tabIdForSegments(file.segments)
    if (!draft.tabs.some(tab => tab.id === id)) {
      draft.tabs.push({ type: 'file', id, name: file.name, segments: [...file.segments] })
    }
    draft.activeId = id
    draft.view = 'files'
  },
  openFileManager: (draft) => {
    draft.interactionEpoch++
    let tab = draft.tabs.find((candidate): candidate is WorkbenchFileManagerTab => candidate.type === 'file-manager')
    if (tab === undefined) {
      tab = { type: 'file-manager', id: 'file-manager' }
      draft.tabs.push(tab)
    }
    selectTab(draft, tab)
  },
  openTerminal: (draft) => {
    draft.interactionEpoch++
    const number = draft.nextTerminalNumber++
    const tab: WorkbenchTerminalTab = { type: 'terminal', id: `terminal:${String(number)}`, number }
    draft.tabs.push(tab)
    selectTab(draft, tab)
  },
  openExternalTab: (draft, input) => {
    draft.interactionEpoch++
    draft.browserAutoRevealed = false
    const existing = !input.multiple
      ? draft.tabs.find((tab): tab is WorkbenchExternalTab => tab.type === 'external' && tab.kind === input.kind)
      : undefined
    if (existing !== undefined) {
      existing.name = input.name
      existing.address = input.address
      if (input.params === undefined) delete existing.params
      else existing.params = input.params
      existing.revision++
      selectTab(draft, existing)
      return
    }
    const id = input.multiple
      ? externalTabId(input.kind, draft.nextExternalNumber++)
      : externalTabId(input.kind)
    const tab: WorkbenchExternalTab = {
      type: 'external', id, definitionId: input.definitionId, kind: input.kind,
      name: input.name, address: input.address, revision: 0,
      ...(input.params === undefined ? {} : { params: input.params }),
    }
    draft.tabs.push(tab)
    selectTab(draft, tab)
  },
  updateExternalTab: (draft, tabId, update) => {
    const tab = draft.tabs.find((candidate): candidate is WorkbenchExternalTab => candidate.type === 'external' && candidate.id === tabId)
    if (tab === undefined) return
    tab.address = update.address
    if (update.params === undefined) delete tab.params
    else tab.params = update.params
    if (update.name !== undefined) tab.name = update.name
    tab.revision++
  },
  closeExternalTab: (draft, tabId) => {
    if (draft.tabs.some(tab => tab.type === 'external' && tab.id === tabId)) workbenchActions.closeTab(draft, tabId)
  },
  activateTab: (draft, id) => {
    const tab = draft.tabs.find(tab => tab.id === id)
    if (tab !== undefined) {
      draft.interactionEpoch++
      draft.browserAutoRevealed = false
      selectTab(draft, tab)
    }
  },
  closeTab: (draft, id) => {
    const index = draft.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return
    draft.interactionEpoch++
    draft.browserAutoRevealed = false
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
    if (activeBrowserTabId !== undefined && activeBrowserTabId !== draft.activeBrowserTabId) {
      draft.browserAutoRevealed = false
    }
    const requestedId = activeBrowserTabId === undefined ? draft.activeBrowserTabId : activeBrowserTabId
    const selected = browsers.find(tab => tab.browserTabId === requestedId) ?? browsers[0]
    draft.activeBrowserTabId = selected?.browserTabId ?? null

    // Host 浏览器活动页更新不会抢走文件或终端；首次空 browser 视图保留加载入口。
    if (draft.view === 'browser' && selected !== undefined
      && draft.tabs.find(tab => tab.id === draft.activeId)?.type !== 'browser-pending') {
      draft.activeId = selected.id
    } else if ((draft.activeId !== null && !nextTabs.some(tab => tab.id === draft.activeId))
      || (draft.view === 'browser' && previousBrowserCount > 0 && browsers.length === 0
        && nextTabs.find(tab => tab.id === draft.activeId)?.type !== 'browser-pending')) {
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
  beginBrowserLink: (draft, id, url) => {
    const existing = draft.tabs.find(tab => tab.type === 'browser-pending' && tab.id === id)
    if (existing?.type === 'browser-pending') {
      delete existing.error
      selectTab(draft, existing)
      return
    }
    const tab: WorkbenchPendingBrowserTab = { type: 'browser-pending', id, url }
    draft.tabs.push(tab)
    selectTab(draft, tab)
  },
  completeBrowserLink: (draft, id, tabId) => {
    const index = draft.tabs.findIndex(tab => tab.type === 'browser-pending' && tab.id === id)
    if (index < 0) return
    const selected = draft.view === 'browser' && draft.activeId === id
    draft.tabs.splice(index, 1)
    const host = draft.tabs.find(tab => tab.type === 'browser' && tab.browserTabId === tabId)
    if (host !== undefined && selected) selectTab(draft, host)
    else if (selected) {
      const next = draft.tabs[index] ?? draft.tabs[index - 1]
      if (next !== undefined) selectTab(draft, next)
      else { draft.activeId = null; draft.view = 'menu' }
    } else if (draft.activeId === id) {
      draft.activeId = host?.id ?? draft.tabs[0]?.id ?? null
    }
  },
  failBrowserLink: (draft, id, message) => {
    const tab = draft.tabs.find(tab => tab.type === 'browser-pending' && tab.id === id)
    if (tab?.type === 'browser-pending') tab.error = message
  },
  clearBrowserLinks: (draft) => {
    if (!draft.tabs.some(tab => tab.type === 'browser-pending')) return
    const activePending = draft.view === 'browser'
      && draft.tabs.find(tab => tab.id === draft.activeId)?.type === 'browser-pending'
    draft.tabs = draft.tabs.filter(tab => tab.type !== 'browser-pending')
    if (!activePending) {
      if (draft.activeId !== null && !draft.tabs.some(tab => tab.id === draft.activeId)) {
        draft.activeId = draft.tabs[0]?.id ?? null
      }
      return
    }
    const next = draft.tabs.find(tab => tab.type === 'browser' && tab.browserTabId === draft.activeBrowserTabId)
      ?? draft.tabs[0]
    if (next !== undefined) selectTab(draft, next)
    else { draft.activeId = null; draft.view = 'menu' }
  },
  recordInteraction: (draft) => {
    draft.interactionEpoch++
    draft.browserAutoRevealed = false
  },
  autoRevealBrowser: (draft, tabId, epoch) => {
    if (draft.interactionEpoch !== epoch) return
    const tab = draft.tabs.find(tab => tab.type === 'browser' && tab.browserTabId === tabId)
    if (tab === undefined) return
    selectTab(draft, tab)
    draft.browserAutoRevealed = true
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
      closeExternalByDefinition: (draft, definitionId: string) => {
        for (const session of Object.values(draft.sessions)) {
          const ids = session.tabs.filter(tab => tab.type === 'external' && tab.definitionId === definitionId)
            .map(tab => tab.id)
          for (const id of ids) workbenchActions.closeTab(session, id)
        }
      },
      setView: (draft, id: SessionId, view: WorkbenchState['view']) => {
        workbenchActions.setView(sessionState(draft, id), view)
      },
      openFile: (draft, id: SessionId, file: OpenFileInput) => {
        workbenchActions.openFile(sessionState(draft, id), file)
      },
      openFileManager: (draft, id: SessionId) => { workbenchActions.openFileManager(sessionState(draft, id)) },
      openTerminal: (draft, id: SessionId) => { workbenchActions.openTerminal(sessionState(draft, id)) },
      openExternalTab: (draft, id: SessionId, input: OpenExternalTabInput) => {
        workbenchActions.openExternalTab(sessionState(draft, id), input)
      },
      updateExternalTab: (draft, id: SessionId, tabId: string, update: UpdateExternalTabInput) => {
        workbenchActions.updateExternalTab(sessionState(draft, id), tabId, update)
      },
      closeExternalTab: (draft, id: SessionId, tabId: string) => {
        workbenchActions.closeExternalTab(sessionState(draft, id), tabId)
      },
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
      beginBrowserLink: (draft, id: SessionId, tabId: string, url: string) => {
        workbenchActions.beginBrowserLink(sessionState(draft, id), tabId, url)
      },
      completeBrowserLink: (draft, id: SessionId, pendingId: string, tabId: string) => {
        workbenchActions.completeBrowserLink(sessionState(draft, id), pendingId, tabId)
      },
      failBrowserLink: (draft, id: SessionId, tabId: string, message: string) => {
        const state = draft.sessions[id]
        if (state !== undefined) workbenchActions.failBrowserLink(state, tabId, message)
      },
      clearBrowserLinks: (draft, id: SessionId) => {
        const state = draft.sessions[id]
        if (state !== undefined) workbenchActions.clearBrowserLinks(state)
      },
      recordInteraction: (draft, id: SessionId) => { workbenchActions.recordInteraction(sessionState(draft, id)) },
      autoRevealBrowser: (draft, id: SessionId, tabId: string, epoch: number) => {
        workbenchActions.autoRevealBrowser(sessionState(draft, id), tabId, epoch)
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
