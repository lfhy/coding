/** 打开工作区后的 IDE 三栏宿主：文件树、标签编辑区与共享页面助手。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Button, IconCheckOutline14, IconCodeOutline16, IconSparkle16, Modal,
} from 'coding-client-ui-primitives'
import type { PropsLocale, PropsStore } from 'coding-client-ui-slots'
import type { SessionId, WorkspaceView } from 'coding-client-runtime/client'
import type { WorkspaceFilesService } from 'coding-client-ui-open-in-app/client'
import { IdeEditor } from './IdeEditor.tsx'
import { IdeFileTree } from './IdeFileTree.tsx'
import { IdeTabs } from './IdeTabs.tsx'
import { createIdeWorkspaceStore, type IdeDocument } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdeWorkspace.module.css'

type IdeStoreProps = PropsStore<ReturnType<typeof createIdeWorkspaceStore>>
type DocumentRef = Pick<IdeDocument, 'path' | 'name' | 'segments'>

interface IdeWorkspaceProps extends IdeStoreProps {
  workspace: WorkspaceView
  sessionId: SessionId
  sidebarCollapsed: boolean
  sidebarWidth: number
  assistantOpen: boolean
  assistantPanelId: string
  toggleAssistant: () => void
  closePage: () => void
  workspaceFiles: WorkspaceFilesService
  t: PropsLocale<typeof NS>['t']
}

function segmentsOf(path: string): string[] {
  return path === '' ? [] : path.split('/')
}

/** 工作区 IDE 内容；请求生命周期与保存冲突都留在当前页面实例内。 */
export function IdeWorkspace({
  workspace, sessionId, sidebarCollapsed, sidebarWidth, assistantOpen, assistantPanelId,
  toggleAssistant, closePage, workspaceFiles, useStore, actions, t,
}: IdeWorkspaceProps) {
  const directories = useStore(state => state.directories)
  const expanded = useStore(state => state.expanded)
  const tabs = useStore(state => state.tabs)
  const activePath = useStore(state => state.activePath)
  const active = tabs.find(tab => tab.path === activePath)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [closePending, setClosePending] = useState<string | null>(null)
  const [reloadPending, setReloadPending] = useState<string | null>(null)
  const alive = useRef(true)
  const heading = useRef<HTMLHeadingElement>(null)
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
    actions.setDirectory(path, 'loading')
    try {
      const payload = await workspaceFiles.list(sessionId, segmentsOf(path), controller.signal)
      if (controller.signal.aborted) return
      actions.setDirectory(path, 'ready', payload.entries, payload.truncated)
    } catch {
      if (!controller.signal.aborted) actions.setDirectory(path, 'error')
    } finally {
      if (directoryRequests.current.get(path) === controller) directoryRequests.current.delete(path)
    }
  }, [actions, sessionId, workspaceFiles])

  useEffect(() => {
    void loadDirectory('')
    return () => {
      for (const controller of directoryRequests.current.values()) controller.abort()
      for (const controller of fileRequests.current.values()) controller.abort()
      directoryRequests.current.clear()
      fileRequests.current.clear()
    }
  }, [loadDirectory])

  const readDocument = useCallback(async (ref: DocumentRef): Promise<void> => {
    fileRequests.current.get(ref.path)?.abort()
    const controller = new AbortController()
    fileRequests.current.set(ref.path, controller)
    try {
      const payload = await workspaceFiles.read(sessionId, ref.segments, controller.signal)
      if (controller.signal.aborted) return
      if (payload.content.kind === 'image' || payload.content.kind === 'unsupported') {
        const tooLarge = payload.content.kind === 'unsupported' && payload.content.reason === 'too-large'
        actions.failTab(ref.path, tooLarge ? 'too-large' : 'unsupported', 'unsupported')
        return
      }
      actions.readyTab(ref.path, payload.content.text, payload.version)
    } catch {
      if (!controller.signal.aborted) actions.failTab(ref.path, 'load')
    } finally {
      if (fileRequests.current.get(ref.path) === controller) fileRequests.current.delete(ref.path)
    }
  }, [actions, sessionId, workspaceFiles])

  const openFile = (path: string, name: string, segments: readonly string[]): void => {
    if (tabs.some(tab => tab.path === path)) {
      actions.activateTab(path)
      return
    }
    actions.openTab(path, name, segments)
    void readDocument({ path, name, segments })
  }

  const toggleDirectory = (path: string): void => {
    const opening = !expanded.includes(path)
    actions.toggleExpanded(path)
    if (opening && directories[path]?.status !== 'ready') void loadDirectory(path)
  }

  const reloadDocument = useCallback((ref: DocumentRef): Promise<void> => {
    actions.reloadTab(ref.path, ref.name, ref.segments)
    return readDocument(ref)
  }, [actions, readDocument])

  const saveDocument = useCallback(async (document: IdeDocument): Promise<boolean> => {
    if (!document.dirty) return true
    /* v8 ignore next -- dirty 只会在成功读取后产生，ready 与 version 是同一状态不变量。 */
    if (document.status !== 'ready' || document.version === '') return true
    if (savingPath !== null) return false
    setSavingPath(document.path)
    const content = document.content
    try {
      const result = await workspaceFiles.save(sessionId, document.segments, document.version, content)
      if (result.ok) {
        actions.savedTab(document.path, result.value.version, content)
        return true
      }
      actions.failTab(document.path, result.error.status === 409 ? 'conflict' : 'save', 'ready')
      return false
    } catch {
      actions.failTab(document.path, 'save', 'ready')
      return false
    } finally {
      if (alive.current) setSavingPath(null)
    }
  }, [actions, savingPath, sessionId, workspaceFiles])

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
      if (!tabs.some(tab => tab.dirty)) return
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
  }, [active, leavePage, saveDocument, tabs])

  const requestClose = (path: string): void => {
    if (tabs.find(tab => tab.path === path)?.dirty === true) setClosePending(path)
    else actions.closeTab(path)
  }

  const requestReload = (document: IdeDocument): void => { setReloadPending(document.path) }

  const retryActive = (document: IdeDocument): void => {
    if (document.error === 'save') void saveDocument(document)
    else void reloadDocument(document)
  }

  const closeTab = tabs.find(tab => tab.path === closePending)
  const reloadTab = tabs.find(tab => tab.path === reloadPending)
  const saveState = active === undefined ? undefined
    : savingPath === active.path ? t('saving')
      : active.dirty ? t('unsaved') : t('saved')
  const pageStyle = useMemo(() => ({ '--page-sidebar-width': `${sidebarWidth}px` }) as CSSProperties, [sidebarWidth])

  return <main className={css.page} style={pageStyle} aria-label={t('title')}>
    <IdeFileTree title={workspace.title} collapsed={sidebarCollapsed} width={sidebarWidth}
      directories={directories} expanded={expanded} activePath={activePath}
      onToggle={toggleDirectory} onOpen={openFile} onRetry={() => { void loadDirectory('') }} t={t} />
    <section className={css.work} aria-label={t('editor')}>
      <header className={css.header}>
        <span className={css.headerIcon} aria-hidden="true"><IconCodeOutline16 size={18} /></span>
        <h1 ref={heading} tabIndex={-1} className={css.title} title={workspace.title}>{workspace.title}</h1>
        {saveState !== undefined && <span className={css.saveState} data-dirty={active?.dirty === true ? '' : undefined} role="status">
          {active?.dirty !== true && <IconCheckOutline14 size={14} />}{saveState}
        </span>}
        <div className={css.actions}>
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
      {tabs.length > 0 && <IdeTabs tabs={tabs} activePath={activePath}
        onActivate={actions.activateTab} onClose={requestClose} t={t} />}
      {active === undefined ? <div className={css.empty}>
        <span className={css.emptyIcon} aria-hidden="true"><IconCodeOutline16 size={30} /></span>
        <h2>{t('workspaceHeadline')}</h2>
        <p>{t('workspaceDescription')}</p>
      </div> : <IdeEditor key={active.path} document={active} t={t}
        onChange={(content) => { actions.updateTab(active.path, content) }}
        onSave={() => { void saveDocument(active) }} onReload={() => { requestReload(active) }}
        onRetry={() => { retryActive(active) }} />}
    </section>
    {closeTab !== undefined && <Modal open title={t('discardTitle')} closeLabel={t('close')} trapFocus
      description={t('discardDescription', { name: closeTab.name })} onClose={() => { setClosePending(null) }}
      footer={<>
        <Button variant="outline" onClick={() => { setClosePending(null) }}>{t('cancel')}</Button>
        <Button onClick={() => { actions.closeTab(closeTab.path); setClosePending(null) }}>{t('discard')}</Button>
      </>} />}
    {reloadTab !== undefined && <Modal open title={t('reloadTitle')} closeLabel={t('close')} trapFocus
      description={t('reloadDescription', { name: reloadTab.name })} onClose={() => { setReloadPending(null) }}
      footer={<>
        <Button variant="outline" onClick={() => { setReloadPending(null) }}>{t('cancel')}</Button>
        <Button onClick={() => { void reloadDocument(reloadTab); setReloadPending(null) }}>{t('reload')}</Button>
      </>} />}
  </main>
}
