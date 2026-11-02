/** 文件、Git、终端和外部插件共用的工作台标签状态；根 store 按 Session 保留各自内容。 */

import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
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

/** 当前 Session 的只读 Git 提交历史标签；重复打开只切回同一标签。 */
export interface WorkbenchHistoryTab {
  type: 'history'
  id: 'git-history'
}

/** 仅在 Client 中打开功能菜单；不占用其他功能的资源。 */
export interface WorkbenchLauncherTab {
  type: 'launcher'
  id: string
  number: number
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
export type WorkbenchTab = WorkbenchFileTab | WorkbenchFileManagerTab | WorkbenchHistoryTab | WorkbenchTerminalTab
  | WorkbenchExternalTab | WorkbenchLauncherTab

/** 一层目录的读取状态。 */
export interface WorkbenchFileLevel {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly segments: readonly string[]
  readonly listing: WorkspaceFilesPayload | undefined
}

/** 单个 Session 的标签、当前视图与文件树状态。 */
export type WorkbenchState = {
  view: 'menu' | 'files' | 'history' | 'terminal' | 'external'
  tabs: WorkbenchTab[]
  activeId: string | null
  nextTerminalNumber: number
  nextLauncherNumber: number
  nextExternalNumber: number
  filesQuery: string
  filesExpanded: readonly string[]
  filesLevels: Readonly<Record<string, WorkbenchFileLevel | undefined>>
  /** 最近一次目录中的目标地址；关闭视图后同一页面不会被轮询重新打开。 */
  knownExternalAddresses: Readonly<Record<string, readonly string[]>>
}

interface OpenFileInput {
  readonly name: string
  readonly segments: readonly string[]
}

interface OpenExternalTabInput {
  readonly definitionId: string
  readonly kind: string
  readonly name: string
  readonly address: string
  readonly params?: WorkbenchExternalParams
  readonly multiple?: boolean
  readonly reuseAddress?: boolean
}

interface UpdateExternalTabInput {
  readonly name?: string
  readonly address: string
  readonly params?: WorkbenchExternalParams
}

interface SyncExternalTabsInput {
  readonly kind: string
  readonly definitionId: string
  readonly fallback: { readonly address: string; readonly name: string }
  readonly pages: readonly { readonly address: string; readonly name: string; readonly params: WorkbenchExternalParams }[]
  readonly firstSeen?: string
}

type WorkbenchActions = {
  setView: (draft: WorkbenchState, view: WorkbenchState['view']) => void
  openFile: (draft: WorkbenchState, file: OpenFileInput) => void
  openFileManager: (draft: WorkbenchState) => void
  openHistory: (draft: WorkbenchState) => void
  openTerminal: (draft: WorkbenchState) => void
  openLauncher: (draft: WorkbenchState) => void
  openExternalTab: (draft: WorkbenchState, input: OpenExternalTabInput) => void
  syncExternalTabs: (draft: WorkbenchState, input: SyncExternalTabsInput) => void
  updateExternalTab: (draft: WorkbenchState, tabId: string, update: UpdateExternalTabInput) => void
  closeExternalTab: (draft: WorkbenchState, tabId: string) => void
  activateTab: (draft: WorkbenchState, id: string) => void
  closeTab: (draft: WorkbenchState, id: string) => void
  activateFile: (draft: WorkbenchState, id: string) => void
  closeFile: (draft: WorkbenchState, id: string) => void
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
    nextLauncherNumber: 1,
    nextExternalNumber: 1,
    filesQuery: '',
    filesExpanded: [],
    filesLevels: {},
    knownExternalAddresses: {},
  }
}

function viewForTab(tab: WorkbenchTab): WorkbenchState['view'] {
  return tab.type === 'file' || tab.type === 'file-manager' ? 'files'
    : tab.type === 'launcher' ? 'menu' : tab.type
}

function selectTab(draft: WorkbenchState, tab: WorkbenchTab): void {
  draft.activeId = tab.id
  draft.view = viewForTab(tab)
}

function consumeLauncher(draft: WorkbenchState): number | undefined {
  const index = draft.tabs.findIndex(tab => tab.id === draft.activeId && tab.type === 'launcher')
  if (index < 0) return undefined
  draft.tabs.splice(index, 1)
  draft.activeId = null
  return index
}

function addTab(draft: WorkbenchState, tab: WorkbenchTab, index: number | undefined): void {
  if (index === undefined) draft.tabs.push(tab)
  else draft.tabs.splice(index, 0, tab)
  selectTab(draft, tab)
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
    if (view !== 'menu') consumeLauncher(draft)
    draft.view = view
    if (view === 'menu') return
    const active = draft.tabs.find(tab => tab.id === draft.activeId && viewForTab(tab) === view)
    const next = active ?? draft.tabs.find(tab => viewForTab(tab) === view)
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
    const launcherIndex = consumeLauncher(draft)
    let tab = draft.tabs.find((candidate): candidate is WorkbenchFileManagerTab => candidate.type === 'file-manager')
    if (tab === undefined) {
      tab = { type: 'file-manager', id: 'file-manager' }
      addTab(draft, tab, launcherIndex)
      return
    }
    selectTab(draft, tab)
  },
  openHistory: (draft) => {
    const launcherIndex = consumeLauncher(draft)
    const existing = draft.tabs.find((tab): tab is WorkbenchHistoryTab => tab.type === 'history')
    if (existing !== undefined) { selectTab(draft, existing); return }
    addTab(draft, { type: 'history', id: 'git-history' }, launcherIndex)
  },
  openTerminal: (draft) => {
    const launcherIndex = consumeLauncher(draft)
    const number = draft.nextTerminalNumber++
    const tab: WorkbenchTerminalTab = { type: 'terminal', id: `terminal:${String(number)}`, number }
    addTab(draft, tab, launcherIndex)
  },
  openLauncher: (draft) => {
    const number = draft.nextLauncherNumber++
    const tab: WorkbenchLauncherTab = { type: 'launcher', id: `launcher:${String(number)}`, number }
    draft.tabs.push(tab)
    selectTab(draft, tab)
  },
  openExternalTab: (draft, input) => {
    const launcherIndex = consumeLauncher(draft)
    const exact = draft.tabs.find((tab): tab is WorkbenchExternalTab => tab.type === 'external'
      && tab.kind === input.kind && tab.address === input.address)
    const existing = input.reuseAddress
      ? exact ?? (input.params === undefined ? draft.tabs.find((tab): tab is WorkbenchExternalTab =>
        tab.type === 'external' && tab.kind === input.kind && tab.address !== input.address
        && (draft.knownExternalAddresses[input.kind] ?? []).includes(tab.address)) : undefined)
      : !input.multiple ? draft.tabs.find((tab): tab is WorkbenchExternalTab =>
        tab.type === 'external' && tab.kind === input.kind) : undefined
    if (existing !== undefined) {
      if (existing === exact || !input.reuseAddress) {
        existing.name = input.name
        existing.address = input.address
        if (input.params === undefined) delete existing.params
        else existing.params = input.params
        existing.revision++
      }
      if (input.reuseAddress) {
        draft.knownExternalAddresses = { ...draft.knownExternalAddresses,
          [input.kind]: [...new Set([...(draft.knownExternalAddresses[input.kind] ?? []), input.address])] }
      }
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
    addTab(draft, tab, launcherIndex)
    if (input.reuseAddress) {
      draft.knownExternalAddresses = { ...draft.knownExternalAddresses,
        [input.kind]: [...new Set([...(draft.knownExternalAddresses[input.kind] ?? []), input.address])] }
    }
  },
  syncExternalTabs: (draft, { kind, definitionId, fallback, pages, firstSeen }) => {
    const current = new Set(pages.map(page => page.address))
    const previous = new Set(draft.knownExternalAddresses[kind] ?? [])
    const existing = draft.tabs.filter((tab): tab is WorkbenchExternalTab => tab.type === 'external' && tab.kind === kind)
    for (const tab of existing) {
      if (tab.address !== fallback.address && !current.has(tab.address)) workbenchActions.closeExternalTab(draft, tab.id)
    }
    // 只给首次出现的目标开标签；手动关闭的视图不会在下一次目录轮询中复活。
    for (const page of pages) {
      const tab = draft.tabs.find((candidate): candidate is WorkbenchExternalTab =>
        candidate.type === 'external' && candidate.kind === kind && candidate.address === page.address)
      if (tab !== undefined) {
        if (tab.name !== page.name) tab.name = page.name
        continue
      }
      const fallbackTab = draft.tabs.find((tab): tab is WorkbenchExternalTab =>
        tab.type === 'external' && tab.kind === kind && tab.address === fallback.address)
      if (fallbackTab !== undefined) {
        fallbackTab.address = page.address
        fallbackTab.name = page.name
        fallbackTab.params = page.params
        fallbackTab.revision++
        continue
      }
      if (previous.has(page.address)) continue
      const newTab: WorkbenchExternalTab = { type: 'external', id: externalTabId(kind, draft.nextExternalNumber++),
        definitionId, kind, name: page.name, address: page.address, params: page.params, revision: 0 }
      draft.tabs.push(newTab)
      if (page.address === firstSeen && draft.activeId === null) selectTab(draft, newTab)
    }
    draft.knownExternalAddresses = { ...draft.knownExternalAddresses, [kind]: [...current] }
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
      selectTab(draft, tab)
    }
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
      openHistory: (draft, id: SessionId) => { workbenchActions.openHistory(sessionState(draft, id)) },
      openTerminal: (draft, id: SessionId) => { workbenchActions.openTerminal(sessionState(draft, id)) },
      openLauncher: (draft, id: SessionId) => { workbenchActions.openLauncher(sessionState(draft, id)) },
      openExternalTab: (draft, id: SessionId, input: OpenExternalTabInput) => {
        workbenchActions.openExternalTab(sessionState(draft, id), input)
      },
      syncExternalTabs: (draft, id: SessionId, input: SyncExternalTabsInput) => {
        workbenchActions.syncExternalTabs(sessionState(draft, id), input)
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
