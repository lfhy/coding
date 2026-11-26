import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconChevronRightOutline14, IconCloudOutline16, IconCodeOutline16,
  IconFolderClose16, IconFolderOpenOutline16, Toast,
} from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import {
  isRemoteWorkspacePath, remoteWorkspaceDisplayPath,
  type WorkspaceId, type WorkspaceView,
} from 'coding-client-runtime/client'
import type { WorkspaceFilesService } from 'coding-client-ui-open-in-app/client'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { IdeWorkspace } from './IdeWorkspace.tsx'
import { createIdeWorkspaceStore } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdePage.module.css'

export interface IdePageFace {
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  openWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  workspaceFiles: WorkspaceFilesService
}

export type IdePageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsRenderSlots<'shell.ide.welcome.directoryFlow'> & PropsStore<ReturnType<typeof createIdeWorkspaceStore>>
  & InjectFace<IdePageFace>

/** 代码工作区欢迎页：选择目录或最近工作区，尚未加载文件与编辑器内容。 */
function IdeWelcome({
  closePage, useWorkspaces, renderSlot, createWorkspace, openWorkspace, t,
}: IdePageProps) {
  const items = useWorkspaces(state => state.items)
  const phase = useWorkspaces(state => state.phase)
  const listState = useWorkspaces(state => state.state)
  const recent = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5),
    [items],
  )
  const headingRef = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)
  const [flowOpen, setFlowOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)

  useEffect(() => {
    alive.current = true
    headingRef.current?.focus()
    return () => { alive.current = false }
  }, [])

  /** 把短暂失败统一交给共享 Toast；成功后页面通常已关闭。 */
  const notify = (text: string): void => {
    setToast(previous => ({ id: (previous?.id ?? 0) + 1, text }))
  }

  const run = async (action: () => Promise<void>, error: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch {
      if (alive.current) notify(error)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const flow: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy,
    onPicked: (path) => {
      setFlowOpen(false)
      void run(async () => {
        const workspace = await createWorkspace({ path })
        await openWorkspace(workspace.workspaceId)
      }, t('workspaceError'))
    },
    onCancel: () => { setFlowOpen(false) },
    onError: () => {
      setFlowOpen(false)
      notify(t('workspaceError'))
    },
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || flowOpen) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('[role="dialog"], [role="listbox"], [aria-expanded="true"]')) return
      closePage()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [closePage, flowOpen])

  return <div className={css.page}>
    <header className={css.header}>
      <span className={css.headerIcon} aria-hidden="true"><IconCodeOutline16 size={18} /></span>
      <h1 ref={headingRef} tabIndex={-1} className={css.pageTitle}>{t('title')}</h1>
    </header>
    <main className={css.welcome}>
      <div className={css.content}>
        <div className={css.heroIcon} aria-hidden="true"><IconCodeOutline16 size={32} /></div>
        <h2 className={css.headline}>{t('headline')}</h2>
        <p className={css.description}>{t('description')}</p>
        <Button variant="primary" icon={<IconFolderOpenOutline16 size={16} />} disabled={busy}
          onClick={() => { setFlowOpen(true) }}>{t('openFolder')}</Button>
        {phase === 'pending' ? <p className={css.state} role="status">{t('loading')}</p>
          : listState === 'error' ? <p className={css.empty} role="alert">{t('error')}</p>
            : recent.length > 0 ? <>
              <div className={css.recentHeading}><span>{t('recent')}</span><i aria-hidden="true" /></div>
              <ul className={css.recentList}>
                {recent.map((workspace) => {
                  const remote = isRemoteWorkspacePath(workspace.path)
                  const path = remoteWorkspaceDisplayPath(workspace.path) ?? workspace.path
                  return <li key={workspace.workspaceId}>
                    <button type="button" className={css.recentRow} disabled={busy} title={workspace.title}
                      onClick={() => { void run(() => openWorkspace(workspace.workspaceId), t('workspaceError')) }}>
                      <span className={css.rowIcon} aria-hidden="true">
                        {remote ? <IconCloudOutline16 size={18} /> : <IconFolderClose16 size={18} />}
                      </span>
                      <span className={css.rowText}>
                        <span className={css.rowTitle}>{workspace.title}</span>
                        <span className={css.rowPath}>{path}</span>
                      </span>
                      <IconChevronRightOutline14 className={css.chevron} size={14} />
                    </button>
                  </li>
                })}
              </ul>
            </> : <p className={css.empty}>{t('empty')}</p>}
      </div>
    </main>
    {renderSlot('shell.ide.welcome.directoryFlow', flow)}
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </div>
}

/** 按当前会话是否归属工作区，在欢迎页与三栏 IDE 之间路由。 */
export function IdePage(props: IdePageProps) {
  const items = props.useWorkspaces(state => state.items)
  const workspace = useMemo(
    () => items.find(item => item.sessionIds.includes(props.sessionId)),
    [items, props.sessionId],
  )
  if (workspace === undefined) return <IdeWelcome {...props} />
  return <IdeWorkspace workspace={workspace} sessionId={props.sessionId}
    sidebarCollapsed={props.sidebarCollapsed} sidebarWidth={props.sidebarWidth}
    assistantOpen={props.assistantOpen} assistantPanelId={props.assistantPanelId}
    toggleAssistant={props.toggleAssistant} closePage={props.closePage}
    workspaceFiles={props.workspaceFiles} useStore={props.useStore} actions={props.actions} t={props.t} />
}
