/**
 * 应用固定布局壳：导航栏占左列，对话与右侧详情／工作台占上方主区域，
 * 工作台底栏横跨两个主内容列。所有 slot 始终在固定树位置渲染，视觉关闭只
 * 改变网格尺寸、可见性和 inert 状态，不销毁占用者。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from 'coding-client-ui-icons'
import type { SessionId } from 'coding-session/types'
import type { WorkbenchLayoutSnapshot } from './service.ts'
import {
  computeColumns,
  computeWorkbenchBottom,
  computeWorkbenchColumns,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
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
import css from './AppFrame.module.css'

/** AppFrame 向布局服务回报工作区级工作台投影的注入面。 */
export interface AppFrameInjected {
  /** 发布布局当前页面供侧栏入口回显。 */
  publishPage: (page: PageRoute | null) => void
  /** 发布当前工作区的工作台状态。 */
  publishWorkbench: (key: string, state: WorkbenchLayoutSnapshot) => void
  /** 清理已离开会话列表的工作区工作台投影。 */
  retainWorkbenchViews: (keys: readonly string[]) => void
  /** 解析会话所属的工作区键；工作台偏好按它保存。 */
  workspaceKeyOf: (sessionId: SessionId) => string
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
const FLOATING_CONVERSATION_ID = 'dsh-layout-floating-conversation'
const KEYBOARD_STEP = 16
const INNER_POPUP_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"]'
const OPEN_POPUP_TRIGGER_SELECTOR = '[aria-haspopup][aria-expanded="true"]'

function isPopupVisible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** 内层弹层可能只在 document 的原生键盘监听器里关闭，不一定取消 Escape 默认行为。 */
function hasInnerPopup(root: HTMLElement, target: EventTarget | null): boolean {
  if (target instanceof Element) {
    const targetPopup = target.closest(INNER_POPUP_SELECTOR)
    if (targetPopup !== null && targetPopup !== root && isPopupVisible(targetPopup)) return true
  }

  const candidates = root.querySelectorAll(`${INNER_POPUP_SELECTOR}, ${OPEN_POPUP_TRIGGER_SELECTOR}`)
  if (Array.from(candidates).some(isPopupVisible)) return true

  // Portal 也可能使用 region，而不是 menu/dialog；由展开触发器的标准关联识别，避免把普通展开区当成浮层。
  const triggers = root.querySelectorAll('[aria-expanded="true"][aria-controls]')
  return Array.from(triggers).some((trigger) => {
    if (!isPopupVisible(trigger)) return false
    const controls = trigger.getAttribute('aria-controls')
    if (controls === null) return false
    return controls.trim().split(/\s+/u).some((id) => {
      const popup = root.ownerDocument.getElementById(id)
      return popup !== null && !root.contains(popup) && isPopupVisible(popup)
    })
  })
}

interface SurfaceProps {
  children?: ReactNode
  hidden: boolean
}

interface ConversationColumnProps extends SurfaceProps {
  floating: boolean
  title: string
  dialogLabel: string
  minimizeLabel: string
  onMinimize: () => void
}

/** 对话列仅切换呈现位置；子 slot 与输入草稿始终位于同一棵树。 */
function ConversationColumn({
  children, hidden, floating, title, dialogLabel, minimizeLabel, onMinimize,
}: ConversationColumnProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  const minimizeButtonRef = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (floating) minimizeButtonRef.current?.focus()
  }, [floating])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (floating && event.key === 'Escape' && !event.defaultPrevented
      && !hasInnerPopup(event.currentTarget, event.target)) {
      event.preventDefault()
      onMinimize()
    }
  }
  return (
    <div
      id={FLOATING_CONVERSATION_ID}
      className={css.centerCol}
      data-hidden={hidden || undefined}
      data-floating-open={floating || undefined}
      role={floating ? 'dialog' : undefined}
      aria-label={floating ? dialogLabel : undefined}
      onKeyDown={onKeyDown}
      {...hiddenAttributes}
    >
      <div className={css.floatingHeader} aria-hidden={!floating} {...(!floating ? { inert: '' as const } : {})}>
        <span className={css.floatingTitle} title={title}>{title}</span>
        <button
          ref={minimizeButtonRef}
          className={css.minimizeButton}
          type="button"
          aria-label={minimizeLabel}
          title={minimizeLabel}
          onClick={onMinimize}
        >
          <IconChevronDownOutline14 />
        </button>
      </div>
      <div className={css.conversationBody}>{children}</div>
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

type DragOrientation = 'vertical' | 'horizontal'
type DragSide = 'sidebar' | 'details' | 'workbench' | 'bottom'

interface DragHandleProps {
  side: DragSide
  orientation: DragOrientation
  position: number
  startInset?: number
  endInset?: number
  value: number
  min: number
  max: number
  controls: string
  onStart: () => void
  onDrag: (delta: number) => void
  onNudge: (delta: number) => void
  onSet: (value: number) => void
  onEnd: () => void
}

/**
 * 可访问的尺寸分隔条。指针移动按动画帧合并；pointer cancel、capture 丢失、
 * 窗口失焦和卸载都会释放 capture、取消待处理帧并结束父级拖拽状态。
 */
function DragHandle(props: DragHandleProps) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const endDrag = useCallback((updateLocalState = true) => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    if (updateLocalState) setDragging(false)
    callbacks.current.onEnd()
  }, [])

  useEffect(() => {
    if (!dragging) return
    const handleBlur = () => { endDrag() }
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('blur', handleBlur)
      endDrag(false)
    }
  }, [dragging, endDrag])

  const coordinate = (event: PointerEvent<HTMLDivElement>): number =>
    callbacks.current.orientation === 'vertical' ? event.clientX : event.clientY

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    const point = coordinate(event)
    origin.current = point
    latest.current = point
    callbacks.current.onStart()
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    latest.current = coordinate(event)
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(coordinate(event) - origin.current)
    endDrag()
  }, [endDrag])

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === event.pointerId) endDrag()
  }, [endDrag])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const current = callbacks.current
    const negativeKey = current.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const positiveKey = current.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    if (event.key === negativeKey || event.key === positiveKey) {
      event.preventDefault()
      current.onNudge(event.key === negativeKey ? -KEYBOARD_STEP : KEYBOARD_STEP)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      current.onSet(event.key === 'Home' ? current.min : current.max)
    }
  }, [])

  const style: CSSProperties = props.orientation === 'vertical'
    ? { left: props.position, bottom: props.endInset ?? 0 }
    : { top: props.position, left: props.startInset }

  return (
    <div
      className={css.handle}
      style={style}
      role="separator"
      tabIndex={0}
      aria-orientation={props.orientation}
      aria-controls={props.controls}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={Math.round(props.value)}
      data-side={props.side}
      data-orientation={props.orientation}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** 单个 Session 的默认工作台状态。 */
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
  workspaceKeyOf,
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
  const liveSessionIds = useSessions(state => state.ids)
  const page = rootPanels.page
  const pageVisible = page !== null && page.sessionId === activeSession && liveSessionIds.includes(page.sessionId)
  useEffect(() => { publishPage(pageVisible ? page : null) }, [page, pageVisible, publishPage])
  useEffect(() => {
    if (page !== null && !pageVisible) actions.closePage()
  }, [actions, page, pageVisible])
  const activeKey = activeSession === undefined ? undefined : workspaceKeyOf(activeSession)
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
    retainWorkbenchViews(liveSessionIds.map(workspaceKeyOf))
  }, [actions, liveSessionIds, retainWorkbenchViews, workspaceKeyOf])

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

  const workbenchShown = activeSession !== undefined && panels.open && rootPanels.details === 0
  const workbenchFullscreen = workbenchShown && (panels.fullscreen || narrow)
  const welcomeActionsVisible = welcomeSession && !workbenchFullscreen
  // 导航栏只服从自身开关和响应式断点；工作台不隐式抢占会话导航。
  const sidebarCollapsed = narrow ? !rootPanels.narrowExpanded : rootPanels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : rootPanels.sidebar === 0 ? SIDEBAR_DEFAULT : rootPanels.sidebar

  const detailsColumns = computeColumns(
    viewport.width,
    sidebarPreference,
    activeSession === undefined || workbenchShown ? 0 : rootPanels.details,
  )
  const workbenchColumns = computeWorkbenchColumns(
    viewport.width,
    sidebarPreference,
    panels.width,
    workbenchFullscreen,
  )
  const sidebarWidth = workbenchShown ? workbenchColumns.sidebar : detailsColumns.sidebar
  const detailsWidth = workbenchShown ? 0 : detailsColumns.details
  const workbenchWidth = workbenchShown ? workbenchColumns.workbench : 0
  const rightWidth = detailsWidth + workbenchWidth
  const bottomRequested = activeSession !== undefined && rootPanels.details === 0
    && panels.bottomOpen && (workbenchShown || panels.bottomStandalone)
  const bottomHeight = computeWorkbenchBottom(
    viewport.height,
    panels.bottomHeight,
    bottomRequested,
  )
  const bottomShown = bottomRequested && bottomHeight > 0
  const floatingEligible = workbenchFullscreen && !pageVisible
  const [floatingSession, setFloatingSession] = useState<SessionId | undefined>()
  const floatingOpen = floatingEligible && floatingSession === activeSession
  const launcherRef = useRef<HTMLButtonElement | null>(null)
  const minimizeRef = useRef(false)

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

  useEffect(() => {
    if (activeKey === undefined) return
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
        gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${rightWidth}px`,
        gridTemplateRows: `minmax(0, 1fr) ${bottomHeight}px`,
        '--layout-sidebar-width': `${sidebarWidth}px`,
        '--layout-bottom-height': `${bottomHeight}px`,
      } as CSSProperties}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={detailsWidth === 0 || undefined}
      data-workbench-shown={workbenchShown || undefined}
      data-workbench-fullscreen={workbenchFullscreen || undefined}
      data-bottom-open={bottomShown || undefined}
      data-dragging={dragging || undefined}
      data-page-open={pageVisible || undefined}
    >
      <div id={SIDEBAR_ID} className={css.sidebarCol}>
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: sidebarWidth, welcomeActionsVisible })}
      </div>
      <ConversationColumn
        hidden={(workbenchFullscreen || pageVisible) && !floatingOpen}
        floating={floatingOpen}
        title={activeTitle ?? t('floating.open')}
        dialogLabel={t('floating.dialog.label')}
        minimizeLabel={t('floating.minimize.label')}
        onMinimize={minimizeConversation}
      >
        {renderSlot('conversation', { sidebarCollapsed })}
      </ConversationColumn>
      <button
        ref={launcherRef}
        className={css.floatingLauncher}
        type="button"
        aria-label={t('floating.open.label')}
        aria-controls={FLOATING_CONVERSATION_ID}
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
      {pageVisible && (
        <div className={css.pageCol} data-shell-page>
          {renderSlot('shell.page', { closePage: () => { actions.closePage() } }, { entryKey: page.kind })}
        </div>
      )}

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
