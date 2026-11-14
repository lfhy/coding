/** 对话与最近共用的平铺会话列表；最近严格按活动时间排序且不接受拖拽。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionId, WorkspaceView } from 'coding-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { WorkspaceViewMode } from './stores.ts'
import { deriveFlat, UNGROUPED_KEY } from './tree.ts'
import { SessionNodeItem } from './rows/Rows.tsx'
import { nextSessionOrderAccount, reconciledSessionOrder, useNativeDragAcceptance } from './session-order.ts'
import css from './WorkspaceBrowser.module.css'

type FlatListProps = Pick<WorkspaceBrowserProps,
  'useSessions' | 'open' | 'forkSession' | 'conversationVisible' | 't'
> & {
  view: Exclude<WorkspaceViewMode, 'work'>
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  orderBy: 'manual' | 'updated'
  sessionOrderByAccount: Readonly<Record<string, readonly string[]>>
  sessionUpdatedAtByAccount: Readonly<Record<string, Readonly<Record<string, number>>>>
  syncSessionOrderAccount: WorkspaceBrowserProps['actions']['syncSessionOrderAccount']
  setSessionOrder: WorkspaceBrowserProps['actions']['setSessionOrder']
  onSessionRename: (id: SessionId, title: string) => void
  onSessionArchive: (id: SessionId) => void
}

interface DragState {
  sessionId: SessionId
  over: { id: SessionId; half: 'before' | 'after' } | null
}

/**
 * 显示当前视图中的普通会话，复用原有行操作与本地未分组顺序。
 * @param props - 框架列表钩子、视图范围、已有浏览偏好与行操作。
 * @returns 只滚动列表本身的平铺区域。
 */
export function FlatList({
  view, workspaces, useSessions, open, forkSession, onSessionRename, onSessionArchive,
  archivedSessionIds, conversationVisible, orderBy, sessionOrderByAccount,
  sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t,
}: FlatListProps) {
  const list = useSessions(state => state)
  const baseRows = useMemo(
    () => deriveFlat(list, archivedSessionIds, { view, workspaces }),
    [list, archivedSessionIds, view, workspaces],
  )
  const sessionIds = useMemo(() => baseRows.map(row => row.id), [baseRows])
  const previousOrderBy = useRef(orderBy)
  useEffect(() => {
    if (view === 'recent' || list.phase !== 'ready') return
    const previousOrder = sessionOrderByAccount[UNGROUPED_KEY]
    const previousUpdatedAt = sessionUpdatedAtByAccount[UNGROUPED_KEY] ?? {}
    const switchedToUpdated = previousOrderBy.current !== 'updated' && orderBy === 'updated'
    previousOrderBy.current = orderBy
    const next = nextSessionOrderAccount({
      sessionIds, previousOrder, previousUpdatedAt, list, orderBy,
      sortByRecency: orderBy === 'updated' && (previousOrder === undefined || switchedToUpdated),
    })
    if (next.changed) syncSessionOrderAccount(UNGROUPED_KEY, next.order, next.updatedAt)
  }, [list, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, sessionIds, syncSessionOrderAccount, view])
  const rows = useMemo(() => {
    if (view === 'recent') return baseRows
    const byId = new Map(baseRows.map(row => [row.id, row]))
    return reconciledSessionOrder(sessionIds, sessionOrderByAccount[UNGROUPED_KEY])
      .flatMap((id) => {
        const row = byId.get(id)
        return row === undefined ? [] : [row]
      })
  }, [baseRows, sessionOrderByAccount, sessionIds, view])
  const [drag, setDrag] = useState<DragState | null>(null)
  const dropCommitted = useRef(false)
  useNativeDragAcceptance(drag !== null)
  const commitDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (view === 'recent' || dropCommitted.current) return
    dropCommitted.current = true
    setDrag(null)
    const targetIndex = rows.findIndex(row => row.id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : rows[targetIndex + 1]?.id
    if (anchor === activeDrag.sessionId) return
    const sourceIndex = rows.findIndex(row => row.id === activeDrag.sessionId)
    const anchorIndex = anchor === undefined ? rows.length : rows.findIndex(row => row.id === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const nextOrder = rows.map(row => row.id).filter(id => id !== activeDrag.sessionId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    setSessionOrder(UNGROUPED_KEY, nextOrder)
  }
  const now = Date.now()
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={clsx(css.list, css.flatList)} role="tree" aria-label={t('section.sessions')}>
        {rows.length === 0 && <div className={css.empty}>{t('empty.none')}</div>}
        {rows.map(node => (
          <SessionNodeItem
            key={node.id}
            node={node}
            currentId={conversationVisible ? list.current : undefined}
            now={now}
            onOpen={open}
            onRename={onSessionRename}
            onFork={forkSession}
            onArchive={onSessionArchive}
            flat
            drag={view === 'recent' ? undefined : {
              start: () => {
                dropCommitted.current = false
                setDrag({ sessionId: node.id, over: null })
              },
              active: drag !== null,
              marker: drag?.over?.id === node.id ? drag.over.half : null,
              hover: (half) => {
                setDrag(current => current === null ? current : { ...current, over: { id: node.id, half } })
              },
              drop: (half) => {
                if (drag !== null) commitDrag(drag, { id: node.id, half })
              },
              end: () => {
                if (drag?.over !== null && drag?.over !== undefined) commitDrag(drag, drag.over)
                else setDrag(null)
                dropCommitted.current = false
              },
            }}
            t={t}
          />
        ))}
      </div>
      <span className={css.fade} />
    </div>
  )
}
