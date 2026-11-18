import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { Icon, IconChevronDownOutline14, IconCloseOutline16, IconSparkle16 } from 'coding-client-ui-icons'
import { Button } from 'coding-client-ui-primitives'
import { clampFloatingPoint, snapFloatingDock } from './floating-dock.ts'
import type { FloatingBounds, FloatingDock, FloatingPoint, FloatingSize } from './floating-dock.ts'
import css from './AppFrame.module.css'

/** 同一个对话容器同时供悬浮入口和独立页的助手开关引用。 */
export const CONVERSATION_COLUMN_ID = 'dsh-layout-floating-conversation'
const FLOATING_DOCK_HELP_ID = 'dsh-layout-floating-dock-help'
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

  // 根据 aria-controls 识别在容器外渲染的弹层，包括不使用 menu/dialog 的面板。
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

interface ConversationColumnProps {
  children?: ReactNode
  hidden: boolean
  floating: boolean
  dock: FloatingDock
  bounds: FloatingBounds
  title: string
  dialogLabel: string
  minimizeLabel: string
  dragLabel: string
  dragHint: string
  onMinimize: () => void
  onDock: (dock: FloatingDock) => void
  assistant: 'dock' | 'drawer' | null
  assistantLabel: string
  assistantCloseLabel: string
  onCloseAssistant: () => void
}

interface FloatingDrag {
  readonly pointerId: number
  readonly handle: HTMLButtonElement
  readonly origin: FloatingPoint
  readonly size: FloatingSize
  readonly startX: number
  readonly startY: number
  x: number
  y: number
  frame: number | null
}

/**
 * 对话列在普通、悬浮和助手三种呈现之间复用同一棵会话子树。
 * @param props - 呈现方式、边界与局部操作。
 * @returns 固定挂载的对话容器。
 */
export function ConversationColumn({
  children, hidden, floating, dock, bounds, title, dialogLabel, minimizeLabel, dragLabel, dragHint, onMinimize, onDock,
  assistant, assistantLabel, assistantCloseLabel, onCloseAssistant,
}: ConversationColumnProps) {
  const hiddenAttributes = hidden ? { 'aria-hidden': true, inert: '' } as const : {}
  const columnRef = useRef<HTMLDivElement | null>(null)
  const minimizeButtonRef = useRef<HTMLButtonElement | null>(null)
  const activeDrag = useRef<FloatingDrag | null>(null)
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const [dragPoint, setDragPoint] = useState<FloatingPoint | null>(null)

  const cancelDrag: () => void = useCallback(() => {
    const current = activeDrag.current
    if (current === null) return
    activeDrag.current = null
    if (current.frame !== null) cancelAnimationFrame(current.frame)
    window.removeEventListener('blur', cancelDrag)
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
    setDragPoint(null)
  }, [])

  useEffect(() => () => { cancelDrag() }, [cancelDrag])
  useLayoutEffect(() => { if (!floating) cancelDrag() }, [floating, cancelDrag])

  const sizeOf = useCallback((current: FloatingDrag): FloatingSize => {
    const rect = columnRef.current?.getBoundingClientRect()
    return rect === undefined ? current.size : { width: rect.width, height: rect.height }
  }, [])
  const pointOf = useCallback((current: FloatingDrag, x: number, y: number): FloatingPoint => clampFloatingPoint({
    left: current.origin.left + x - current.startX,
    top: current.origin.top + y - current.startY,
  }, sizeOf(current), boundsRef.current), [sizeOf])

  // 边界也可能由终端或窗口变化推进；指针静止时仍须让小窗留在新的工作区内。
  useLayoutEffect(() => {
    const current = activeDrag.current
    if (current !== null) setDragPoint(pointOf(current, current.x, current.y))
  }, [bounds.left, bounds.right, bounds.top, bounds.bottom, pointOf])

  const startDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const column = columnRef.current
    if (!floating || event.button !== 0 || activeDrag.current !== null || column === null) return
    const rect = column.getBoundingClientRect()
    const frame = column.parentElement?.getBoundingClientRect()
    if (frame === undefined) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    const current: FloatingDrag = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      origin: { left: rect.left - frame.left, top: rect.top - frame.top },
      size: { width: rect.width, height: rect.height },
      startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, frame: null,
    }
    activeDrag.current = current
    setDragPoint(pointOf(current, current.x, current.y))
    window.addEventListener('blur', cancelDrag)
  }
  const moveDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = activeDrag.current
    if (current?.pointerId !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    current.frame ??= requestAnimationFrame(() => {
      current.frame = null
      if (activeDrag.current === current) setDragPoint(pointOf(current, current.x, current.y))
    })
  }
  const finishDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = activeDrag.current
    if (current?.pointerId !== event.pointerId) return
    const point = pointOf(current, event.clientX, event.clientY)
    const next = snapFloatingDock(point.left, sizeOf(current), boundsRef.current, dock)
    cancelDrag()
    onDock(next)
  }
  const cancelPointer = (event: PointerEvent<HTMLButtonElement>): void => {
    if (activeDrag.current?.pointerId === event.pointerId) cancelDrag()
  }
  const moveDock = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape' && activeDrag.current !== null) {
      event.preventDefault()
      cancelDrag()
      return
    }
    if (activeDrag.current !== null) return
    let next: FloatingDock
    switch (event.key) {
      case 'ArrowLeft': next = dock === 'right' ? 'center' : 'left'; break
      case 'ArrowRight': next = dock === 'left' ? 'center' : 'right'; break
      case 'Home': next = 'left'; break
      case 'End': next = 'right'; break
      default: return
    }
    event.preventDefault()
    onDock(next)
  }
  useLayoutEffect(() => {
    if (floating) minimizeButtonRef.current?.focus()
  }, [floating])
  useLayoutEffect(() => {
    if (assistant !== 'drawer') return
    const column = columnRef.current
    if (column !== null && !column.contains(document.activeElement)) column.focus()
  }, [assistant])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((!floating && assistant === null) || event.key !== 'Escape' || event.defaultPrevented
      || hasInnerPopup(event.currentTarget, event.target)) return
    event.preventDefault()
    if (floating) onMinimize()
    else onCloseAssistant()
  }
  return (
    <div
      ref={columnRef}
      id={CONVERSATION_COLUMN_ID}
      className={css.centerCol}
      style={dragPoint === null ? undefined : {
        '--layout-floating-left': `${dragPoint.left}px`,
        '--layout-floating-top': `${dragPoint.top}px`,
      } as CSSProperties}
      data-hidden={hidden || undefined}
      data-floating-open={floating || undefined}
      data-floating-dragging={dragPoint !== null || undefined}
      data-page-assistant-track={assistant ?? undefined}
      role={floating || assistant === 'drawer' ? 'dialog' : assistant === 'dock' ? 'complementary' : undefined}
      aria-label={assistant !== null ? assistantLabel : floating ? dialogLabel : undefined}
      tabIndex={assistant === 'drawer' ? -1 : undefined}
      onKeyDown={onKeyDown}
      {...hiddenAttributes}
    >
      <div className={css.floatingHeader} aria-hidden={!floating} {...(!floating ? { inert: '' as const } : {})}>
        <span className={css.floatingTitle} title={title}>{title}</span>
        <button type="button" className={css.floatingGrip} aria-label={dragLabel} title={dragLabel}
          aria-describedby={FLOATING_DOCK_HELP_ID}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag}
          onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} onKeyDown={moveDock}>
          <Icon name="drag-handle" size={16} />
        </button>
        <span id={FLOATING_DOCK_HELP_ID} className={css.dockHelp}>{dragHint}</span>
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
      {assistant !== null && (
        <header className={css.assistantHeader}>
          <h2 className={css.assistantTitle}><IconSparkle16 />{assistantLabel}</h2>
          <Button size="sm" className={css.assistantClose} aria-label={assistantCloseLabel}
            title={assistantCloseLabel} onClick={onCloseAssistant} icon={<IconCloseOutline16 />} />
        </header>
      )}
      <div className={css.conversationBody}>{children}</div>
    </div>
  )
}
