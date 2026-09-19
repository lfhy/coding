import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconFolderOpenOutline16,
  IconFullscreenOutline16,
  IconPanelLeftOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createWorkbenchStore, WorkbenchFileTab } from './store.ts'
import { tabIdForSegments } from './store.ts'
import { NS } from './locales.ts'
import type {
  WorkspaceFileEntry,
  WorkspaceFilePayload,
  WorkspaceFilesPayload,
} from './wire.ts'
import css from './WorkspaceWorkbench.module.css'

/** 文件工作台注入的 Host 读取能力。 */
export interface WorkspaceWorkbenchInjected {
  listFiles: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilesPayload>
  readFile: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilePayload>
}

/** 工作台 slot、viewing store、Host 读取和词典组成的 props。 */
export type WorkspaceWorkbenchProps =
  & PropsRuntime<'workbench'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & PropsLocale<typeof NS>
  & InjectFace<WorkspaceWorkbenchInjected>

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

function ToolbarButton({ label, pressed, onClick, icon }: {
  label: string
  pressed?: boolean
  onClick: () => void
  icon: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
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

function FileTree({ shown, listFiles, onOpen, t }: {
  shown: boolean
  listFiles: WorkspaceWorkbenchInjected['listFiles']
  onOpen: (entry: WorkspaceFileEntry) => void
  t: WorkspaceWorkbenchProps['t']
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Levels>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const requests = useRef(new Map<string, AbortController>())

  const load = useCallback((pathSegments: readonly string[]): void => {
    const key = tabIdForSegments(pathSegments)
    requests.current.get(key)?.abort()
    const request = new AbortController()
    requests.current.set(key, request)
    setLevels(current => ({
      ...current,
      [key]: { phase: 'loading', segments: pathSegments, listing: current[key]?.listing },
    }))
    void listFiles(pathSegments, request.signal).then((listing) => {
      if (request.signal.aborted) return
      setLevels(current => ({ ...current, [key]: { phase: 'ready', segments: pathSegments, listing } }))
    }, () => {
      if (request.signal.aborted) return
      setLevels(current => ({
        ...current,
        [key]: { phase: 'error', segments: pathSegments, listing: current[key]?.listing },
      }))
    }).finally(() => {
      if (requests.current.get(key) === request) requests.current.delete(key)
    })
  }, [listFiles])

  useEffect(() => {
    load([])
    return () => {
      for (const request of requests.current.values()) request.abort()
      requests.current.clear()
    }
  }, [load])

  const toggle = (entry: WorkspaceFileEntry): void => {
    const key = tabIdForSegments(entry.segments)
    const opening = !expanded.has(key)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (opening && levels[key]?.phase !== 'ready') load(entry.segments)
  }
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
  readFile: WorkspaceWorkbenchInjected['readFile']
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
 * 固定工作台内容：文件标签和预览居中，懒加载文件树位于右侧。
 * @param props - 布局状态、Session viewing store 与 Host 文件能力。
 * @returns 保持挂载、可独立隐藏文件侧栏的工作台。
 */
export function WorkspaceWorkbench(props: WorkspaceWorkbenchProps): React.JSX.Element {
  const { shown, fullscreen, bottomOpen, close, toggleFullscreen, toggleBottom, actions, readFile, listFiles, t } = props
  const { tabs, activeId } = props.useStore(state => state)
  const [filesOpen, setFilesOpen] = useState(true)
  const active = useMemo(() => tabs.find(tab => tab.id === activeId), [activeId, tabs])

  return (
    <section
      className={css.root}
      hidden={!shown}
      aria-label={t('workbench.label')}
      data-fullscreen={fullscreen || undefined}
    >
      <header className={css.topbar}>
        <ToolbarButton label={t('workbench.close')} onClick={close} icon={<IconCloseOutline16 />} />
        <div className={css.tabs} role="tablist" aria-label={t('tabs.label')}>
          {tabs.map((tab, index) => {
            const selected = tab.id === activeId
            const panelId = `workbench-preview-${String(index)}`
            return (
              <div className={clsx(css.tab, selected && css.tabActive)} role="presentation" key={tab.id}>
                <button
                  type="button"
                  className={css.tabSelect}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  title={tab.name}
                  onClick={() => { actions.activateFile(tab.id) }}
                >
                  <FileGlyph />
                  <span>{tab.name}</span>
                </button>
                <button
                  type="button"
                  className={css.tabClose}
                  aria-label={t('tabs.close', { name: tab.name })}
                  title={t('tabs.close', { name: tab.name })}
                  onClick={() => { actions.closeFile(tab.id) }}
                >
                  <IconCloseOutline16 size={12} />
                </button>
              </div>
            )
          })}
        </div>
        <div className={css.viewControls}>
          <ToolbarButton
            label={fullscreen ? t('workbench.fullscreen.exit') : t('workbench.fullscreen.enter')}
            pressed={fullscreen}
            onClick={toggleFullscreen}
            icon={<IconFullscreenOutline16 />}
          />
          <ToolbarButton
            label={bottomOpen ? t('workbench.bottom.hide') : t('workbench.bottom.show')}
            pressed={bottomOpen}
            onClick={toggleBottom}
            icon={<IconPanelLeftOutline16 className={css.bottomPanelIcon} />}
          />
          <ToolbarButton
            label={filesOpen ? t('workbench.files.hide') : t('workbench.files.show')}
            pressed={filesOpen}
            onClick={() => { setFilesOpen(value => !value) }}
            icon={<IconPanelLeftOutline16 className={css.rightPanelIcon} />}
          />
        </div>
      </header>
      <div className={clsx(css.body, !filesOpen && css.filesClosed)}>
        <main className={css.previewStack}>
          {tabs.map((tab, index) => (
            <div id={`workbench-preview-${String(index)}`} className={css.previewSlot} key={tab.id}>
              <FilePreview tab={tab} visible={tab.id === activeId} readFile={readFile} t={t} />
            </div>
          ))}
          {active === undefined && (
            <div className={css.emptyState}>
              <IconFolderOpenOutline16 size={36} />
              <strong>{t('workbench.empty.title')}</strong>
              <span>{t('workbench.empty.detail')}</span>
              <button type="button" className={css.inlineAction} onClick={close}>{t('workbench.close')}</button>
            </div>
          )}
        </main>
        <FileTree
          shown={filesOpen}
          listFiles={listFiles}
          onOpen={(entry) => { actions.openFile({ name: entry.name, segments: entry.segments }) }}
          t={t}
        />
      </div>
    </section>
  )
}
