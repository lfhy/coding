/**
 * 应用固定布局壳：导航栏占左列，对话与右侧详情／工作台占上方主区域，
 * 工作台底栏横跨两个主内容列。所有 slot 始终在固定树位置渲染，视觉关闭只
 * 改变网格尺寸、可见性和 inert 状态，不销毁占用者。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
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
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
  WORKBENCH_TOP_MIN,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** AppFrame 的框架派生 props。 */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'workbench' | 'workbench.bottom' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

const SIDEBAR_ID = 'dsh-layout-sidebar'
const DETAILS_ID = 'dsh-layout-details'
const WORKBENCH_ID = 'dsh-layout-workbench'
const WORKBENCH_BOTTOM_ID = 'dsh-layout-workbench-bottom'
const KEYBOARD_STEP = 16

interface SurfaceProps {
  children?: ReactNode
  hidden: boolean
}

/** 对话列；全屏工作台期间保持挂载但退出可访问树。 */
function ConversationColumn({ children, hidden }: SurfaceProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  return (
    <div
      className={css.centerCol}
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

/** 固定工作台布局壳。 */
export function AppFrame({ useStore, useSessions, actions, renderSlot }: AppFrameProps) {
  const panels = useStore(state => state)
  const activeSession = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  const lastSession = useRef(activeSession)
  useLayoutEffect(() => {
    if (activeSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== activeSession) actions.closeDetails()
    lastSession.current = activeSession
  }, [actions, activeSession])

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

  const workbenchShown = activeSession !== undefined && panels.workbenchOpen
  const workbenchFullscreen = workbenchShown && (panels.workbenchFullscreen || narrow)
  // 工作台打开时收起导航，让左侧直接成为对话区，并把主要宽度留给预览和文件树。
  const sidebarCollapsed = workbenchShown ? true : narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar

  const detailsColumns = computeColumns(
    viewport.width,
    sidebarPreference,
    activeSession === undefined || workbenchShown ? 0 : panels.details,
  )
  const workbenchColumns = computeWorkbenchColumns(
    viewport.width,
    sidebarPreference,
    panels.workbenchWidth,
    workbenchFullscreen,
  )
  const sidebarWidth = workbenchShown ? workbenchColumns.sidebar : detailsColumns.sidebar
  const detailsWidth = workbenchShown ? 0 : detailsColumns.details
  const workbenchWidth = workbenchShown ? workbenchColumns.workbench : 0
  const rightWidth = detailsWidth + workbenchWidth
  const bottomRequested = workbenchShown && panels.workbenchBottomOpen
  const bottomHeight = computeWorkbenchBottom(
    viewport.height,
    panels.workbenchBottomHeight,
    bottomRequested,
  )
  const bottomShown = bottomRequested && bottomHeight > 0

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
  const onWorkbenchDrag = useCallback((delta: number) => { actions.setWorkbench(workbenchBase.current - delta) }, [actions])
  const onBottomDrag = useCallback((delta: number) => { actions.setWorkbenchBottom(bottomBase.current - delta) }, [actions])
  const nudgeSidebar = useCallback((delta: number) => { actions.setSidebar(geometry.current.sidebarWidth + delta) }, [actions])
  const nudgeDetails = useCallback((delta: number) => { actions.setDetails(geometry.current.detailsWidth - delta) }, [actions])
  const nudgeWorkbench = useCallback((delta: number) => { actions.setWorkbench(geometry.current.workbenchWidth - delta) }, [actions])
  const nudgeBottom = useCallback((delta: number) => { actions.setWorkbenchBottom(geometry.current.bottomHeight - delta) }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${rightWidth}px`,
        gridTemplateRows: `minmax(0, 1fr) ${bottomHeight}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={detailsWidth === 0 || undefined}
      data-workbench-shown={workbenchShown || undefined}
      data-workbench-fullscreen={workbenchFullscreen || undefined}
      data-bottom-open={bottomShown || undefined}
      data-dragging={dragging || undefined}
    >
      <div id={SIDEBAR_ID} className={css.sidebarCol}>
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: sidebarWidth })}
      </div>
      <ConversationColumn hidden={workbenchFullscreen}>
        {renderSlot('conversation', {})}
      </ConversationColumn>
      <DetailsColumn hidden={detailsWidth === 0}>
        {renderSlot('details', {})}
      </DetailsColumn>
      <WorkbenchColumn hidden={!workbenchShown}>
        {renderSlot('workbench', {
          shown: workbenchShown,
          fullscreen: workbenchFullscreen,
          bottomOpen: bottomShown,
          close: actions.closeWorkbench,
          toggleFullscreen: actions.toggleWorkbenchFullscreen,
          toggleBottom: actions.toggleWorkbenchBottom,
        })}
      </WorkbenchColumn>
      <WorkbenchBottom hidden={!bottomShown}>
        {renderSlot('workbench.bottom', { shown: bottomShown })}
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
          onSet={actions.setWorkbench}
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
          onSet={actions.setWorkbenchBottom}
          onEnd={onDragEnd}
        />
      )}
    </div>
  )
}
