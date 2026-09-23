// 常驻会话骨架在无会话与有会话之间切换时保留 Hero、编辑器定位、接管链和
// session-maybe 输入栏；没有会话时由 owner props 锁定输入栏。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import { HeroGlow, HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import css from './ConversationRoot.module.css'

/** 由 slot 契约组合得到的完整 props。 */
export type ConversationRootProps = ConversationSlotProps

// 748px 居中消息列与右侧 288px 卡片之间保留至少 16px，另计卡片右边距 16px。
const OVERVIEW_MIN_COLUMN_WIDTH = 1_388

export function ConversationRoot({
  sessionId, sidebarCollapsed, useSession, useSessions, useWorkspaces, useInput, useComposerBlock,
  renderSlot, renderSlotChain, selectWorkspace, t,
}: ConversationRootProps) {
  const openState = useSession(s => s.openState)
  const composerPhase = useSession(s => s.composerPhase)
  const pending = useSession(s => s.pending) ?? []
  const session = useSession(s => s)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const workspaces = useWorkspaces(s => s)
  // 本包不能导入的 ui-model-selection 等插件可限制会话发送，并提供本地化理由。
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [columnWidth, setColumnWidth] = useState(0)
  const [overviewPreference, setOverviewPreference] = useState<{
    sessionId: SessionId | undefined
    compact: boolean
    expanded: boolean
  } | null>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const measure = () => { setColumnWidth(root.getBoundingClientRect().width || window.innerWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [])
  const overviewCompact = columnWidth < OVERVIEW_MIN_COLUMN_WIDTH
  const overviewExpanded = overviewPreference !== null
    && overviewPreference.sessionId === sessionId
    && overviewPreference.compact === overviewCompact
    ? overviewPreference.expanded
    : !overviewCompact
  useEffect(() => { setOverviewPreference(null) }, [overviewCompact, sessionId])
  const toggleOverview = () => {
    setOverviewPreference({ sessionId, compact: overviewCompact, expanded: !overviewExpanded })
  }

  // 将编辑器座位的实时高度发布到滚动主体的 --dsh-composer-height，供 ChatView
  // 回到底部等浮动控件避让。稳定的 callback ref 可避免首个空会话填入常驻主体时
  // 重建 observer。
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
    })
    seatObserver.current.observe(seat)
  }, [])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // 会话进入所选工作区，或该工作区从已就绪列表中被删除时，清除待定选择。
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  // 日志回放期间尚不能确定 Hero 或底部编辑器布局，先隐藏编辑器以免跳动。
  // 列表摘要已确认空白的会话除外：它没有历史，cold、loading 与 error 状态都
  // 保持 Hero，避免启动自动选择时在历史请求期间整列闪空。
  const settling = sessionId !== undefined && composerPhase === 'blank' && openState === 'loading'
    && summaryBlank !== true
  const hero = sessionId === undefined
    || (composerPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // 菜单刚选中的工作区优先显示；列表尚未就绪时以 cwd 名称防闪烁，确认
  // 会话不属于任何工作区后才显示无项目状态，避免把已删除的项目误标出来。
  const noProject = sessionId !== undefined && pendingWorkspace === undefined
    && sessionWorkspace === undefined && workspaces.phase === 'ready'
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready'
          ? t('hero.noProject')
          : cwd === undefined || cwd === ''
            ? undefined
            : workspaceLabel(cwd)))

  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}>
      {renderSlot('conversation.hero.agentPreset', {})}
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={chipTitle}
        mode={noProject ? 'no-project' : undefined}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
        t={t}
      />
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
        onPick: (workspaceId) => {
          setPickerOpen(false)
          setPendingWorkspaceId(workspaceId)
          void selectWorkspace(workspaceId).catch(() => {
            setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
          })
        },
        onClose: () => { setPickerOpen(false) },
      })}
    </div>
  )

  // 没有会话时只能先选择入口；已有但未归属项目的会话使用 Host 默认 cwd，
  // 可直接发送。输入栏始终复用同一棵树，切换状态不会销毁 textarea。
  const inert = sessionId === undefined
  // 发送限制仍优先于普通输入；模型选择器保留可用，便于解除其自身的限制。
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hero ? 'hero' : 'composer',
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // 使用 blocked 而非 disabled：输入栏都会拒绝输入，但阻塞态必须保留模型
        // seat，用户选择模型后才能解除这个阻塞。
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hero ? { placeholder: t('placeholder.hero') } : {}),
    overlay: renderSlot('conversation.input.overlay', {}),
    leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
    rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
    // 输入栏下方的扩展 dock 仍保留座位；会话统计由页面概览卡显示。
    footer: !hero && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
  })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {hero && <HeroGlow className={css.heroGlow} />}
      {hero && <HeroShell t={t} renderSlot={renderSlot} />}
      {hero && heroWorkspaceRow}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { interactions: pending, session },
    { fallback: composerBar, overlay: true },
  )

  // sticky 必须包住整条接管链输出；overlay:true 将 fallback 和接管面板渲染为
  // 兄弟节点，只固定 .composerStack 会让问题或审批面板在未滚到底时落到屏幕外。
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  return (
    <div ref={rootRef} className={css.root} data-phase={phase}>
      {(hero || settling) && <div className={css.windowDragStrip} data-window-drag-strip data-window-drag-region aria-hidden="true" />}
      {hero && (
        <div className={css.heroActions}>
          {renderSlot('conversation.hero.actions', { sidebarCollapsed })}
        </div>
      )}
      {renderSlot('conversation.session.header', { overviewExpanded, toggleOverview })}
      <div className={css.scrollBody} data-conversation-scroll="">
        {renderSlot('conversation.session', {})}
        {composerSeat}
      </div>
      {!hero && !settling && renderSlot('conversation.overview', { overviewExpanded, toggleOverview })}
    </div>
  )
}
