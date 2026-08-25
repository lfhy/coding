// Menu: minimal controlled dropdown (group-by pickers, project selectors).
// Default: pure CSS positioning relative to the anchor wrapper — no popper.
// Opt-in `portal` renders the list into document.body, fixed-positioned from
// the anchor rect, for anchors inside overflow-clipping containers (sidebar).
// The owner controls `open`; outside-click closing uses one document listener
// active only while open. Submenus open on hover/focus inside the same root.
// Entries also cover non-interactive `label` headings and `danger` rows.
// Lists keep 12px clearance to the viewport's top/bottom edges and scroll
// internally past that; submenu-bearing menus are exempt (see .scrollable).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16 } from './icons/index.tsx'
import { usePointerGrace } from './pointer-grace.ts'
import css from './Menu.module.css'

/** Selectable row (optionally with a nested submenu). */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Leading icon (figma .Menu_cell gap 8). */
  icon?: ReactNode
  /** Destructive row: error-colored text/icon and danger hover fill. */
  danger?: boolean
  /** Nested card opened to the right on hover/focus. */
  submenu?: readonly MenuItem[]
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  type: 'separator'
  id: string
}

/** Non-interactive heading row above a group of items. */
export interface MenuLabel {
  type: 'label'
  id: string
  text: string
}

/** One primary-menu entry: a row, a separator, or a heading label. */
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return 'type' in entry && entry.type === 'label'
}

/** Unplaced portal list: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * 渲染相对锚点定位的下拉菜单。
 * @param props.open - 列表是否显示，由 owner 控制。
 * @param props.anchor - 原位渲染的触发元素。
 * @param props.header - 固定在滚动列表上方的可选非行内容。
 * @param props.items - 可选行与分隔符。
 * @param props.selectedId - 显示为选中的行。
 * @param props.selectedIds - 存在独立选项组时显示为选中的行。
 * @param props.onSelect - 行点击回调；禁用行及仅展开子菜单的父行不会调用。
 * @param props.onClose - 外部点击或 Escape 时调用。
 * @param props.align - 相对锚点的列表对齐方式，默认 start。
 * @param props.side - 在锚点下方（默认 bottom）或上方（top）展开。
 * @param props.portal - 是否渲染到 document.body 并根据锚点矩形固定定位；
 * 适用于祖先 overflow 会裁剪原位列表的场景，默认保留纯 CSS 原位定位。
 * @param props.closeOnPointerLeave - 指针离开触发元素与列表后是否在宽限期关闭；
 * 默认直到外部点击、Escape 或选择才关闭，宽限期允许跨越 4px 间隙后返回。
 * @param props.dense - 在不改变标准字体或卡片宽度的情况下缩小行距。
 * @param props.compact - 使用紧凑的菜单字体与间距。
 * @param props.getAnchorRect - 仅 portal 模式：直接提供锚点矩形，而不是测量
 * Menu 自身 wrapper；当 wrapper 不参与触发元素布局时必须提供。每次打开、
 * 滚动和窗口尺寸变化都会调用；返回 null 会跳过当帧定位。
 * @param props.footer - 固定在可滚动项目区下方、以细线分隔的行。
 * @returns 含条件列表的锚点 wrapper。
 */
export function Menu({ open, anchor, header, items, selectedId, selectedIds, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, dense = false, compact = false, getAnchorRect, footer, className }: {
  open: boolean
  anchor: ReactNode
  header?: ReactNode
  items: readonly MenuEntry[]
  footer?: readonly MenuEntry[]
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  closeOnPointerLeave?: boolean
  dense?: boolean
  compact?: boolean
  getAnchorRect?: () => DOMRect | null
  className?: string
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose)

  // Portal mode: fixed-position the list from the anchor rect before paint;
  // track the anchor while open (capture-phase scroll catches nested panes).
  // getAnchorRect trumps measuring the wrapper span: a child layout effect
  // runs before the parent's, so a wrapper the host positions in its own
  // effect measures stale here — the host callback owns the truth instead.
  useLayoutEffect(() => {
    if (!open || !portal) { setFixedPos(null); return }
    const place = () => {
      let r: DOMRect | null
      if (getAnchorRect !== undefined) {
        r = getAnchorRect()
      } else {
        /* v8 ignore next 2 -- the ref is attached before the layout effect runs and the listeners die with it. */
        r = rootRef.current?.getBoundingClientRect() ?? null
      }
      if (r === null) return
      const MARGIN = 12
      const vw = window.innerWidth
      const vh = window.innerHeight
      const listEl = listRef.current
      const lw = listEl?.offsetWidth ?? 0
      const lh = listEl?.offsetHeight ?? 0

      let x: number
      let y: number
      if (side === 'right') {
        x = r.right + 4
        y = r.top
      } else if (align === 'start') {
        x = r.left
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      } else {
        x = r.right - lw
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      }

      if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN)

      setFixedPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // end/top alignment and clamping use real dimensions before anything
    // paints — no visible jump from a zero-size first guess.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, portal, align, side, getAnchorRect])

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return
      if (listRef.current?.contains(e.target) === true) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  // A close from selection/Escape/outside click outruns a pending grace close;
  // left armed it would shut a list reopened inside the grace window. Its own
  // effect, not the listener effect above: that one re-runs on every `onClose`
  // identity change and would cancel the grace mid-transit.
  useEffect(() => {
    if (!open) cancelClose()
  }, [open, cancelClose])

  // The submenu card is absolutely positioned outside the list box; the
  // scroll clip would crop it, so only submenu-free menus get the height cap.
  const scrollable = !items.some(entry => !isSeparator(entry) && !isLabel(entry) && entry.submenu !== undefined && entry.submenu.length > 0)

  const renderEntry = (entry: MenuEntry) => {
    if (isSeparator(entry)) {
      return <div key={entry.id} className={css.separator} role="separator" />
    }
    if (isLabel(entry)) {
      return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
    }
    const hasSub = entry.submenu !== undefined && entry.submenu.length > 0
    const subOpen = hasSub && openSubmenuId === entry.id
    const selected = entry.id === selectedId || selectedIds?.includes(entry.id) === true
    return (
      <div
        key={entry.id}
        className={css.itemWrap}
        onMouseEnter={() => { setOpenSubmenuId(hasSub ? entry.id : null) }}
        onMouseLeave={() => { setOpenSubmenuId(null) }}
      >
        <button
          type="button"
          role="menuitem"
          className={clsx(css.item, selected && css.selected, entry.danger === true && css.danger)}
          disabled={entry.disabled}
          aria-haspopup={hasSub ? 'menu' : undefined}
          aria-expanded={hasSub ? subOpen : undefined}
          onFocus={() => { setOpenSubmenuId(hasSub ? entry.id : null) }}
          onClick={() => {
            if (hasSub) {
              setOpenSubmenuId(entry.id)
              return
            }
            onSelect(entry.id)
          }}
        >
          {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
          <span className={css.itemLabel}>{entry.label}</span>
          {/* Selection marker is a trailing check (figma .Menu_cell), not a fill. */}
          {selected && <IconCheckOutline16 className={css.check} />}
        </button>
        {subOpen && entry.submenu !== undefined && (
          <div className={clsx(css.submenu, compact && css.compactList)} role="menu">
            {entry.submenu.map(sub => (
              <button
                key={sub.id}
                type="button"
                role="menuitem"
                className={css.item}
                disabled={sub.disabled}
                onClick={() => { onSelect(sub.id) }}
              >
                {sub.icon !== undefined && <span className={css.itemIcon}>{sub.icon}</span>}
                <span className={css.itemLabel}>{sub.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Portal lists render hidden until placed: the placement effect measures
  // this pre-render in the same commit, so the first painted frame is
  // already at the final position (with getAnchorRect returning null the
  // list simply stays hidden).
  const list = open && (
    <div
      ref={listRef}
      className={clsx(css.list, dense && css.denseList, compact && css.compactList, scrollable && css.scrollable, portal && css.portal, side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={portal ? fixedPos ?? MEASURE_STYLE : undefined}
      role="menu"
      // React portals bubble synthetic events through the REACT tree: without
      // this stop, an item click re-fires the anchor row's own onClick
      // (open/toggle) after onSelect.
      onClick={(e) => { e.stopPropagation() }}
    >
      {header !== undefined && <div className={css.header}>{header}</div>}
      <div className={css.viewport} role="presentation">
        {items.map(renderEntry)}
      </div>
      {footer !== undefined && footer.length > 0 && (
        <div className={css.footer} role="presentation">
          {footer.map(renderEntry)}
        </div>
      )}
    </div>
  )

  // Pointer-leave dismissal watches the WRAPPER, not the list: React's
  // enter/leave traversal runs over the React tree, so trigger and portaled
  // list are one region here. Aiming back at the trigger, or crossing the 4px
  // gap between them, therefore never counts as leaving.
  return (
    <span
      ref={rootRef}
      className={clsx(css.root, className)}
      onPointerEnter={closeOnPointerLeave ? cancelClose : undefined}
      onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose() } : undefined}
    >
      {anchor}
      {portal ? (list !== false && createPortal(list, document.body)) : list}
    </span>
  )
}
