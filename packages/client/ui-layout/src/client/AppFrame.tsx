/**
 * 应用固定布局壳：导航栏占左列，对话与右侧详情／工作台占上方主区域，
 * 工作台底栏横跨两个主内容列。所有 slot 始终在固定树位置渲染，视觉关闭只
 * 改变网格尺寸、可见性和 inert 状态，不销毁占用者。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import type { ThemeSnapshot } from 'coding-client-ui-theme/client'
import { IconChevronUpOutline14 } from 'coding-client-ui-icons'
import type { SessionId } from 'coding-session/types'
import type { WorkbenchLayoutSnapshot } from './service.ts'
import {
  computeColumns,
  computeWorkbenchBottom,
  computeWorkbenchColumns,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKBENCH_BOTTOM_DEFAULT,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_DEFAULT,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
  WORKBENCH_TOP_MIN,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import type { PageRoute } from './stores.ts'
import type { FloatingDock } from './floating-dock.ts'
import { CONVERSATION_COLUMN_ID, ConversationColumn } from './ConversationColumn.tsx'
import { DragHandle } from './DragHandle.tsx'
import css from './AppFrame.module.css'

/** AppFrame 向布局服务回报工作区级工作台投影的注入面。 */
export interface AppFrameInjected {
  /** 归还页面打开前的会话；会话列表已失效时由调用方直接丢弃请求。 */
  restoreConversation: (sessionId: SessionId) => void
  /** 发布布局当前页面供侧栏入口回显。 */
  publishPage: (page: PageRoute | null) => void
  /** 发布当前工作区的工作台状态。 */
  publishWorkbench: (key: string, state: WorkbenchLayoutSnapshot) => void
  /** 清理已离开会话列表的工作区工作台投影。 */
  retainWorkbenchViews: (keys: readonly string[]) => void
  /** 解析会话所属的工作区键；工作台偏好按它保存。 */
  workspaceKeyOf: (sessionId: SessionId) => string
  /** 当前主题快照，供外层导航根据生效明暗更新图标。 */
  hooks: {
    theme: HostObservable<ThemeSnapshot>
    /** 独立页助手是否存在「新对话」入口；为真时手势交给 startPageConversation。 */
    pageConversation: HostObservable<boolean>
  }
  /** 切换到指定的主题偏好。 */
  setTheme: (id: 'light' | 'dark') => void
  /** 发起独立页助手的「新对话」；页面插件未登记入口时无动作。 */
  startPageConversation: () => void
}

/** AppFrame 的框架派生 props。 */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'workbench' | 'workbench.bottom' | 'shell.overlay' | 'shell.page'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & InjectFace<AppFrameInjected>
  & PropsLocale<'layout'>

const SIDEBAR_ID = 'dsh-layout-sidebar'
const DETAILS_ID = 'dsh-layout-details'
const WORKBENCH_ID = 'dsh-layout-workbench'
const WORKBENCH_BOTTOM_ID = 'dsh-layout-workbench-bottom'
const FLOATING_GAP = 12
const PAGE_ASSISTANT_WIDTH = 376
const PAGE_BODY_MIN = 648

interface SurfaceProps {
  children?: ReactNode
  hidden: boolean
}

/** 内层侧栏列；独立主内容页打开时随页面隐藏，页面关闭后按用户的栏宽偏好恢复。 */
function SidebarColumn({ children, hidden }: SurfaceProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  return (
    <div
      id={SIDEBAR_ID}
      className={css.sidebarCol}
      data-hidden={hidden || undefined}
      {...hiddenAttributes}
    >
      {children}
    </div>
  )
}

/** 详情列；关闭时保持挂载。 */
function DetailsColumn({ children, hidden }: SurfaceProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  return (
    <div
      id={DETAILS_ID}
      className={css.detailsCol}
      data-hidden={hidden || undefined}
      {...hiddenAttributes}
    >
      {children}
    </div>
  )
}

/** 工作台右列；关闭时保持挂载。 */
function WorkbenchColumn({ children, hidden }: SurfaceProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  return (
    <div
      id={WORKBENCH_ID}
      className={css.workbenchCol}
      data-hidden={hidden || undefined}
      {...hiddenAttributes}
    >
      {children}
    </div>
  )
}

/** 工作台底栏；关闭时保持挂载并退出可访问树。 */
function WorkbenchBottom({ children, hidden }: SurfaceProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  return (
    <div
      id={WORKBENCH_BOTTOM_ID}
      className={css.bottomCol}
      data-hidden={hidden || undefined}
      {...hiddenAttributes}
    >
      {children}
    </div>
  )
}

/** 单个 Session 的默认工作台状态；`width` 为 0 时由求解器按 1:2 分配主内容。 */
const WORKBENCH_FALLBACK = {
  open: false,
  fullscreen: false,
  width: WORKBENCH_DEFAULT,
  bottomOpen: false,
  bottomStandalone: false,
  bottomHeight: WORKBENCH_BOTTOM_DEFAULT,
}

/** 固定工作台布局壳。 */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  publishWorkbench,
  retainWorkbenchViews,
  publishPage,
  restoreConversation,
  workspaceKeyOf,
  startPageConversation,
  usePageConversation,
  t,
}: AppFrameProps) {
  const rootPanels = useStore(state => state)
  const activeSession = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current] !== undefined ? current : undefined
  })
  const activeTitle = useSessions((state) => {
    const current = state.current
    return current === undefined ? undefined : state.byId[current]?.displayTitle
  })
  const welcomeSession = useSessions((state) => {
    const current = state.current
    return current === undefined || state.byId[current]?.blank === true
  })
  const activeBlank = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === true
  })
  const liveSessionIds = useSessions(state => state.ids)
  const page = rootPanels.page
  const pageVisible = page !== null && page.sessionId === activeSession && liveSessionIds.includes(page.sessionId)
  useEffect(() => { publishPage(pageVisible ? page : null) }, [page, pageVisible, publishPage])
  const conversationReturn = rootPanels.conversationReturn
  useLayoutEffect(() => {
    if (conversationReturn === null) return
    actions.acknowledgeConversationReturn(conversationReturn.seq)
    // 导航选中其他会话、来源已经移除，或目标不存在时，不得以旧请求抢回用户当前选择。
    if (activeSession !== conversationReturn.from || !liveSessionIds.includes(conversationReturn.sessionId)) return
    restoreConversation(conversationReturn.sessionId)
  }, [actions, activeSession, conversationReturn, liveSessionIds, restoreConversation])
  useEffect(() => {
    if (page !== null && !pageVisible) actions.discardPage()
  }, [actions, page, pageVisible])
  const activeKey = activeSession === undefined ? undefined : workspaceKeyOf(activeSession)
  useLayoutEffect(() => {
    actions.selectConversation(activeSession)
    actions.setActiveBlankSession(activeBlank ? activeSession : undefined, activeKey)
  }, [actions, activeBlank, activeKey, activeSession])
  const panels = useMemo(() => {
    const current = activeKey === undefined ? undefined : rootPanels.workbench[activeKey]
    return current ?? WORKBENCH_FALLBACK
  }, [activeKey, rootPanels.workbench])
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  const lastSession = useRef(activeSession)
  useLayoutEffect(() => {
    if (activeSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== activeSession) actions.closeDetails()
    lastSession.current = activeSession
  }, [actions, activeSession])

  // 工作台布局与 Session 生命周期绑定；离开会话列表时同步释放瞬时状态与页头投影。
  useEffect(() => {
    actions.retainWorkbenchSessions(liveSessionIds.map(workspaceKeyOf))
    actions.retainBlankSessions(liveSessionIds)
    retainWorkbenchViews(liveSessionIds.map(workspaceKeyOf))
  }, [actions, liveSessionIds, retainWorkbenchViews, workspaceKeyOf])

  useLayoutEffect(() => {
    if (activeSession !== undefined && !activeBlank) actions.clearBlankWorkbench(activeSession)
  }, [actions, activeBlank, activeSession])

  useLayoutEffect(() => {
    const element = frameRef.current
    /* v8 ignore next -- frame 容器始终渲染，layout effect 执行时 ref 必定存在。 */
    if (element === null) return
    let pending: number | null = null
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setViewport(current => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(() => {
      pending ??= requestAnimationFrame(() => {
        pending = null
        measure()
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (pending !== null) cancelAnimationFrame(pending)
    }
  }, [])

  const narrow = viewport.width < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])

  const workbenchShown = activeSession !== undefined && rootPanels.details === 0
    && (activeBlank
      ? rootPanels.blankWorkbench[activeSession] === true
        || rootPanels.blankWorkbench[activeSession] === undefined
          && rootPanels.suppressedWorkbench[activeSession] === false && panels.open
      : panels.open && rootPanels.suppressedWorkbench[activeSession] !== true)
  const workbenchFullscreen = workbenchShown && (panels.fullscreen || narrow)
  const welcomeActionsVisible = welcomeSession && !workbenchFullscreen
  // 导航栏只服从自身开关和响应式断点；工作台不隐式抢占会话导航。
  const sidebarCollapsed = narrow ? !rootPanels.narrowExpanded : rootPanels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : rootPanels.sidebar === 0 ? rootPanels.sidebarExpandedWidth : rootPanels.sidebar

  const detailsColumns = computeColumns(
    viewport.width,
    sidebarPreference,
    activeSession === undefined || activeBlank || workbenchShown ? 0 : rootPanels.details,
  )
  const workbenchColumns = computeWorkbenchColumns(
    viewport.width,
    sidebarPreference,
    panels.width,
    workbenchFullscreen,
  )
  const sidebarWidth = workbenchShown ? workbenchColumns.sidebar : detailsColumns.sidebar
  const canDockAssistant = viewport.width - sidebarWidth >= PAGE_BODY_MIN + PAGE_ASSISTANT_WIDTH
  const hasPageAssistant = pageVisible && rootPanels.pageAssistant !== null
  const assistantOpen = hasPageAssistant && (rootPanels.pageAssistant === 'auto' ? canDockAssistant : rootPanels.pageAssistant === true)
  const assistantMode = assistantOpen ? (canDockAssistant ? 'dock' : 'drawer') : null
  const pageRef = useRef<HTMLDivElement>(null)
  const restoreAssistantFocus = useRef(false)
  const closePage = useCallback(() => { actions.closePage() }, [actions])
  const toggleAssistant = () => { actions.setPageAssistant(!assistantOpen) }
  const pageConversationAvailable = usePageConversation(available => available)
  const closeAssistant = () => {
    restoreAssistantFocus.current = true
    actions.setPageAssistant(false)
  }
  useLayoutEffect(() => {
    if (assistantOpen || !restoreAssistantFocus.current) return
    restoreAssistantFocus.current = false
    pageRef.current?.querySelector<HTMLElement>(`[aria-controls="${CONVERSATION_COLUMN_ID}"]`)?.focus({ preventScroll: true })
  }, [assistantOpen])
  const detailsWidth = workbenchShown ? 0 : detailsColumns.details
  const workbenchWidth = workbenchShown ? workbenchColumns.workbench : 0
  const rightWidth = detailsWidth + workbenchWidth
  const bottomRequested = activeSession !== undefined && (rootPanels.details === 0 || activeBlank)
    && panels.bottomOpen && (workbenchShown || panels.bottomStandalone || activeBlank)
  const bottomHeight = computeWorkbenchBottom(
    viewport.height,
    panels.bottomHeight,
    bottomRequested,
  )
  const bottomShown = bottomRequested && bottomHeight > 0
  const floatingEligible = workbenchFullscreen && !pageVisible
  const [floatingSession, setFloatingSession] = useState<SessionId | undefined>()
  const [floatingDock, setFloatingDock] = useState<FloatingDock>('center')
  const dockSession = useRef(activeSession)
  const floatingOpen = floatingEligible && floatingSession === activeSession
  const launcherRef = useRef<HTMLButtonElement | null>(null)
  const minimizeRef = useRef(false)

  useLayoutEffect(() => {
    if (dockSession.current === activeSession) return
    dockSession.current = activeSession
    setFloatingDock('center')
  }, [activeSession])

  useLayoutEffect(() => {
    if (floatingSession !== undefined && (!floatingEligible || floatingSession !== activeSession)) {
      setFloatingSession(undefined)
    }
  }, [activeSession, floatingEligible, floatingSession])

  useLayoutEffect(() => {
    if (minimizeRef.current && !floatingOpen) {
      minimizeRef.current = false
      launcherRef.current?.focus()
    }
  }, [floatingOpen])

  const minimizeConversation = useCallback(() => {
    minimizeRef.current = true
    setFloatingSession(undefined)
  }, [])

  const conversationRequest = rootPanels.conversationRequest
  useLayoutEffect(() => {
    if (conversationRequest === null) return
    actions.acknowledgeConversationRequest(conversationRequest.seq)
    if (conversationRequest.sessionId !== activeSession || !liveSessionIds.includes(conversationRequest.sessionId)) return
    if (pageVisible) actions.closePage()
    if (workbenchFullscreen) setFloatingSession(activeSession)
  }, [actions, activeSession, conversationRequest, liveSessionIds, pageVisible, workbenchFullscreen])

  const publishedWorkbenchKey = useRef<string | undefined>(activeKey)
  useEffect(() => {
    if (publishedWorkbenchKey.current !== undefined && publishedWorkbenchKey.current !== activeKey) {
      publishWorkbench(publishedWorkbenchKey.current, { open: false, fullscreen: false, bottomOpen: false })
    }
    if (activeKey === undefined) {
      publishedWorkbenchKey.current = undefined
      return
    }
    publishedWorkbenchKey.current = activeKey
    publishWorkbench(activeKey, {
      open: workbenchShown,
      fullscreen: workbenchShown && panels.fullscreen,
      bottomOpen: bottomRequested,
    })
  }, [activeKey, bottomRequested, panels.fullscreen, publishWorkbench, workbenchShown])

  const geometry = useRef({ sidebarWidth, detailsWidth, workbenchWidth, bottomHeight })
  geometry.current = { sidebarWidth, detailsWidth, workbenchWidth, bottomHeight }
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const workbenchBase = useRef(0)
  const bottomBase = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = geometry.current.sidebarWidth; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = geometry.current.detailsWidth; setDragging(true) }, [])
  const onWorkbenchStart = useCallback(() => { workbenchBase.current = geometry.current.workbenchWidth; setDragging(true) }, [])
  const onBottomStart = useCallback(() => { bottomBase.current = geometry.current.bottomHeight; setDragging(true) }, [])
  const onSidebarDrag = useCallback((delta: number) => { actions.setSidebar(sidebarBase.current + delta) }, [actions])
  const onDetailsDrag = useCallback((delta: number) => { actions.setDetails(detailsBase.current - delta) }, [actions])
  const onWorkbenchDrag = useCallback((delta: number) => {
    if (activeKey !== undefined) actions.setWorkbench(activeKey, workbenchBase.current - delta)
  }, [actions, activeKey])
  const onBottomDrag = useCallback((delta: number) => {
    if (activeKey !== undefined) actions.setWorkbenchBottom(activeKey, bottomBase.current - delta)
  }, [actions, activeKey])
  const nudgeSidebar = useCallback((delta: number) => { actions.setSidebar(geometry.current.sidebarWidth + delta) }, [actions])
  const nudgeDetails = useCallback((delta: number) => { actions.setDetails(geometry.current.detailsWidth - delta) }, [actions])
  const nudgeWorkbench = useCallback((delta: number) => {
    if (activeKey !== undefined) actions.setWorkbench(activeKey, geometry.current.workbenchWidth + delta)
  }, [actions, activeKey])
  const nudgeBottom = useCallback((delta: number) => {
    if (activeKey !== undefined) actions.setWorkbenchBottom(activeKey, geometry.current.bottomHeight - delta)
  }, [actions, activeKey])
  const setWorkbench = useCallback((value: number) => {
    if (activeKey !== undefined) actions.setWorkbench(activeKey, value)
  }, [actions, activeKey])
  const setWorkbenchBottom = useCallback((value: number) => {
    if (activeKey !== undefined) actions.setWorkbenchBottom(activeKey, value)
  }, [actions, activeKey])
  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        // 独立页覆盖整行时保留对话侧栏的网格宽度；返回对话不会从零宽重新展开。
        gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${rightWidth}px`,
        gridTemplateRows: `minmax(0, 1fr) ${bottomHeight}px`,
        '--layout-sidebar-width': `${sidebarWidth}px`,
        '--layout-bottom-height': `${bottomHeight}px`,
        '--layout-floating-edge': `${FLOATING_GAP}px`,
        '--layout-page-assistant-width': `${PAGE_ASSISTANT_WIDTH}px`,
      } as CSSProperties}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={detailsWidth === 0 || undefined}
      data-workbench-shown={workbenchShown || undefined}
      data-workbench-fullscreen={workbenchFullscreen || undefined}
      data-floating-dock={floatingDock}
      data-bottom-open={bottomShown || undefined}
      data-dragging={dragging || undefined}
      data-page-open={pageVisible || undefined}
    >
      <SidebarColumn hidden={pageVisible}>
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: sidebarWidth, welcomeActionsVisible })}
      </SidebarColumn>
      {pageVisible && (
        <div ref={pageRef} className={css.pageCol} data-shell-page data-page-assistant={assistantMode ?? undefined}
          {...(assistantMode === 'drawer' ? { 'aria-hidden': true, inert: '' } as const : {})}>
          {renderSlot('shell.page', {
            closePage,
            sidebarCollapsed,
            sidebarWidth,
            assistantOpen,
            assistantPanelId: CONVERSATION_COLUMN_ID,
            toggleAssistant,
          }, { entryKey: page.kind })}
        </div>
      )}
      {assistantMode === 'drawer' && <div className={css.assistantMask} aria-hidden="true" onClick={closeAssistant} />}
      <ConversationColumn
        hidden={(workbenchFullscreen || pageVisible) && !floatingOpen && !assistantOpen}
        floating={floatingOpen}
        dock={floatingDock}
        bounds={{
          left: sidebarWidth + FLOATING_GAP,
          right: viewport.width - FLOATING_GAP,
          top: FLOATING_GAP,
          bottom: viewport.height - bottomHeight - FLOATING_GAP,
        }}
        title={activeTitle ?? t('floating.open')}
        dialogLabel={t('floating.dialog.label')}
        minimizeLabel={t('floating.minimize.label')}
        dragLabel={t('floating.drag.label')}
        dragHint={t('floating.drag.hint', { position: t(`floating.dock.${floatingDock}`) })}
        onMinimize={minimizeConversation}
        onDock={setFloatingDock}
        assistant={assistantMode}
        assistantLabel={t('assistant.title')}
        assistantCloseLabel={t('assistant.close')}
        assistantNewLabel={t('assistant.new')}
        onNewAssistantConversation={pageConversationAvailable ? startPageConversation : undefined}
        onCloseAssistant={closeAssistant}
      >
        {renderSlot('conversation', { sidebarCollapsed, ...(hasPageAssistant ? { inPageAssistant: true } : {}) })}
      </ConversationColumn>
      <button
        ref={launcherRef}
        className={css.floatingLauncher}
        type="button"
        aria-label={t('floating.open.label')}
        aria-controls={CONVERSATION_COLUMN_ID}
        aria-expanded={floatingOpen}
        aria-hidden={!floatingEligible || floatingOpen}
        {...(!floatingEligible || floatingOpen ? { inert: '' as const } : {})}
        data-hidden={!floatingEligible || floatingOpen || undefined}
        onClick={() => { if (activeSession !== undefined) setFloatingSession(activeSession) }}
      >
        <span className={css.launcherLabel}>{t('floating.open')}</span>
        {activeTitle && <span className={css.launcherTitle} title={activeTitle}>{activeTitle}</span>}
        <IconChevronUpOutline14 />
      </button>
      <DetailsColumn hidden={detailsWidth === 0 || pageVisible}>
        {renderSlot('details', {})}
      </DetailsColumn>
      <WorkbenchColumn hidden={!workbenchShown || pageVisible}>
        {renderSlot('workbench', {
          shown: workbenchShown,
          fullscreen: workbenchFullscreen,
          bottomOpen: bottomShown,
        })}
      </WorkbenchColumn>
      <WorkbenchBottom hidden={!bottomShown || pageVisible}>
        {renderSlot('workbench.bottom', { sessionId: activeSession, shown: bottomShown })}
      </WorkbenchBottom>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {!sidebarCollapsed && (
        <DragHandle
          side="sidebar"
          orientation="vertical"
          position={sidebarWidth}
          value={sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          controls={SIDEBAR_ID}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onNudge={nudgeSidebar}
          onSet={actions.setSidebar}
          onEnd={onDragEnd}
        />
      )}
      {detailsWidth > 0 && (
        <DragHandle
          side="details"
          orientation="vertical"
          position={viewport.width - detailsWidth}
          value={detailsWidth}
          min={DETAILS_MIN}
          max={DETAILS_MAX}
          controls={DETAILS_ID}
          onStart={onDetailsStart}
          onDrag={onDetailsDrag}
          onNudge={nudgeDetails}
          onSet={actions.setDetails}
          onEnd={onDragEnd}
        />
      )}
      {workbenchShown && !workbenchFullscreen && (
        <DragHandle
          side="workbench"
          orientation="vertical"
          position={viewport.width - workbenchWidth}
          endInset={bottomHeight}
          value={workbenchWidth}
          min={WORKBENCH_MIN}
          max={WORKBENCH_MAX}
          controls={WORKBENCH_ID}
          onStart={onWorkbenchStart}
          onDrag={onWorkbenchDrag}
          onNudge={nudgeWorkbench}
          onSet={setWorkbench}
          onEnd={onDragEnd}
        />
      )}
      {bottomShown && (
        <DragHandle
          side="bottom"
          orientation="horizontal"
          position={viewport.height - bottomHeight}
          startInset={sidebarWidth}
          value={bottomHeight}
          min={Math.min(WORKBENCH_BOTTOM_MIN, bottomHeight)}
          max={Math.max(
            bottomHeight,
            Math.min(WORKBENCH_BOTTOM_MAX, Math.max(0, viewport.height - WORKBENCH_TOP_MIN)),
          )}
          controls={WORKBENCH_BOTTOM_ID}
          onStart={onBottomStart}
          onDrag={onBottomDrag}
          onNudge={nudgeBottom}
          onSet={setWorkbenchBottom}
          onEnd={onDragEnd}
        />
      )}
    </div>
  )
}
