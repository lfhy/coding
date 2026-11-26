/** 打开工作区后的 IDE：文件树、可拖拽分屏的编辑器分组与共享页面助手。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import {
  Button, IconCheckOutline14, IconCodeOutline16, IconFolderOpenOutline16, IconSparkle16, Menu, Modal,
  type MenuEntry,
} from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { SessionId, WorkspaceId, WorkspaceView } from 'coding-client-runtime/client'
import type { WorkspaceFilesService } from 'coding-client-ui-open-in-app/client'
import { dropSideOf } from './ide-drag.ts'
import { IdeEditor } from './IdeEditor.tsx'
import { IdeFileTree } from './IdeFileTree.tsx'
import { IdeTabs } from './IdeTabs.tsx'
import { focusedPane } from './ide-store.ts'
import type { IdeActionsBaked, IdeDocument, IdePaneState, IdeSplitSide, IdeWorkspaceView } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdeWorkspace.module.css'

type DocumentRef = Pick<IdeDocument, 'path' | 'name' | 'segments'>

interface IdeWorkspaceProps {
  workspace: WorkspaceView
  /** 最近工作区，供页头切换菜单使用。 */
  workspaces: readonly WorkspaceView[]
  /** 文件读写使用的会话：该工作区绑定的会话。 */
  fileSessionId: SessionId
  view: IdeWorkspaceView
  actions: IdeActionsBaked
  workspaceFiles: WorkspaceFilesService
  /** 页内切换到另一个工作区；由页面协调会话与路由。 */
  onSwitchWorkspace: (workspaceId: WorkspaceId) => void
  /** 回到欢迎页重新选择目录。 */
  onOpenFolder: () => void
  sidebarCollapsed: boolean
  sidebarWidth: number
  assistantOpen: boolean
  assistantPanelId: string
  toggleAssistant: () => void
  closePage: () => void
  t: PropsLocale<typeof NS>['t']
}

function segmentsOf(path: string): string[] {
  return path === '' ? [] : path.split('/')
}

/** 分组内的标签按 store 顺序取出文档快照。 */
function documentsOf(view: IdeWorkspaceView, pane: IdePaneState): IdeDocument[] {
  return pane.paths
    .map(path => view.documents[path])
    .filter((document): document is IdeDocument => document !== undefined)
}

/** 工作区 IDE 内容；请求生命周期与保存冲突都留在当前页面实例内。 */
export function IdeWorkspace({
  workspace, workspaces, fileSessionId, view, actions, workspaceFiles, onSwitchWorkspace, onOpenFolder,
  sidebarCollapsed, sidebarWidth, assistantOpen, assistantPanelId, toggleAssistant, closePage, t,
}: IdeWorkspaceProps) {
  const workspaceId = workspace.workspaceId
  const activePane = focusedPane(view)
  const active = activePane.activePath === null ? undefined : view.documents[activePane.activePath]
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [closePending, setClosePending] = useState<string | null>(null)
  const [reloadPending, setReloadPending] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragging, setDragging] = useState<{ paneId: string; path: string } | null>(null)
  const [dropHint, setDropHint] = useState<{ paneId: string; side: IdeSplitSide } | null>(null)
  const alive = useRef(true)
  const heading = useRef<HTMLHeadingElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const directoryRequests = useRef(new Map<string, AbortController>())
  const fileRequests = useRef(new Map<string, AbortController>())

  useEffect(() => {
    alive.current = true
    heading.current?.focus({ preventScroll: true })
    return () => { alive.current = false }
  }, [])

  const loadDirectory = useCallback(async (path: string): Promise<void> => {
    directoryRequests.current.get(path)?.abort()
    const controller = new AbortController()
    directoryRequests.current.set(path, controller)
    actions.setDirectory(workspaceId, path, 'loading')
    try {
      const payload = await workspaceFiles.list(fileSessionId, segmentsOf(path), controller.signal)
      if (controller.signal.aborted) return
      actions.setDirectory(workspaceId, path, 'ready', payload.entries, payload.truncated)
    } catch {
      if (!controller.signal.aborted) actions.setDirectory(workspaceId, path, 'error')
    } finally {
      if (directoryRequests.current.get(path) === controller) directoryRequests.current.delete(path)
    }
  }, [actions, fileSessionId, workspaceId, workspaceFiles])

  const readDocument = useCallback(async (ref: DocumentRef): Promise<void> => {
    fileRequests.current.get(ref.path)?.abort()
    const controller = new AbortController()
    fileRequests.current.set(ref.path, controller)
    try {
      const payload = await workspaceFiles.read(fileSessionId, ref.segments, controller.signal)
      if (controller.signal.aborted) return
      if (payload.content.kind === 'image' || payload.content.kind === 'unsupported') {
        const tooLarge = payload.content.kind === 'unsupported' && payload.content.reason === 'too-large'
        actions.failTab(workspaceId, ref.path, tooLarge ? 'too-large' : 'unsupported', 'unsupported')
        return
      }
      actions.readyTab(workspaceId, ref.path, payload.content.text, payload.version)
    } catch {
      if (!controller.signal.aborted) actions.failTab(workspaceId, ref.path, 'load')
    } finally {
      if (fileRequests.current.get(ref.path) === controller) fileRequests.current.delete(ref.path)
    }
  }, [actions, fileSessionId, workspaceId, workspaceFiles])

  // 进入工作区（含切回）时补齐未加载的目录与正文：切换瞬间被中断的读取在这里重来。
  useEffect(() => {
    if (viewRef.current.directories['']?.status !== 'ready') void loadDirectory('')
    for (const document of Object.values(viewRef.current.documents)) {
      if (document.status === 'loading') void readDocument(document)
    }
    const directories = directoryRequests.current
    const files = fileRequests.current
    return () => {
      for (const controller of directories.values()) controller.abort()
      for (const controller of files.values()) controller.abort()
      directories.clear()
      files.clear()
    }
  }, [loadDirectory, readDocument])

  const openFile = (path: string, name: string, segments: readonly string[]): void => {
    const existing = view.documents[path]
    actions.openTab(workspaceId, path, name, segments)
    if (existing === undefined) void readDocument({ path, name, segments })
  }

  const toggleDirectory = (path: string): void => {
    const opening = !view.expanded.includes(path)
    actions.toggleExpanded(workspaceId, path)
    if (opening && view.directories[path]?.status !== 'ready') void loadDirectory(path)
  }

  const reloadDocument = useCallback((ref: DocumentRef): Promise<void> => {
    actions.reloadTab(workspaceId, ref.path, ref.name, ref.segments)
    return readDocument(ref)
  }, [actions, readDocument, workspaceId])

  const saveDocument = useCallback(async (document: IdeDocument): Promise<boolean> => {
    if (!document.dirty) return true
    /* v8 ignore next -- dirty 只会在成功读取后产生，ready 与 version 是同一状态不变量。 */
    if (document.status !== 'ready' || document.version === '') return true
    if (savingPath !== null) return false
    setSavingPath(document.path)
    const content = document.content
    try {
      const result = await workspaceFiles.save(fileSessionId, document.segments, document.version, content)
      if (result.ok) {
        actions.savedTab(workspaceId, document.path, result.value.version, content)
        return true
      }
      actions.failTab(workspaceId, document.path, result.error.status === 409 ? 'conflict' : 'save', 'ready')
      return false
    } catch {
      actions.failTab(workspaceId, document.path, 'save', 'ready')
      return false
    } finally {
      if (alive.current) setSavingPath(null)
    }
  }, [actions, fileSessionId, savingPath, workspaceId, workspaceFiles])

  const leavePage = useCallback(async (): Promise<void> => {
    if (active !== undefined && !await saveDocument(active)) return
    closePage()
  }, [active, closePage, saveDocument])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      if (event.key === 'Escape') void leavePage()
    }
    const onBlur = (): void => { if (active !== undefined) void saveDocument(active) }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!Object.values(view.documents).some(document => document.dirty)) return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [active, leavePage, saveDocument, view.documents])

  const requestClose = (path: string): void => {
    if (view.documents[path]?.dirty === true) setClosePending(path)
    else actions.closeTab(workspaceId, path)
  }

  const retryActive = (document: IdeDocument): void => {
    if (document.error === 'save') void saveDocument(document)
    else void reloadDocument(document)
  }

  const dropOnBody = (event: DragEvent<HTMLDivElement>, paneId: string): void => {
    if (dragging === null) return
    event.preventDefault()
    event.stopPropagation()
    // 落点以指针位置为准（提示只是预览），因此没有提示时同样能拆分。
    const side = dropSideOf(event.currentTarget.getBoundingClientRect(), event.clientX)
    actions.splitTab(workspaceId, dragging.path, paneId, side)
    setDragging(null)
    setDropHint(null)
  }

  const dropOnTabs = (event: DragEvent<HTMLDivElement>, paneId: string): void => {
    if (dragging === null) return
    event.preventDefault()
    event.stopPropagation()
    actions.moveTab(workspaceId, dragging.path, paneId)
    setDragging(null)
    setDropHint(null)
  }

  const closeTab = view.documents[closePending ?? '']
  const reloadTab = view.documents[reloadPending ?? '']
  const saveState = active === undefined ? undefined
    : savingPath === active.path ? t('saving')
      : active.dirty ? t('unsaved') : t('saved')
  const pageStyle = useMemo(() => ({ '--page-sidebar-width': `${sidebarWidth}px` }) as CSSProperties, [sidebarWidth])
  const menuEntries: MenuEntry[] = [
    { type: 'label', id: 'recent', text: t('recent') },
    ...[...workspaces]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 8)
      .map(item => ({ id: item.workspaceId, label: item.title })),
    { type: 'separator', id: 'divider' },
    { id: 'folder', label: t('openOtherFolder'), icon: <IconFolderOpenOutline16 size={16} /> },
  ]

  return <main className={css.page} style={pageStyle} aria-label={t('title')}>
    <IdeFileTree title={workspace.title} collapsed={sidebarCollapsed} width={sidebarWidth}
      directories={view.directories} expanded={view.expanded} activePath={activePane.activePath}
      onToggle={toggleDirectory} onOpen={openFile} onRetry={() => { void loadDirectory('') }} t={t} />
    <section className={css.work} aria-label={t('editor')}>
      <header className={css.header}>
        <span className={css.headerIcon} aria-hidden="true"><IconCodeOutline16 size={18} /></span>
        <h1 ref={heading} tabIndex={-1} className={css.title} title={workspace.title}>{workspace.title}</h1>
        <Menu open={menuOpen} portal keyboardNavigation
          anchor={<Button size="sm" variant="outline" aria-haspopup="menu" aria-expanded={menuOpen}
            aria-label={t('switchWorkspace')} title={t('switchWorkspace')}
            onClick={() => { setMenuOpen(true) }}>
            <span className={css.switcherLabel}>{t('switchWorkspace')}</span>
          </Button>}
          items={menuEntries}
          selectedId={workspaceId}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'folder') onOpenFolder()
            else if (id !== workspaceId) onSwitchWorkspace(id as WorkspaceId)
          }}
          onClose={() => { setMenuOpen(false) }} />
        {saveState !== undefined && <span className={css.saveState} data-dirty={active?.dirty === true ? '' : undefined} role="status">
          {active?.dirty !== true && <IconCheckOutline14 size={14} />}{saveState}
        </span>}
        <div className={css.actions}>
          <Button size="sm" variant="outline" disabled={active === undefined}
            aria-label={t('split')} title={t('splitHint')}
            /* v8 ignore next -- 没有活动文件时按钮是 disabled，点击不可达。 */
            onClick={active === undefined ? undefined : () => {
              actions.splitTab(workspaceId, active.path, activePane.id, 'right', 'copy')
            }}>
            {t('split')}
          </Button>
          <Button size="sm" variant="outline" disabled={active?.dirty !== true || savingPath !== null}
            aria-label={t('save')} title={t('saveShortcut')}
            onClick={active === undefined ? undefined : () => { void saveDocument(active) }}>
            {t('save')}
          </Button>
          <Button size="sm" className={css.assistant} icon={<IconSparkle16 />}
            aria-label={t('assistant')} title={t('assistant')} aria-expanded={assistantOpen}
            aria-controls={assistantPanelId} onClick={toggleAssistant}>
            <span className={css.assistantLabel}>{t('assistant')}</span>
          </Button>
        </div>
      </header>
      <div className={css.panes} data-split={view.panes.length > 1 ? '' : undefined}>
        {view.panes.map((pane, index) => {
          const tabDocuments = documentsOf(view, pane)
          const document = pane.activePath === null ? undefined : view.documents[pane.activePath]
          return <section key={pane.id} className={css.pane} data-active={pane.id === activePane.id ? '' : undefined}
            aria-label={t('paneLabel', { index: index + 1 })}
            onFocusCapture={() => { actions.focusPane(workspaceId, pane.id) }}
            onPointerDownCapture={() => { actions.focusPane(workspaceId, pane.id) }}>
            <div className={css.paneTabs}
              onDragOver={(event) => { if (dragging !== null) event.preventDefault() }}
              onDrop={(event) => { dropOnTabs(event, pane.id) }}>
              <IdeTabs tabs={tabDocuments} activePath={pane.activePath} paneId={pane.id}
                onActivate={(paneId, path) => { actions.activateTab(workspaceId, paneId, path) }}
                onClose={requestClose}
                onDragStart={(paneId, path) => { setDragging({ paneId, path }); setDropHint(null) }}
                onDragEnd={() => { setDragging(null); setDropHint(null) }} t={t} />
              {view.panes.length > 1 && <button type="button" className={css.closePane}
                aria-label={t('closePane', { index: index + 1 })} title={t('closePane', { index: index + 1 })}
                onClick={() => { actions.closePane(workspaceId, pane.id) }}>×</button>}
            </div>
            <div className={css.paneBody} data-pane-body={pane.id}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                setDropHint({ paneId: pane.id, side: dropSideOf(event.currentTarget.getBoundingClientRect(), event.clientX) })
              }}
              onDragLeave={() => { setDropHint(current => (current?.paneId === pane.id ? null : current)) }}
              onDrop={(event) => { dropOnBody(event, pane.id) }}>
              {document === undefined ? <div className={css.empty}>
                <span className={css.emptyIcon} aria-hidden="true"><IconCodeOutline16 size={30} /></span>
                <h2>{t('workspaceHeadline')}</h2>
                <p>{t('workspaceDescription')}</p>
              </div> : <IdeEditor key={`${pane.id}:${document.path}`} document={document} paneId={pane.id} t={t}
                onChange={(content) => { actions.updateTab(workspaceId, document.path, content) }}
                onSave={() => { void saveDocument(document) }}
                onReload={() => { setReloadPending(document.path) }}
                onRetry={() => { retryActive(document) }} />}
              {dragging !== null && dropHint?.paneId === pane.id && <span className={css.dropHint}
                data-side={dropHint.side} role="presentation">
                {t(dropHint.side === 'left' ? 'dropLeft' : 'dropRight')}
              </span>}
            </div>
          </section>
        })}
      </div>
    </section>
    {closeTab !== undefined && <Modal open title={t('discardTitle')} closeLabel={t('close')} trapFocus
      description={t('discardDescription', { name: closeTab.name })} onClose={() => { setClosePending(null) }}
      footer={<>
        <Button variant="outline" onClick={() => { setClosePending(null) }}>{t('cancel')}</Button>
        <Button onClick={() => { actions.closeTab(workspaceId, closeTab.path); setClosePending(null) }}>{t('discard')}</Button>
      </>} />}
    {reloadTab !== undefined && <Modal open title={t('reloadTitle')} closeLabel={t('close')} trapFocus
      description={t('reloadDescription', { name: reloadTab.name })} onClose={() => { setReloadPending(null) }}
      footer={<>
        <Button variant="outline" onClick={() => { setReloadPending(null) }}>{t('cancel')}</Button>
        <Button onClick={() => { void reloadDocument(reloadTab); setReloadPending(null) }}>{t('reload')}</Button>
      </>} />}
  </main>
}
