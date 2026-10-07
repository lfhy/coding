import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14,
  IconChevronLeftOutline14,
  IconCloseOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconFolderOpenOutline16,
  IconBrowseOutline16,
  IconChecklistOutline14,
  IconNewChatOutline16,
  IconFullscreenOutline16,
  Icon,
  IconRefreshOutline16,
  IconPlusOutline16,
  IconSearchOutline16,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  HostObservable,
  PropsLocale,
  PropsRuntime,
  PropsRenderSlots,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  createWorkbenchStore, createRetainedWorkbenchStore, WorkbenchExternalTab, WorkbenchFileTab, WorkbenchState,
} from './store.ts'
import type { SidebarRightTabDefinition } from './sidebar-tab-registry.ts'
import type { SidebarRightTabOwnerProps } from './index.ts'
import { TerminalPanel } from './TerminalPanel.tsx'
import { tabIdForSegments } from './store.ts'
import { NS } from './locales.ts'
import type {
  WorkspaceFileEntry,
  WorkspaceFilePayload,
  WorkspaceFilesPayload,
} from './wire.ts'
import css from './WorkspaceWorkbench.module.css'

/** 根级工作台按所属 Session 调用 Host 和布局动作。 */
export interface WorkspaceWorkbenchInjected {
  hooks: { sidebarRightTabs: HostObservable<readonly SidebarRightTabDefinition[]> }
  listFiles: (sessionId: SessionId, segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilesPayload>
  readFile: (sessionId: SessionId, segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilePayload>
  terminalUrl: (sessionId: SessionId) => string
  closeWorkbench: (sessionId: SessionId) => void
  openWorkbench: (sessionId: SessionId) => void
  toggleWorkbenchFullscreen: (sessionId: SessionId) => void
  toggleBottom: (sessionId: SessionId) => void
  openSidebarTab: (sessionId: SessionId, kind: string) => void
}

/** 工作台 slot、根级 viewing store、Host 能力和词典组成的 props。 */
export type WorkspaceWorkbenchProps =
  & PropsRuntime<'workbench'>
  & PropsRenderSlots<'workbench.browser' | 'workbench.browser.tabs'
    | 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'>
  & PropsStore<ReturnType<typeof createRetainedWorkbenchStore>>
  & PropsLocale<typeof NS>
  & InjectFace<WorkspaceWorkbenchInjected>

type WorkbenchActions = Omit<BoundActions<ReturnType<typeof createWorkbenchStore>>, 'activateFile' | 'closeFile'>
type WorkbenchViewProps = Pick<WorkspaceWorkbenchProps, 'shown' | 'fullscreen' | 'bottomOpen' | 't' | 'renderSlot'> & {
  sessionId: SessionId
  narrow: boolean
  state: WorkbenchState
  tabDefinitions: readonly SidebarRightTabDefinition[]
  actions: WorkbenchActions
  completedFocusTabId: string | null
  panelPrefix: string
  selectTab: (id: string, focus: boolean) => void
  closeWorkbench: () => void
  openWorkbench: () => void
  toggleWorkbenchFullscreen: () => void
  toggleBottom: () => void
  openSidebarTab: (kind: string) => void
  listFiles: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilesPayload>
  readFile: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilePayload>
}

interface LevelState {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly segments: readonly string[]
  readonly listing: WorkspaceFilesPayload | undefined
}

type Levels = Readonly<Record<string, LevelState | undefined>>

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 目录优先，同类型按用户 locale 对文件名排序。 */
export function sortTreeEntries(entries: readonly WorkspaceFileEntry[]): readonly WorkspaceFileEntry[] {
  return entries.toSorted((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1
    if (left.type !== 'directory' && right.type === 'directory') return 1
    return nameCollator.compare(left.name, right.name)
  })
}

/** 紧凑显示文件大小。 */
export function formatBytes(size: number | undefined): string {
  if (size === undefined) return ''
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MiB`
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

function ToolbarButton({ label, pressed, onClick, icon, buttonRef }: {
  label: string
  pressed?: boolean
  onClick: () => void
  icon: ReactNode
  buttonRef?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        ref={buttonRef}
        className={css.toolButton}
        title={label}
        aria-label={label}
        {...pressed === undefined ? {} : { 'aria-pressed': pressed }}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

function tabDomId(prefix: string, sessionId: string, tabId: string, kind: 'tab' | 'panel'): string {
  return `${prefix}-${kind}-${encodeURIComponent(sessionId)}-${encodeURIComponent(tabId)}`
}

function externalTabOwner(
  tab: WorkbenchExternalTab,
  shown: boolean,
  prefix: string,
  sessionId: SessionId,
  selectTab: () => void,
  closeTab: () => void,
): SidebarRightTabOwnerProps {
  return {
    tab, shown,
    tabDomId: tabDomId(prefix, sessionId, tab.id, 'tab'),
    panelDomId: tabDomId(prefix, sessionId, tab.id, 'panel'),
    selectTab, closeTab,
  }
}

function guideAvailable(definition: SidebarRightTabDefinition): boolean {
  try {
    return definition.canOpen?.(`sidebar://${encodeURIComponent(definition.kind)}`) !== false
  } catch {
    return false
  }
}

function FileGlyph(): React.JSX.Element {
  return <span className={css.fileGlyph} aria-hidden />
}

function TreeLevel({
  pathSegments,
  levels,
  expanded,
  query,
  onToggle,
  onOpen,
  onRetry,
  t,
}: {
  pathSegments: readonly string[]
  levels: Levels
  expanded: ReadonlySet<string>
  query: string
  onToggle: (entry: WorkspaceFileEntry) => void
  onOpen: (entry: WorkspaceFileEntry) => void
  onRetry: (segments: readonly string[]) => void
  t: WorkspaceWorkbenchProps['t']
}): React.JSX.Element {
  const key = tabIdForSegments(pathSegments)
  const state = levels[key]
  if (state === undefined) {
    return <li className={css.treeMessage} role="status">{t('files.loading')}</li>
  }
  if (state.phase === 'error') {
    return (
      <li className={css.treeMessage} role="alert">
        <span>{t('files.error')}</span>
        <button type="button" className={css.inlineAction} onClick={() => { onRetry(pathSegments) }}>
          {t('files.retry')}
        </button>
      </li>
    )
  }
  if (state.listing === undefined) {
    return <li className={css.treeMessage} role="status">{t('files.loading')}</li>
  }
  const entries = sortTreeEntries(state.listing.entries).filter(entry =>
    query === '' || entry.name.toLocaleLowerCase().includes(query))
  return (
    <>
      {entries.map((entry) => {
        const entryKey = tabIdForSegments(entry.segments)
        const directory = entry.type === 'directory'
        const open = directory && expanded.has(entryKey)
        return (
          <li className={css.treeItem} role="treeitem" key={entryKey} aria-expanded={directory ? open : undefined}>
            {entry.type === 'other' ? (
              <div className={css.treeRow} title={t('files.type.other')}>
                <span className={css.chevronSpace} />
                <FileGlyph />
                <span className={css.treeName}>{entry.name}</span>
              </div>
            ) : (
              <button
                type="button"
                className={css.treeRow}
                title={entry.name}
                onClick={() => {
                  if (directory) onToggle(entry)
                  else onOpen(entry)
                }}
              >
                {directory ? (
                  <IconChevronRightOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
                ) : <span className={css.chevronSpace} />}
                {directory
                  ? open ? <IconFolderOpen16 className={css.entryIcon} /> : <IconFolderClose16 className={css.entryIcon} />
                  : <FileGlyph />}
                <span className={css.treeName}>{entry.name}</span>
                {entry.type === 'file' && <span className={css.treeSize}>{formatBytes(entry.size)}</span>}
              </button>
            )}
            {open && (
              <ul className={css.treeGroup} role="group">
                <TreeLevel
                  pathSegments={entry.segments}
                  levels={levels}
                  expanded={expanded}
                  query={query}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onRetry={onRetry}
                  t={t}
                />
              </ul>
            )}
          </li>
        )
      })}
      {entries.length === 0 && <li className={css.treeMessage}>{t('files.empty')}</li>}
      {state.listing.truncated && (
        <li className={css.treeNotice} role="status">{t('files.truncated')}</li>
      )}
      {state.phase === 'loading' && (
        <li className={css.treeNotice} role="status">{t('files.loading')}</li>
      )}
    </>
  )
}

function FileTree({ shown, onOpen, query, expanded, levels, setQuery, toggle, load, t }: {
  shown: boolean
  onOpen: (entry: WorkspaceFileEntry) => void
  query: string
  expanded: ReadonlySet<string>
  levels: Levels
  setQuery: (query: string) => void
  toggle: (entry: WorkspaceFileEntry) => void
  load: (segments: readonly string[]) => void
  t: WorkspaceWorkbenchProps['t']
}): React.JSX.Element {
  const root = levels[tabIdForSegments([])]?.listing
  const normalizedQuery = query.trim().toLocaleLowerCase()

  return (
    <aside className={css.filesPanel} hidden={!shown} aria-label={t('files.label')}>
      <div className={css.filesHeader}>
        <div className={css.filesPath} title={root?.path}>{root?.path ?? t('files.label')}</div>
        <ToolbarButton label={t('preview.refresh')} onClick={() => { load([]) }} icon={<IconRefreshOutline16 />} />
      </div>
      <label className={css.search}>
        <IconSearchOutline16 className={css.searchIcon} />
        <span className={css.visuallyHidden}>{t('files.filter')}</span>
        <input
          type="search"
          value={query}
          placeholder={t('files.filter')}
          onChange={(event) => { setQuery(event.currentTarget.value) }}
        />
      </label>
      <ul className={css.tree} role="tree" aria-label={t('files.label')}>
        <TreeLevel
          pathSegments={[]}
          levels={levels}
          expanded={expanded}
          query={normalizedQuery}
          onToggle={toggle}
          onOpen={onOpen}
          onRetry={load}
          t={t}
        />
      </ul>
    </aside>
  )
}

interface PreviewState {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly payload?: WorkspaceFilePayload
}

function PreviewContent({ payload, name, t }: {
  payload: WorkspaceFilePayload
  name: string
  t: WorkspaceWorkbenchProps['t']
}): React.JSX.Element {
  const content = payload.content
  if (content.kind === 'markdown') {
    return <div className={css.markdown}><MarkdownText text={content.text} /></div>
  }
  if (content.kind === 'code') {
    return <pre className={css.source}><code data-language={content.language}>{content.text}</code></pre>
  }
  if (content.kind === 'text') return <pre className={css.source}>{content.text}</pre>
  if (content.kind === 'image') {
    return (
      <div className={css.imageStage}>
        <img src={`data:${content.mimeType};base64,${content.data}`} alt={name} />
      </div>
    )
  }
  return (
    <div className={css.previewMessage} role="status">
      {content.mimeType === undefined
        ? t('preview.unsupported')
        : t('preview.unsupported.mime', { mime: content.mimeType })}
    </div>
  )
}

function FilePreview({ tab, visible, readFile, t }: {
  tab: WorkbenchFileTab
  visible: boolean
  readFile: WorkbenchViewProps['readFile']
  t: WorkspaceWorkbenchProps['t']
}): React.JSX.Element {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<PreviewState>({ phase: 'loading' })

  useEffect(() => {
    const request = new AbortController()
    setState({ phase: 'loading' })
    void readFile(tab.segments, request.signal).then(
      (payload) => { if (!request.signal.aborted) setState({ phase: 'ready', payload }) },
      () => { if (!request.signal.aborted) setState({ phase: 'error' }) },
    )
    return () => { request.abort() }
  }, [readFile, revision, tab.segments])

  return (
    <article className={css.preview} hidden={!visible} aria-label={tab.name}>
      <header className={css.previewHeader}>
        <span className={css.previewPath} title={state.payload?.path}>{state.payload?.path ?? tab.name}</span>
        <ToolbarButton
          label={t('preview.refresh')}
          onClick={() => { setRevision(value => value + 1) }}
          icon={<IconRefreshOutline16 />}
        />
      </header>
      <div className={css.previewBody}>
        {state.phase === 'loading' && <div className={css.previewMessage} role="status">{t('preview.loading')}</div>}
        {state.phase === 'error' && (
          <div className={css.previewMessage} role="alert">
            <span>{t('preview.error')}</span>
            <button type="button" className={css.inlineAction} onClick={() => { setRevision(value => value + 1) }}>
              {t('preview.retry')}
            </button>
          </div>
        )}
        {state.phase === 'ready' && state.payload !== undefined && (
          <PreviewContent payload={state.payload} name={tab.name} t={t} />
        )}
      </div>
    </article>
  )
}

/**
 * 根级工作台保留每个 Session 的终端；会话切换只替换文件与浏览器的展示树。
 * @param props - 布局状态、根级 tab store、Host 能力和本地化文案。
 * @returns 按类型渲染内容并保留已激活 PTY 的工作台。
 */
export function WorkspaceWorkbench(props: WorkspaceWorkbenchProps): React.JSX.Element {
  const sessionId = props.useSessions(state => state.current)
  const sessionIds = props.useSessions(state => state.ids)
  const sessions = props.useStore(state => state.sessions)
  const panelPrefix = useId()
  const rootRef = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [focusRequest, setFocusRequest] = useState<number | null>(0)
  const [completedFocus, setCompletedFocus] = useState<{ sessionId: SessionId; tabId: string } | null>(null)
  const state = sessionId === undefined ? undefined : sessions[sessionId]
  useEffect(() => { setFocusRequest(0) }, [props.shown, sessionId])
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setNarrow(entry.contentRect.width <= 640)
    })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [])
  useEffect(() => {
    props.actions.retainSessions(sessionIds)
    if (sessionId !== undefined && sessionIds.includes(sessionId)) props.actions.initSession(sessionId)
  }, [props.actions, sessionId, sessionIds])
  const viewProps = useMemo(() => {
    if (sessionId === undefined) return undefined
    const actions: WorkbenchActions = {
      setView: (view) => { props.actions.setView(sessionId, view) },
      openFile: (file) => { props.actions.openFile(sessionId, file) },
      openFileManager: () => { props.actions.openFileManager(sessionId) },
      openTerminal: () => {
        setFocusRequest(previous => (previous ?? 0) + 1)
        props.actions.openTerminal(sessionId)
      },
      openExternalTab: (input) => { props.actions.openExternalTab(sessionId, input) },
      updateExternalTab: (tabId, update) => { props.actions.updateExternalTab(sessionId, tabId, update) },
      closeExternalTab: (tabId) => { props.actions.closeExternalTab(sessionId, tabId) },
      activateTab: (id) => { props.actions.activateTab(sessionId, id) },
      closeTab: (id) => {
        setFocusRequest(null)
        props.actions.closeTab(sessionId, id)
      },
      syncBrowserTabs: (tabs, activeId) => { props.actions.syncBrowserTabs(sessionId, tabs, activeId) },
      beginBrowserLink: (id, url) => { props.actions.beginBrowserLink(sessionId, id, url) },
      completeBrowserLink: (id, tabId) => {
        props.actions.completeBrowserLink(sessionId, id, tabId)
      },
      failBrowserLink: (id, message) => { props.actions.failBrowserLink(sessionId, id, message) },
      clearBrowserLinks: () => { props.actions.clearBrowserLinks(sessionId) },
      recordInteraction: () => { props.actions.recordInteraction(sessionId) },
      autoRevealBrowser: (tabId, epoch) => { props.actions.autoRevealBrowser(sessionId, tabId, epoch) },
      setFilesQuery: (query) => { props.actions.setFilesQuery(sessionId, query) },
      toggleFilesExpanded: (key) => { props.actions.toggleFilesExpanded(sessionId, key) },
      setFilesLevel: (segments, phase) => { props.actions.setFilesLevel(sessionId, segments, phase) },
      setFilesListing: (segments, listing) => { props.actions.setFilesListing(sessionId, segments, listing) },
    }
    return {
      actions,
      selectTab: (id: string, focus: boolean) => {
        setFocusRequest(previous => focus ? (previous ?? 0) + 1 : null)
        actions.activateTab(id)
      },
      listFiles: (segments: readonly string[], signal?: AbortSignal) => props.listFiles(sessionId, segments, signal),
      readFile: (segments: readonly string[], signal?: AbortSignal) => props.readFile(sessionId, segments, signal),
      closeWorkbench: () => {
        props.actions.recordInteraction(sessionId)
        props.closeWorkbench(sessionId)
      },
      openWorkbench: () => { props.openWorkbench(sessionId) },
      toggleWorkbenchFullscreen: () => { props.toggleWorkbenchFullscreen(sessionId) },
      toggleBottom: () => { props.toggleBottom(sessionId) },
      openSidebarTab: (kind: string) => { props.openSidebarTab(sessionId, kind) },
    }
  }, [props.actions, props.listFiles, props.readFile, props.closeWorkbench, props.openWorkbench,
    props.toggleWorkbenchFullscreen, props.toggleBottom, props.openSidebarTab, sessionId])
  const terminalShown = props.shown && state?.view === 'terminal'
  const tabDefinitions = props.useSidebarRightTabs(definitions => definitions)
  return <section ref={rootRef} className={css.root} hidden={!props.shown || state === undefined}
    aria-label={props.t('workbench.label')} data-fullscreen={props.fullscreen || undefined}
    data-narrow={narrow || undefined}>
    {state !== undefined && viewProps !== undefined && <WorkbenchView key={sessionId}
      {...props} {...viewProps} sessionId={sessionId as SessionId} state={state} panelPrefix={panelPrefix}
      narrow={narrow} tabDefinitions={tabDefinitions}
      completedFocusTabId={completedFocus !== null && completedFocus.sessionId === sessionId
        ? completedFocus.tabId : null} />}
    <div className={css.terminalStack} hidden={!terminalShown} {...!terminalShown ? { inert: '' } : {}}>
      {Object.entries(sessions).flatMap(([id, session]) => session.tabs.filter(tab => tab.type === 'terminal').map(tab => (
        <TerminalPanel key={`${id}:${tab.id}`} terminalUrl={props.terminalUrl(id as SessionId)} t={props.t}
          shown={terminalShown && id === sessionId && tab.id === state.activeId} focusRequest={focusRequest}
          panelId={tabDomId(panelPrefix, id, tab.id, 'panel')} tabId={tabDomId(panelPrefix, id, tab.id, 'tab')}
          onCompleted={() => {
            const wasActive = props.shown && id === sessionId && state?.activeId === tab.id
            if (wasActive) setFocusRequest(null)
            props.actions.closeTab(id as SessionId, tab.id)
            if (wasActive) setCompletedFocus({ sessionId: id as SessionId, tabId: tab.id })
          }} />
      )))}
    </div>
  </section>
}

function WorkbenchView(props: WorkbenchViewProps): React.JSX.Element {
  const {
    shown, fullscreen, bottomOpen, narrow, actions, readFile, listFiles, completedFocusTabId,
    closeWorkbench, openWorkbench, toggleWorkbenchFullscreen, toggleBottom, openSidebarTab, t, renderSlot,
    panelPrefix, selectTab, tabDefinitions,
  } = props
  const { view, tabs, activeId, filesQuery, filesExpanded, filesLevels } = props.state
  const guideEntries = tabDefinitions.flatMap(definition => (definition.guide ?? []).map(entry => ({
    definition, entry,
  }))).sort((left, right) => left.entry.order - right.entry.order)
  const [guideError, setGuideError] = useState<string | null>(null)
  const active = useMemo(() => tabs.find(tab => tab.id === activeId), [activeId, tabs])
  const narrowPreview = narrow && view === 'files' && active?.type === 'file'
  const treeVisible = view === 'files' && !narrowPreview
  // 窄屏目录树承接文件管理器标签的面板关联，宽屏仍与预览区并列。
  const narrowFileManager = narrow ? tabs.find(tab => tab.type === 'file-manager') : undefined
  const browserShown = shown && view === 'browser'
  const [newTabRequest, setNewTabRequest] = useState(0)
  const [handledTabRequest, setHandledTabRequest] = useState(0)
  const markTabRequestHandled = useCallback((request: number): void => {
    setHandledTabRequest(previous => Math.max(previous, request))
  }, [])
  const showBrowser = useCallback((tabId?: string): void => {
    actions.setView('browser')
    if (tabId !== undefined) actions.activateTab(`browser:${tabId}`)
    openWorkbench()
  }, [actions, openWorkbench])
  const requestAutoReveal = useCallback((epoch: number): boolean => {
    if (props.state.interactionEpoch !== epoch) return false
    openWorkbench()
    return true
  }, [props.state.interactionEpoch, openWorkbench])
  const wasShown = useRef(shown)
  useEffect(() => {
    if (wasShown.current && !shown) actions.recordInteraction()
    wasShown.current = shown
  }, [shown, actions])
  const returnButton = useRef<HTMLButtonElement>(null)
  const menuTerminalButton = useRef<HTMLButtonElement>(null)
  const tablist = useRef<HTMLDivElement>(null)
  const pendingBrowserFocus = useRef<string | null>(null)
  const browserFocusAllowed = useRef(browserShown)
  browserFocusAllowed.current = browserShown
  const focusAfterClose = useRef(false)
  const lastCompletedFocus = useRef(completedFocusTabId)
  const pendingFocus = useRef<'menu' | 'return' | null>(null)
  const previousView = useRef(view)
  const showFiles = useCallback((): void => {
    pendingFocus.current = 'return'
    actions.openFileManager()
  }, [actions])
  const showMenu = useCallback((): void => {
    pendingFocus.current = 'menu'
    setGuideError(null)
    actions.setView('menu')
  }, [actions])
  useEffect(() => {
    if (view === 'menu' && previousView.current !== 'menu') menuTerminalButton.current?.focus()
    previousView.current = view
    if (pendingFocus.current === view) {
      menuTerminalButton.current?.focus()
      pendingFocus.current = null
    } else if (pendingFocus.current === 'return' && view !== 'menu') {
      returnButton.current?.focus()
      pendingFocus.current = null
    }
  }, [view])
  useLayoutEffect(() => {
    if (!focusAfterClose.current) return
    focusAfterClose.current = false
    if (view === 'menu') menuTerminalButton.current?.focus()
    else tablist.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [tabs, view])
  useLayoutEffect(() => {
    if (completedFocusTabId === null || lastCompletedFocus.current === completedFocusTabId
      || tabs.some(tab => tab.id === completedFocusTabId)) return
    lastCompletedFocus.current = completedFocusTabId
    if (view === 'menu') menuTerminalButton.current?.focus()
    else tablist.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [completedFocusTabId, tabs, view])
  const focusPendingBrowserTab = useCallback((tabId: string): void => {
    if (!browserFocusAllowed.current || pendingBrowserFocus.current !== tabId) return
    const button = Array.from(tablist.current?.querySelectorAll<HTMLButtonElement>('[data-browser-tab-id]') ?? [])
      .find(candidate => candidate.dataset.browserTabId === tabId)
    if (button === undefined || button.disabled) return
    button.focus()
    pendingBrowserFocus.current = null
  }, [])
  const focusBrowserTab = useCallback((tabId: string): void => {
    if (!browserFocusAllowed.current) return
    pendingBrowserFocus.current = tabId
    focusPendingBrowserTab(tabId)
  }, [focusPendingBrowserTab])
  useLayoutEffect(() => {
    if (!browserShown) {
      pendingBrowserFocus.current = null
      return
    }
    if (pendingBrowserFocus.current !== null) focusPendingBrowserTab(pendingBrowserFocus.current)
  }, [tabs, browserShown, focusPendingBrowserTab])
  const expanded = useMemo(() => new Set(filesExpanded), [filesExpanded])
  const requests = useRef(new Map<string, AbortController>())
  const rootKey = tabIdForSegments([])
  const rootRequested = useRef(filesLevels[rootKey] !== undefined && filesLevels[rootKey].phase !== 'loading')
  const interruptedLevels = useRef(Object.values(filesLevels)
    .filter((level): level is LevelState => level?.phase === 'loading' && tabIdForSegments(level.segments) !== rootKey))
  const load = useCallback((pathSegments: readonly string[]): void => {
    const key = tabIdForSegments(pathSegments)
    requests.current.get(key)?.abort()
    const request = new AbortController()
    requests.current.set(key, request)
    actions.setFilesLevel(pathSegments, 'loading')
    void listFiles(pathSegments, request.signal).then((listing) => {
      if (request.signal.aborted) return
      actions.setFilesListing(pathSegments, listing)
    }, () => {
      if (request.signal.aborted) return
      actions.setFilesLevel(pathSegments, 'error')
    }).finally(() => {
      if (requests.current.get(key) === request) requests.current.delete(key)
    })
  }, [actions, listFiles])

  useEffect(() => {
    if (shown && view === 'files' && !rootRequested.current
      && (filesLevels[rootKey] === undefined || filesLevels[rootKey].phase === 'loading')) {
      rootRequested.current = true
      load([])
    }
  }, [filesLevels, load, rootKey, shown, view])

  useEffect(() => {
    if (!shown || view !== 'files') return
    // Session 展示树重挂载时，继续被上一棵树取消的目录读取。
    for (const level of interruptedLevels.current) load(level.segments)
    interruptedLevels.current = []
  }, [load, shown, view])

  useEffect(() => {
    return () => {
      for (const request of requests.current.values()) request.abort()
      requests.current.clear()
    }
  }, [])

  const toggle = useCallback((entry: WorkspaceFileEntry): void => {
    const key = tabIdForSegments(entry.segments)
    const opening = !expanded.has(key)
    actions.toggleFilesExpanded(key)
    if (opening && filesLevels[key]?.phase !== 'ready') load(entry.segments)
  }, [actions, expanded, filesLevels, load])

  const browserOwner = {
    shown: browserShown,
    interactionEpoch: props.state.interactionEpoch,
    browserAutoRevealed: props.state.browserAutoRevealed,
    requestAutoReveal,
    autoRevealBrowser: actions.autoRevealBrowser,
    newTabRequest,
    handledTabRequest,
    markTabRequestHandled,
    focusBrowserTab,
    focusPendingBrowserTab,
    openBrowser: showBrowser,
    syncBrowserTabs: actions.syncBrowserTabs,
    beginBrowserLink: (id: string, url: string) => {
      actions.beginBrowserLink(id, url)
      openWorkbench()
    },
    completeBrowserLink: actions.completeBrowserLink,
    failBrowserLink: actions.failBrowserLink,
    clearBrowserLinks: actions.clearBrowserLinks,
    selectPendingBrowserLink: (id: string) => { actions.activateTab(id) },
    closePendingBrowserLink: (id: string) => { actions.closeTab(id) },
    ...view === 'browser' && active?.type === 'browser' ? { selectedTabId: active.browserTabId } : {},
  }
  return (
    <>
      <header className={css.topbar} data-window-drag-region="">
        <div ref={tablist} className={css.tabs} role="tablist" aria-label={t('tabs.label')}
          tabIndex={view === 'menu' && tabs.length > 0 ? 0 : undefined}
          onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
            const index = buttons.indexOf(event.target as HTMLButtonElement)
            if (buttons.length === 0 || (index < 0 && event.target !== event.currentTarget)) return
            const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
              : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
            if (next < 0) return
            event.preventDefault()
            buttons[next]?.click()
            buttons[next]?.focus()
          }}>
          {tabs.map((tab, index) => {
            if (tab.type === 'browser' || tab.type === 'browser-pending') return <div key={tab.id} className={css.browserTabs}>
              {renderSlot('workbench.browser.tabs', { ...browserOwner, shown,
                ...tab.type === 'browser' ? { tabId: tab.browserTabId, tabName: tab.name } : {
                  pendingBrowserLink: tab,
                }, browserShown: browserShown && activeId === tab.id,
                tabDomId: tabDomId(panelPrefix, props.sessionId, tab.id, 'tab'),
                panelDomId: tabDomId(panelPrefix, props.sessionId, tab.id, 'panel') })}
            </div>
            if (tab.type === 'external') {
              const selected = view === 'external' && activeId === tab.id
              const definitionId = tabDefinitions.find(candidate => candidate.kind === tab.kind)?.id ?? tab.definitionId
              const owner = externalTabOwner(tab, shown && selected, panelPrefix, props.sessionId,
                () => { selectTab(tab.id, true) }, () => { actions.closeExternalTab(tab.id) })
              return <div className={clsx(css.tab, selected && css.tabActive)} role="presentation" key={tab.id}>
                <button type="button" className={css.tabSelect} role="tab" aria-selected={selected}
                  tabIndex={selected || (view === 'menu' && index === 0) ? 0 : -1}
                  aria-controls={owner.panelDomId} id={owner.tabDomId} title={tab.name}
                  onClick={(event) => { selectTab(tab.id, event.detail !== 0) }}>
                  <span className={css.externalTitle}>
                    {renderSlot('sidebar.right.pane.tab.title', owner, {
                      entryKey: definitionId, hookContext: owner, fallback: tab.name,
                    })}
                  </span>
                </button>
                <button type="button" className={css.tabClose}
                  aria-label={t('tabs.close', { name: tab.name })}
                  title={t('tabs.close', { name: tab.name })} onClick={() => {
                    focusAfterClose.current = true
                    actions.closeExternalTab(tab.id)
                  }}>
                  <IconCloseOutline16 size={12} />
                </button>
              </div>
            }
            const name = tab.type === 'terminal' ? t('terminal.tab', { number: String(tab.number) })
              : tab.type === 'file-manager' ? t('files.tab') : tab.name
            const selected = tab.id === activeId && view === (tab.type === 'file' || tab.type === 'file-manager'
              ? 'files' : 'terminal')
            return <div className={clsx(css.tab, selected && css.tabActive)} role="presentation" key={tab.id}>
              <button type="button" className={css.tabSelect} role="tab" aria-selected={selected}
                tabIndex={selected || (view === 'menu' && index === 0) ? 0 : -1}
                aria-controls={tabDomId(panelPrefix, props.sessionId, tab.id, 'panel')}
                id={tabDomId(panelPrefix, props.sessionId, tab.id, 'tab')} title={name}
                onClick={(event) => { selectTab(tab.id, event.detail !== 0) }}>
                {tab.type === 'terminal' ? <Icon name="terminal-menu" size={14} />
                  : tab.type === 'file-manager' ? <IconFolderOpenOutline16 size={14} /> : <FileGlyph />}
                <span>{name}</span>
              </button>
              <button type="button" className={css.tabClose} aria-label={t('tabs.close', { name })}
                title={t('tabs.close', { name })} onClick={() => {
                  focusAfterClose.current = true
                  actions.closeTab(tab.id)
                }}>
                <IconCloseOutline16 size={12} />
              </button>
            </div>
          })}
          <ToolbarButton label={t('tabs.add')} onClick={showMenu} icon={<IconPlusOutline16 size={14} />} />
        </div>
        <div className={css.viewControls}>
          {view !== 'menu' && (
            <ToolbarButton
              label={t('workbench.menu.back')}
              onClick={showMenu}
              buttonRef={returnButton}
              icon={<IconChevronLeftOutline14 size={14} />}
            />
          )}
          {fullscreen && (
            <ToolbarButton
              label={bottomOpen ? t('workbench.bottom.hide') : t('workbench.bottom.show')}
              pressed={bottomOpen}
              onClick={toggleBottom}
              icon={<Icon name="bottom-panel" size={18} />}
            />
          )}
          <ToolbarButton
            label={fullscreen ? t('workbench.fullscreen.exit') : t('workbench.fullscreen.enter')}
            pressed={fullscreen}
            onClick={toggleWorkbenchFullscreen}
            icon={<IconFullscreenOutline16 size={14} />}
          />
          <ToolbarButton
            label={t('workbench.close')}
            onClick={closeWorkbench}
            icon={<IconCloseOutline16 size={14} />}
          />
        </div>
      </header>
      <div className={clsx(css.body, !treeVisible && css.filesClosed)}
        data-file-manager={view === 'files' && active?.type === 'file-manager' || undefined}>
        <main className={css.previewStack}>
          <div className={css.menuView} hidden={view !== 'menu'} {...view !== 'menu' ? { inert: '' } : {}}>
            <nav className={css.functionMenu} aria-label={t('workbench.menu.label')}>
              <button type="button" className={css.functionItem} disabled title={t('workbench.menu.unavailable')}>
                <IconChecklistOutline14 size={18} />
                <span>{t('workbench.menu.review')}</span>
                <small>{t('workbench.menu.unavailable')}</small>
              </button>
              <button type="button" ref={menuTerminalButton} className={css.functionItem} onClick={() => {
                actions.openTerminal()
              }}>
                <Icon name="terminal-menu" size={18} />
                <span>{t('workbench.menu.terminal')}</span>
              </button>
              <button type="button" className={css.functionItem} onClick={() => {
                pendingFocus.current = 'return'
                setNewTabRequest(previous => previous + 1)
                showBrowser()
              }}>
                <IconBrowseOutline16 size={18} />
                <span>{t('workbench.menu.browser')}</span>
              </button>
              <button type="button" className={css.functionItem} onClick={showFiles}>
                <IconFolderOpenOutline16 size={18} />
                <span>{t('workbench.menu.files')}</span>
              </button>
              <button type="button" className={css.functionItem} disabled title={t('workbench.menu.unavailable')}>
                <IconNewChatOutline16 size={18} />
                <span>{t('workbench.menu.chat')}</span>
                <small>{t('workbench.menu.unavailable')}</small>
              </button>
              {guideEntries.map(({ definition, entry }) => {
                let title: string
                let description: string | undefined
                try {
                  title = entry.title()
                  description = entry.description?.()
                } catch {
                  // 第三方词条失效只隐藏自身，不中断内置功能菜单。
                  return null
                }
                const available = guideAvailable(definition)
                return <button type="button" className={css.functionItem} key={`${definition.id}:${entry.id}`}
                  disabled={!available} title={!available ? t('workbench.menu.unavailable') : undefined}
                  onClick={() => {
                    pendingFocus.current = 'return'
                    try {
                      openSidebarTab(definition.kind)
                      setGuideError(null)
                    } catch {
                      pendingFocus.current = null
                      setGuideError(t('workbench.menu.unavailable'))
                    }
                  }}>
                  <IconPlusOutline16 size={18} />
                  <span>{title}</span>
                  {description !== undefined && <small>{description}</small>}
                </button>
              })}
              {guideError !== null && <p className={css.guideError} role="alert">{guideError}</p>}
            </nav>
          </div>
          <div className={css.fileView} hidden={view !== 'files'} {...view !== 'files' ? { inert: '' } : {}}>
            {tabs.filter(tab => tab.type === 'file-manager' && !narrow).map(tab => (
              <div id={tabDomId(panelPrefix, props.sessionId, tab.id, 'panel')}
                role="tabpanel" aria-labelledby={tabDomId(panelPrefix, props.sessionId, tab.id, 'tab')}
                hidden={tab.id !== activeId || view !== 'files'} className={css.previewSlot} key={tab.id}>
                <div className={css.emptyState}>
                  <IconFolderOpenOutline16 size={36} />
                  <strong>{t('workbench.empty.title')}</strong>
                  <span>{t('workbench.empty.detail')}</span>
                </div>
              </div>
            ))}
            {tabs.filter(tab => tab.type === 'file').map(tab => (
              <div id={tabDomId(panelPrefix, props.sessionId, tab.id, 'panel')}
                role="tabpanel" aria-labelledby={tabDomId(panelPrefix, props.sessionId, tab.id, 'tab')}
                hidden={tab.id !== activeId || view !== 'files'} className={css.previewSlot} key={tab.id}>
                <FilePreview tab={tab} visible={tab.id === activeId && view === 'files'} readFile={readFile} t={t} />
              </div>
            ))}
            {active === undefined && (
              <div className={css.emptyState}>
                <IconFolderOpenOutline16 size={36} />
                <strong>{t('workbench.empty.title')}</strong>
                <span>{t('workbench.empty.detail')}</span>
              </div>
            )}
          </div>
          <div className={css.browserView} hidden={view !== 'browser'} {...view !== 'browser' ? { inert: '' } : {}}>
            <div className={css.browserPanel}
              {...active?.type === 'browser' || active?.type === 'browser-pending' ? {
                id: tabDomId(panelPrefix, props.sessionId, active.id, 'panel'),
                role: 'tabpanel',
                'aria-labelledby': tabDomId(panelPrefix, props.sessionId, active.id, 'tab'),
              } : {}}>
              {renderSlot('workbench.browser', { ...browserOwner,
                ...active?.type === 'browser-pending' ? { pendingBrowserLink: active } : {},
              })}
            </div>
            {tabs.filter(tab => (tab.type === 'browser' || tab.type === 'browser-pending') && tab.id !== activeId).map(tab => (
              <div key={tab.id} id={tabDomId(panelPrefix, props.sessionId, tab.id, 'panel')}
                role="tabpanel" aria-labelledby={tabDomId(panelPrefix, props.sessionId, tab.id, 'tab')}
                hidden {...{ inert: '' }} />
            ))}
          </div>
          {tabs.filter((tab): tab is WorkbenchExternalTab => tab.type === 'external').map((tab) => {
            const visible = shown && view === 'external' && activeId === tab.id
            const definition = tabDefinitions.find(candidate => candidate.kind === tab.kind)
            if (!visible && definition?.keepMounted !== true) return null
            const owner = externalTabOwner(tab, visible, panelPrefix, props.sessionId,
              () => { selectTab(tab.id, true) }, () => { actions.closeExternalTab(tab.id) })
            return <div className={css.externalPanel} key={tab.id} id={owner.panelDomId}
              role="tabpanel" aria-labelledby={owner.tabDomId} hidden={!visible}
              {...!visible ? { inert: '' } : {}}>
              {renderSlot('sidebar.right.pane.tab', owner, {
                entryKey: definition?.id ?? tab.definitionId, hookContext: owner,
                fallback: <p className={css.previewMessage} role="status">{t('workbench.menu.unavailable')}</p>,
              })}
            </div>
          })}
        </main>
        <div className={css.treeView} hidden={!treeVisible}
          {...narrowFileManager !== undefined ? {
            id: tabDomId(panelPrefix, props.sessionId, narrowFileManager.id, 'panel'),
            role: 'tabpanel',
            'aria-labelledby': tabDomId(panelPrefix, props.sessionId, narrowFileManager.id, 'tab'),
          } : {}}
          {...!treeVisible ? { inert: '' } : {}}>
          <FileTree
            shown={treeVisible}
            onOpen={(entry) => {
              actions.openFile({ name: entry.name, segments: entry.segments })
            }}
            query={filesQuery}
            setQuery={actions.setFilesQuery}
            expanded={expanded}
            levels={filesLevels}
            toggle={toggle}
            load={load}
            t={t}
          />
        </div>
      </div>
    </>
  )
}
