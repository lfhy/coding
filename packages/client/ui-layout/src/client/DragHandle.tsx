import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import css from './AppFrame.module.css'

const KEYBOARD_STEP = 16

type DragOrientation = 'vertical' | 'horizontal'
type DragSide = 'sidebar' | 'details' | 'workbench' | 'bottom' | 'assistant'

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
 * 可访问的尺寸分隔条。移动按帧合并；取消、失焦或卸载时清理指针和待处理帧。
 * @param props - 面板尺寸边界、方向和拖拽事务回调。
 * @returns 可拖动及键盘调整的分隔条。
 */
export function DragHandle(props: DragHandleProps) {
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
