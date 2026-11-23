/** 仅真实工作区的分组树；保留原有折叠、行操作与 Host／本地拖拽台账。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionId, WorkspaceId, WorkspaceView } from 'coding-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { SessionNode } from './tree.ts'
import type { SessionOrderBy } from './stores.ts'
import { deriveGroups } from './tree.ts'
import { ProjectRowItem, SessionNodeItem } from './rows/Rows.tsx'
import { nextSessionOrderAccount, reconciledSessionOrder, useNativeDragAcceptance } from './session-order.ts'
import css from './WorkspaceBrowser.module.css'

const COLLAPSED_SESSION_LIMIT = 5

interface DragState {
  accountKey: string
  sessionId: SessionId
  over: { id: SessionId; half: 'before' | 'after' } | null
}

interface WorkspaceDragState {
  workspaceId: WorkspaceId
  over: { id: WorkspaceId; half: 'before' | 'after' } | null
}

/** 工作区的投放上下半区由整个展开分组计算，而不只看标题行。 */
function workspaceGroupHalf(event: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

type SessionTreeProps = Pick<WorkspaceBrowserProps,
  'useSessions' | 'startSession' | 'open' | 'forkSession' | 'conversationVisible'
  | 'insertWorkspaceBefore' | 'insertSessionBefore' | 't'
> & {
  home?: string | undefined
  workspaces: readonly WorkspaceView[]
  groupExpansion: Readonly<Record<string, boolean>>
  setGroupExpanded: WorkspaceBrowserProps['actions']['setGroupExpanded']
  sessionOrderByAccount: Readonly<Record<string, readonly string[]>>
  sessionUpdatedAtByAccount: Readonly<Record<string, Readonly<Record<string, number>>>>
  syncSessionOrderAccount: WorkspaceBrowserProps['actions']['syncSessionOrderAccount']
  setSessionOrder: WorkspaceBrowserProps['actions']['setSessionOrder']
  archivedSessionIds: readonly SessionId[]
  onRenameRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
  onDeleteRequest: (workspaceId: WorkspaceId, currentTitle: string) => void
  onSessionRename: (sessionId: SessionId, currentTitle: string) => void
  onSessionArchive: (sessionId: SessionId) => void
  orderBy: SessionOrderBy
}

/**
 * 保留已持久化工作区展开状态与会话顺序，不在工作视图创建未分组伪项目。
 * @param props - 真实工作区、现有浏览偏好与 Host 行操作。
 * @returns 仅列表区域滚动的分组树。
 */
export function SessionTree({
  useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, conversationVisible,
  onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive,
  insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded,
  sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t,
}: SessionTreeProps) {
  const list = useSessions(state => state)
  const current = list.current
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<string[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  const workspaceDropCommitted = useRef(false)
  const previousOrderBy = useRef(orderBy)
  useNativeDragAcceptance(drag !== null || workspaceDrag !== null)
  const currentGroup = current === undefined
    ? undefined
    : workspaces.find(workspace => workspace.sessionIds.includes(current))?.workspaceId
  useEffect(() => {
    if (currentGroup === undefined || Object.hasOwn(groupExpansion, currentGroup)) return
    setGroupExpanded(currentGroup, true)
  }, [currentGroup, setGroupExpanded, groupExpansion])
  const expandedGroups = useMemo(
    () => Object.entries(groupExpansion).filter(([, expanded]) => expanded).map(([key]) => key),
    [groupExpansion],
  )
  useEffect(() => {
    if (list.phase !== 'ready') return
    const switchedToUpdated = previousOrderBy.current !== 'updated' && orderBy === 'updated'
    previousOrderBy.current = orderBy
    for (const workspace of workspaces) {
      const key = workspace.workspaceId
      const sessionIds = workspace.sessionIds.filter(id => list.byId[id] !== undefined)
      const previousOrder = sessionOrderByAccount[key]
      const next = nextSessionOrderAccount({
        sessionIds, previousOrder, previousUpdatedAt: sessionUpdatedAtByAccount[key] ?? {}, list, orderBy,
        sortByRecency: orderBy === 'updated' && (previousOrder === undefined || switchedToUpdated),
      })
      if (next.changed) syncSessionOrderAccount(key, next.order, next.updatedAt)
    }
  }, [list, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, workspaces])
  const orderedWorkspaces = useMemo(() => workspaces.map(workspace => ({
    ...workspace,
    sessionIds: reconciledSessionOrder(workspace.sessionIds, sessionOrderByAccount[workspace.workspaceId]),
  })), [sessionOrderByAccount, workspaces])
  const groups = useMemo(
    () => deriveGroups(list, orderedWorkspaces, archivedSessionIds, { expandedGroups }),
    [list, orderedWorkspaces, archivedSessionIds, expandedGroups],
  )
  const now = Date.now()
  const commitSessionDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setDrag(null)
    const group = groups.find(candidate => candidate.key === activeDrag.accountKey)
    if (group === undefined) return
    const targetIndex = group.sessions.findIndex(session => session.id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : group.sessions[targetIndex + 1]?.id
    if (anchor === activeDrag.sessionId) return
    const sourceIndex = group.sessions.findIndex(session => session.id === activeDrag.sessionId)
    const anchorIndex = anchor === undefined
      ? group.sessions.length
      : group.sessions.findIndex(session => session.id === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const accountSessionIds = orderedWorkspaces.find(workspace => workspace.workspaceId === activeDrag.accountKey)?.sessionIds
    if (accountSessionIds === undefined) return
    const nextOrder = accountSessionIds.filter(id => id !== activeDrag.sessionId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    setSessionOrder(activeDrag.accountKey, nextOrder)
    if (orderBy === 'updated') return
    insertSessionBefore(activeDrag.accountKey as WorkspaceId, activeDrag.sessionId, anchor).catch((reason: unknown) => {
      console.warn('session reorder rejected:', reason)
    })
  }
  const commitWorkspaceDrag = (activeDrag: WorkspaceDragState, over: NonNullable<WorkspaceDragState['over']>): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    const rowIndex = workspaces.findIndex(workspace => workspace.workspaceId === over.id)
    if (rowIndex === -1) return
    const anchor = over.half === 'before' ? over.id : workspaces[rowIndex + 1]?.workspaceId
    if (anchor === activeDrag.workspaceId) return
    const sourceIndex = workspaces.findIndex(workspace => workspace.workspaceId === activeDrag.workspaceId)
    const anchorIndex = anchor === undefined
      ? workspaces.length
      : workspaces.findIndex(workspace => workspace.workspaceId === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    insertWorkspaceBefore(activeDrag.workspaceId, anchor).catch((reason: unknown) => {
      console.warn('workspace reorder rejected:', reason)
    })
  }
  const workspaceDropAtListStart = groups[0]?.workspaceId !== undefined
    && workspaceDrag?.over?.id === groups[0].workspaceId
    && workspaceDrag.over.half === 'before'

  return (
    <div className={clsx(css.treeBody, css.wide)}>
      {workspaceDropAtListStart && <span className={css.listTopDropIndicator} aria-hidden="true" />}
      <div className={clsx(css.list, workspaceDropAtListStart && css.listTopDropActive)} role="tree" aria-label={t('section.sessions')}>
        {groups.length === 0 && <div className={css.empty}>{t('empty.none')}</div>}
        {groups.map((group) => {
          const workspaceId = group.workspaceId
          const workspaceMarker = workspaceId !== undefined && workspaceDrag?.over?.id === workspaceId
            ? workspaceDrag.over.half : null
          const hoverWorkspace = (half: 'before' | 'after'): void => {
            if (workspaceId === undefined) return
            setWorkspaceDrag(active => active === null ? active : { ...active, over: { id: workspaceId, half } })
          }
          const dropWorkspace = (half: 'before' | 'after'): void => {
            if (workspaceDrag !== null && workspaceId !== undefined) commitWorkspaceDrag(workspaceDrag, { id: workspaceId, half })
          }
          return (
            <div key={group.key} className={clsx(css.groupSection,
              workspaceMarker === 'before' && css.workspaceDropBefore,
              workspaceMarker === 'after' && css.workspaceDropAfter,
            )}
            onDragOver={workspaceDrag === null ? undefined : (event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              hoverWorkspace(workspaceGroupHalf(event))
            }}
            onDrop={workspaceDrag === null ? undefined : (event) => {
              event.preventDefault()
              dropWorkspace(workspaceGroupHalf(event))
            }}>
              <ProjectRowItem group={group} home={home} t={t}
                onToggle={() => {
                  if (group.expanded) setExpandedSessionGroups(keys => keys.filter(key => key !== group.key))
                  setGroupExpanded(group.key, !group.expanded)
                }}
                onCreate={() => {
                  if (workspaceId === undefined) return
                  setGroupExpanded(group.key, true)
                  startSession(workspaceId)
                }}
                drag={workspaceId === undefined ? undefined : {
                  start: () => {
                    workspaceDropCommitted.current = false
                    setWorkspaceDrag({ workspaceId, over: null })
                  },
                  end: () => {
                    if (workspaceDrag?.over !== null && workspaceDrag?.over !== undefined) {
                      commitWorkspaceDrag(workspaceDrag, workspaceDrag.over)
                    } else setWorkspaceDrag(null)
                    workspaceDropCommitted.current = false
                  },
                }}
                actions={workspaceId === undefined ? undefined : {
                  rename: () => { onRenameRequest(workspaceId, group.label) },
                  delete: () => { onDeleteRequest(workspaceId, group.label) },
                }}
              />
              {(expandedSessionGroups.includes(group.key) ? group.sessions : group.sessions.slice(0, COLLAPSED_SESSION_LIMIT))
                .map((node: SessionNode) => {
                  const sameGroupDrag = drag !== null && drag.accountKey === group.key
                  return (
                    <SessionNodeItem key={node.id} node={node} currentId={conversationVisible ? current : undefined}
                      now={now} onOpen={open} onRename={onSessionRename} onFork={forkSession} onArchive={onSessionArchive} t={t}
                      drag={{
                        start: () => {
                          sessionDropCommitted.current = false
                          setDrag({ accountKey: group.key, sessionId: node.id, over: null })
                        },
                        active: sameGroupDrag,
                        marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
                        hover: (half) => {
                          setDrag(active => active === null ? active : { ...active, over: { id: node.id, half } })
                        },
                        drop: (half) => {
                          if (drag !== null) commitSessionDrag(drag, { id: node.id, half })
                        },
                        end: () => {
                          if (drag?.over !== null && drag?.over !== undefined) commitSessionDrag(drag, drag.over)
                          else setDrag(null)
                          sessionDropCommitted.current = false
                        },
                      }}
                    />
                  )
                })}
              {group.sessions.length > COLLAPSED_SESSION_LIMIT && (
                <button type="button" className={css.sessionOverflowButton} aria-expanded={expandedSessionGroups.includes(group.key)}
                  onClick={() => { setExpandedSessionGroups(keys => keys.includes(group.key)
                    ? keys.filter(key => key !== group.key) : [...keys, group.key]) }}>
                  {expandedSessionGroups.includes(group.key) ? t('sessions.collapse')
                    : t('sessions.expand', { n: group.sessions.length - COLLAPSED_SESSION_LIMIT })}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <span className={css.fade} />
    </div>
  )
}
