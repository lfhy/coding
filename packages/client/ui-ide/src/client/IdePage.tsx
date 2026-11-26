/**
 * 代码工作区的页面根：固定从欢迎页开始，选中工作区后进入三栏编辑器。
 *
 * 页面只读取本包自己的状态：会话 id 用于向 Host 读写文件，欢迎页与三栏的切换由
 * `workspaceId` 决定。对话页当前会话只作为外壳的承载会话，不决定这里显示什么。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconChevronRightOutline14, IconCloudOutline16, IconCodeOutline16,
  IconFolderClose16, IconFolderOpenOutline16, Toast,
} from 'coding-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from 'coding-client-ui-slots'
import {
  isRemoteWorkspacePath, remoteWorkspaceDisplayPath,
  type WorkspaceId, type WorkspaceView,
} from 'coding-client-runtime/client'
import type { WorkspaceFilesService } from 'coding-client-ui-open-in-app/client'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { IdeWorkspace } from './IdeWorkspace.tsx'
import type { IdeActionsBaked, IdeState } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdePage.module.css'

/** 页面可用能力：状态源、写入动作与文件工作区服务。 */
export interface IdePageFace {
  hooks: { ideState: HostObservable<IdeState> }
  actions: IdeActionsBaked
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** 进入工作区：绑定会话、记录选择并展开三栏。 */
  openWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** 回到欢迎页，收起右侧助手。 */
  leaveWorkspace: () => void
  workspaceFiles: WorkspaceFilesService
}

export type IdePageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsRenderSlots<'shell.ide.welcome.directoryFlow'> & InjectFace<IdePageFace>

/** 代码工作区欢迎页：选择目录或最近工作区，尚未加载文件与编辑器内容。 */
function IdeWelcome({
  closePage, useWorkspaces, renderSlot, createWorkspace, openWorkspace, t,
}: IdePageProps) {
  const items = useWorkspaces(state => state.items)
  const phase = useWorkspaces(state => state.phase)
  const listState = useWorkspaces(state => state.state)
  const recent = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6),
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

  /** 把短暂失败统一交给共享 Toast；成功后页面通常已切换形态。 */
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

/** 页面根：欢迎页与三栏由本包自己的选择驱动，与对话页当前会话无关。 */
export function IdePage(props: IdePageProps) {
  const { useIdeState, actions } = props
  const items = props.useWorkspaces(state => state.items)
  const openWorkspace = props.openWorkspace
  const workspaceId = useIdeState(state => state.workspaceId)
  const views = useIdeState(state => state.views)
  const sessions = useIdeState(state => state.sessions)
  const live = workspaceId === null ? undefined : items.find(item => item.workspaceId === workspaceId)
  const view = workspaceId === null ? undefined : views[workspaceId]
  const fileSessionId = workspaceId === null ? undefined : sessions[workspaceId]
  // 绑定会话已被移除（例如在别处归档）或工作区已不存在时回到欢迎页；
  // 再次选择会经 openWorkspace 重新建一个会话，页面状态按工作区原样保留。
  if (live === undefined || view === undefined || fileSessionId === undefined) {
    return <IdeWelcome {...props} />
  }
  return <IdeWorkspace workspace={live} workspaces={items} fileSessionId={fileSessionId}
    view={view} actions={actions} workspaceFiles={props.workspaceFiles}
    onSwitchWorkspace={(next) => { void openWorkspace(next).catch(() => {}) }}
    onOpenFolder={props.leaveWorkspace}
    sidebarCollapsed={props.sidebarCollapsed} sidebarWidth={props.sidebarWidth}
    assistantOpen={props.assistantOpen} assistantPanelId={props.assistantPanelId}
    toggleAssistant={props.toggleAssistant} closePage={props.closePage} t={props.t} />
}
