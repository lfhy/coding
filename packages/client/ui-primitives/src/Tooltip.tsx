// 悬停与焦点说明泡泡使用固定定位，避免被侧栏图标轨的溢出裁切。
// 子元素本身是锚点；cloneElement 不增加布局节点，展开时才读取锚点位置。
// TODO: 箭头与复杂碰撞避让仍未实现，当前仅处理水平边界和上下翻转。

import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, MutableRefObject, ReactElement, Ref } from 'react'
import css from './Tooltip.module.css'

/** 提示泡泡相对锚点的方向。 */
export type TooltipSide = 'right' | 'bottom' | 'top'

/** Tooltip 注入到子锚点的事件；先执行子元素原有的处理器。 */
interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onClick?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

type TooltipLabel = string | (() => string)

/**
 * 将悬停或聚焦提示附着到单个锚点；点击后隐藏，重新悬停或重新聚焦才再次显示。
 * @param props.label - 提示文案或仅在可见时求值的文案函数。
 * @param props.side - 相对锚点的位置，默认向右。
 * @param props.delayMs - 悬停显示的延迟毫秒数，键盘聚焦不等待。
 * @param props.disabled - 禁止显示，但不重挂锚点以免中断其动效。
 * @param props.maxWidth - 长文案可选的像素宽度上限。
 * @param props.children - 单个锚点，原 ref 与事件回调保持可用。
 * @returns 锚点与可见时固定定位的提示泡泡。
 */
export function Tooltip({ label, side = 'right', delayMs = 0, disabled = false, maxWidth, children }: { label: TooltipLabel; side?: TooltipSide; delayMs?: number; disabled?: boolean; maxWidth?: number; children: ReactElement<AnchorProps> }) {
  const anchor = useRef<HTMLElement | null>(null)
  // React 18 的 ref 不在元素 props 内；合并 ref 以保留调用方的锚点引用。
  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = el
  }, [childRef])
  // 使用锚点两条边重新计算翻转后的纵坐标，避免沿用旧位置。
  const [pos, setPos] = useState<{ x: number; top: number; bottom: number } | null>(null)
  // 实际位置可能因视口空间不足而与请求方向不同。
  const [placement, setPlacement] = useState<TooltipSide>(side)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const resolvedLabel = pos === null
    ? null
    : typeof label === 'function' ? label() : label
  const y = pos === null
    ? 0
    : placement === 'right'
      ? pos.top + (pos.bottom - pos.top) / 2
      : placement === 'top' ? pos.top - 8 : pos.bottom + 8
  const EDGE_MARGIN = 12
  // 固定定位不提供边界约束：水平移入视口，垂直方向只在另一侧容得下时翻转。
  // 每次先用原始位置测量，文案或窗口变化后即可释放旧偏移。
  useLayoutEffect(() => {
    if (pos === null) return
    const fit = () => {
      const el = bubble.current
      /* v8 ignore next -- 提示可见时泡泡一定已挂载。 */
      if (el === null) return
      el.style.left = `${pos.x}px`
      const r = el.getBoundingClientRect()
      let dx = 0
      if (r.right > window.innerWidth - EDGE_MARGIN) dx = window.innerWidth - EDGE_MARGIN - r.right
      if (r.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - r.left
      el.style.left = `${pos.x + dx}px`
      if (side === 'right') return
      // 两侧都容不下时维持请求的位置，避免反复翻转。
      const fitsBelow = pos.bottom + 8 + r.height <= window.innerHeight - EDGE_MARGIN
      const fitsAbove = pos.top - 8 - r.height >= EDGE_MARGIN
      if (placement === 'bottom' && !fitsBelow && fitsAbove) setPlacement('top')
      if (placement === 'top' && !fitsAbove && fitsBelow) setPlacement('bottom')
    }
    fit()
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit) }
  }, [placement, pos, resolvedLabel, side])
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 悬停与键盘焦点相互独立；点击后由调用方的页面动作恢复焦点时，仍需压住刚点击的提示。
  const triggers = useRef({ hover: false, focus: false, clicked: false, clickFocused: false })

  // 操作期间禁用锚点时不会收到 mouseleave，需立即撤回已显示的提示。
  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])
  useEffect(() => {
    if (disabled) {
      cancelShow()
      triggers.current = { hover: false, focus: false, clicked: false, clickFocused: false }
      setPos(null)
    }
    return cancelShow
  }, [cancelShow, disabled])

  const show = () => {
    if (disabled) return
    const el = anchor.current
    /* v8 ignore next -- 事件只会由已有 ref 的克隆锚点发出。 */
    if (el === null) return
    const r = el.getBoundingClientRect()
    // 每次从请求方向开始，位置测量负责必要时翻转。
    setPlacement(side)
    setPos({ x: side === 'right' ? r.right + 10 : r.left + r.width / 2, top: r.top, bottom: r.bottom })
  }
  const showAfterHoverDelay = () => {
    cancelShow()
    if (delayMs <= 0) {
      show()
      return
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      show()
    }, delayMs)
  }
  const hide = () => {
    cancelShow()
    if (!triggers.current.hover && !triggers.current.focus) setPos(null)
  }

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        onMouseEnter: (e) => {
          children.props.onMouseEnter?.(e)
          triggers.current.hover = true
          if (!triggers.current.focus) triggers.current.clicked = false
          if (!triggers.current.clicked) showAfterHoverDelay()
        },
        onMouseLeave: (e) => {
          children.props.onMouseLeave?.(e)
          triggers.current.hover = false
          cancelShow()
          setPos(null)
        },
        onFocus: (e) => {
          children.props.onFocus?.(e)
          triggers.current.focus = true
          if (!triggers.current.clicked) { cancelShow(); show() }
        },
        onBlur: (e) => {
          children.props.onBlur?.(e)
          triggers.current.focus = false
          if (!triggers.current.clickFocused) triggers.current.clicked = false
          triggers.current.clickFocused = false
          hide()
        },
        onClick: (e) => {
          children.props.onClick?.(e)
          triggers.current.clicked = true
          // 鼠标点击聚焦的入口稍后因切页失焦、再恢复焦点时，仍不重现提示。
          triggers.current.clickFocused = triggers.current.focus
          cancelShow()
          setPos(null)
        },
      })}
      {pos !== null && (
        <span
          ref={bubble}
          className={css.bubble}
          data-side={placement}
          style={{ left: pos.x, top: y, ...maxWidth === undefined ? {} : { maxWidth } }}
          role="tooltip"
        >
          {resolvedLabel}
        </span>
      )}
    </>
  )
}
