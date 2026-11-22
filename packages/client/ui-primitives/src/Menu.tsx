/** 受控下拉菜单。`portal` 模式固定于视口，适用于侧栏等会裁剪浮层的容器。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16, IconChevronRightOutline14 } from 'coding-client-ui-icons'
import { usePointerGrace } from './pointer-grace.ts'
import css from './Menu.module.css'

/** 可选择的菜单行，可带子菜单或独立的行尾动作。 */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** 行首图标，与文字间隔 8px。 */
  icon?: ReactNode
  /** 危险操作使用错误色文字和图标，并在悬停时显示危险底色。 */
  danger?: boolean
  /** 悬停或激活父项时展开的侧菜单。 */
  submenu?: readonly MenuItem[]
  /** 独立于行选择的行尾图标按钮；禁用行也会禁用该动作。 */
  action?: { id: string; label: string; icon: ReactNode; disabled?: boolean }
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

/** 尚未定位时隐藏菜单，但保留布局以便测量。 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }
const VIEWPORT_MARGIN = 12
const SUBMENU_GAP = 6
const SUBMENU_WIDTH = 164

type MenuPosition = { style: CSSProperties; submenuLeft: boolean }

function focusableItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? [])]
    .filter(item => item.closest('[role="menu"]') === menu)
}

/**
 * 渲染相对锚点定位的下拉菜单。
 * @param props.open - 列表是否显示，由 owner 控制。
 * @param props.anchor - 原位渲染的触发元素。
 * @param props.anchorRef - 外置触发器：anchor 为 null、由 owner 单独渲染触发元素时，
 * 传入该元素的 ref。它的位置仍由 getAnchorRect 提供，点击它（含再次点击收起）
 * 不被当作外部点击。不传则只有 anchor 子树与列表内部免于关闭。
 * @param props.header - 固定在滚动列表上方的可选非行内容。
 * @param props.items - 可选行与分隔符。
 * @param props.selectedId - 显示为选中的行。
 * @param props.selectedIds - 存在独立选项组时显示为选中的行。
 * @param props.multiSelect - 选项允许同时选中时使用复选菜单项语义；其状态由 selectedIds 提供。
 * @param props.highlightSelected - 为已选行填充业务强调底色，默认只显示行尾勾选。
 * @param props.onSelect - 行或独立行尾动作的 id 点击回调；禁用项及仅展开子菜单的父行不会调用。
 * @param props.onClose - 外部点击或 Escape 时调用。
 * @param props.align - 相对锚点的列表对齐方式，默认 start。
 * @param props.side - 在锚点下方（默认 bottom）或上方（top）展开。
 * @param props.portal - 是否渲染到 document.body 并根据锚点矩形固定定位；
 * 适用于祖先 overflow 会裁剪原位列表的场景，默认保留纯 CSS 原位定位。
 * @param props.portalContainer - portal 菜单的目标节点；模态框内使用其对话框节点，使选项仍在无障碍子树中。
 * @param props.matchAnchorWidth - portal 菜单与锚点等宽，且不超出视口边距。
 * @param props.keyboardNavigation - 打开时聚焦已选或首个选项。方向键在当前层导航，右键进入子菜单，左键或 Escape 返回父项。
 * @param props.closeOnPointerLeave - 指针离开触发元素与列表后是否在宽限期关闭；
 * 默认直到外部点击、Escape 或选择才关闭，宽限期允许跨越 4px 间隙后返回。
 * @param props.dense - 在不改变标准字体或卡片宽度的情况下缩小行距。
 * @param props.compact - 使用紧凑的菜单字体与间距。
 * @param props.getAnchorRect - 仅 portal 模式：直接提供锚点矩形，而不是测量
 * Menu 自身 wrapper；当 wrapper 不参与触发元素布局时必须提供。每次打开、
 * 滚动和窗口尺寸变化都会调用；返回 null 会跳过当帧定位。
 * @param props.footer - 固定在可滚动项目区下方、以细线分隔的行。
 * @param props.maxHeight - 卡片的最大高度（px）；超出部分在项目区内部滚动，
 * 页头与页脚保持固定。未设置时沿用「短于视口」的默认行为。含子菜单的菜单
 * 会因裁剪裁掉侧卡片，不适合使用本属性。
 * @returns 含条件列表的锚点 wrapper。
 */
export function Menu({ open, anchor, header, items, selectedId, selectedIds, multiSelect = false, highlightSelected = false, onSelect, onClose, align = 'start', side = 'bottom', portal = false, portalContainer, matchAnchorWidth = false, keyboardNavigation = false, closeOnPointerLeave = false, dense = false, compact = false, getAnchorRect, anchorRef, footer, maxHeight, className }: {
  open: boolean
  anchor: ReactNode
  header?: ReactNode
  items: readonly MenuEntry[]
  footer?: readonly MenuEntry[]
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  multiSelect?: boolean
  highlightSelected?: boolean
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  portalContainer?: Element | null
  matchAnchorWidth?: boolean
  keyboardNavigation?: boolean
  closeOnPointerLeave?: boolean
  dense?: boolean
  compact?: boolean
  getAnchorRect?: () => DOMRect | null
  anchorRef?: RefObject<HTMLElement | null> | undefined
  maxHeight?: number
  className?: string
}) {
  const menuId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [fixedPos, setFixedPos] = useState<MenuPosition | null>(null)
  const focusedOpenRef = useRef(false)
  const enterSubmenuRef = useRef(false)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose)
  const selectionKey = selectedIds?.join('\u0000') ?? selectedId ?? ''
  const hasSubmenu = [...items, ...(footer ?? [])].some(entry =>
    !isSeparator(entry) && !isLabel(entry) && (entry.submenu?.length ?? 0) > 0)

  // 父组件可能在自身布局效果中才移动锚点；此时以 getAnchorRect 为准，不测量旧位置。
  useLayoutEffect(() => {
    if (!open || !portal) { setFixedPos(null); return }
    const place = () => {
      let r: DOMRect | null
      if (getAnchorRect !== undefined) {
        r = getAnchorRect()
      } else {
        /* v8 ignore next 2 -- 布局效果执行前已绑定 ref，卸载时同步移除监听器。 */
        r = rootRef.current?.getBoundingClientRect() ?? null
      }
      if (r === null) return
      const margin = VIEWPORT_MARGIN
      const vw = window.innerWidth
      const vh = window.innerHeight
      const listEl = listRef.current
      const space = vw - margin * 2
      const submenuWidth = Math.min(SUBMENU_WIDTH, Math.floor((space - SUBMENU_GAP) / 2))
      const reserve = hasSubmenu ? submenuWidth + SUBMENU_GAP : 0
      const lw = matchAnchorWidth ? Math.min(r.width, space - reserve) : listEl?.offsetWidth ?? 0
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

      let submenuLeft = false
      if (lw > 0) {
        const rightLimit = vw - lw - margin
        x = Math.min(Math.max(x, margin), rightLimit)
        if (hasSubmenu) {
          // 一级菜单打开时就为侧卡片留空间，切换新建／导入时锚点不会跳动。
          const withRightRoom = Math.min(x, rightLimit - reserve)
          const withLeftRoom = Math.max(x, margin + reserve)
          submenuLeft = withLeftRoom - x < x - withRightRoom
          x = submenuLeft ? withLeftRoom : withRightRoom
        }
      }
      if (lh > 0) y = Math.min(Math.max(y, margin), vh - lh - margin)

      setFixedPos({ style: { left: x, top: y, ...matchAnchorWidth ? { width: lw } : {} }, submenuLeft })
    }
    // 在首次绘制前测量隐藏的菜单，避免用户看到其从测量原点跳至锚点。
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' || rootRef.current === null
      ? null : new ResizeObserver(place)
    if (rootRef.current !== null) observer?.observe(rootRef.current)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, portal, align, side, matchAnchorWidth, getAnchorRect, selectionKey, hasSubmenu])

  useLayoutEffect(() => {
    const submenu = submenuRef.current
    const row = submenu?.parentElement
    if (submenu === null || row == null) return
    if (portal && fixedPos !== null) {
      const rowTop = row.getBoundingClientRect().top
      const bottomLimit = window.innerHeight - VIEWPORT_MARGIN - submenu.offsetHeight
      const top = Math.max(VIEWPORT_MARGIN, Math.min(rowTop, bottomLimit))
      submenu.style.top = `${top - rowTop}px`
    }
    if (enterSubmenuRef.current) {
      enterSubmenuRef.current = false
      focusableItems(submenu)[0]?.focus({ preventScroll: true })
    }
  }, [openSubmenuId, portal, fixedPos])

  useEffect(() => {
    if (!open) { focusedOpenRef.current = false; return }
    // portal 列表首帧先隐藏供测量，待定位后才可取得浏览器焦点。
    if (!keyboardNavigation || focusedOpenRef.current || (portal && fixedPos === null)) return
    const items = focusableItems(listRef.current)
    const checked = items.find(item => item.getAttribute('aria-checked') === 'true')
    const target = checked ?? items[0]
    target?.focus({ preventScroll: true })
    focusedOpenRef.current = target !== undefined
  }, [open, keyboardNavigation, portal, fixedPos])

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      enterSubmenuRef.current = false
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      // The portaled list is outside the anchor subtree; check both, plus the
      // owner's external trigger when the menu does not render its own.
      if (rootRef.current?.contains(e.target) === true) return
      if (listRef.current?.contains(e.target) === true) return
      if (anchorRef?.current?.contains(e.target) === true) return
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

  const activateSubmenu = (id: string, enter: boolean) => {
    if (enter && openSubmenuId === id) {
      focusableItems(submenuRef.current)[0]?.focus({ preventScroll: true })
    } else {
      enterSubmenuRef.current = enter
      setOpenSubmenuId(id)
    }
  }

  const renderAction = (entry: MenuItem, topLevel: boolean) => {
    const action = entry.action
    if (action === undefined) return null
    return (
      <button
        type="button"
        role="menuitem"
        className={css.itemAction}
        aria-label={action.label}
        title={action.label}
        disabled={entry.disabled || action.disabled}
        onMouseEnter={topLevel ? () => { setOpenSubmenuId(null) } : undefined}
        onFocus={topLevel ? () => { setOpenSubmenuId(null) } : undefined}
        onClick={() => { onSelect(action.id) }}
      >
        <span aria-hidden="true">{action.icon}</span>
      </button>
    )
  }

  const renderSubmenuPrimary = (sub: MenuItem) => (
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
  )

  const renderEntry = (entry: MenuEntry) => {
    if (isSeparator(entry)) {
      return <div key={entry.id} className={css.separator} role="separator" />
    }
    if (isLabel(entry)) {
      return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
    }
    const hasSub = (entry.submenu?.length ?? 0) > 0
    const subOpen = hasSub && openSubmenuId === entry.id
    const selected = entry.id === selectedId || selectedIds?.includes(entry.id) === true
    const labelId = hasSub ? `${menuId}-${entry.id}` : undefined
    return (
      <div
        key={entry.id}
        className={clsx(css.itemWrap, entry.action !== undefined && css.itemWrapWithAction)}
        onMouseEnter={() => { setOpenSubmenuId(hasSub && !entry.disabled ? entry.id : null) }}
        onMouseLeave={() => {
          if (keyboardNavigation && submenuRef.current?.contains(document.activeElement)) return
          setOpenSubmenuId(null)
        }}
      >
        <button
          id={labelId}
          type="button"
          role={multiSelect ? 'menuitemcheckbox' : 'menuitem'}
          className={clsx(css.item, selected && css.selected, selected && highlightSelected && css.selectedHighlight,
            entry.danger === true && css.danger)}
          disabled={entry.disabled}
          aria-haspopup={hasSub ? 'menu' : undefined}
          aria-expanded={hasSub ? subOpen : undefined}
          aria-checked={multiSelect ? selected : undefined}
          onFocus={() => {
            setOpenSubmenuId(current => hasSub && (!keyboardNavigation || current === entry.id) ? entry.id : null)
          }}
          onKeyDown={hasSub && keyboardNavigation ? (event) => {
            if (event.key !== 'ArrowRight') return
            event.preventDefault()
            activateSubmenu(entry.id, true)
          } : undefined}
          onClick={(event) => {
            if (hasSub) {
              activateSubmenu(entry.id, keyboardNavigation && event.detail === 0)
              return
            }
            onSelect(entry.id)
          }}
        >
          {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
          <span className={css.itemLabel}>{entry.label}</span>
          {/* 选中标记留在主按钮行尾，不代替底色。 */}
          {selected && <IconCheckOutline16 className={css.check} />}
          {hasSub && <IconChevronRightOutline14 className={clsx(css.submenuArrow, fixedPos?.submenuLeft && css.submenuArrowLeft)} />}
        </button>
        {renderAction(entry, true)}
        {subOpen && entry.submenu !== undefined && (
          <div ref={submenuRef} className={clsx(css.submenu, compact && css.compactList,
            fixedPos?.submenuLeft && css.submenuLeft)} role="menu" aria-labelledby={labelId}>
            <div className={css.viewport} role="presentation">
              {entry.submenu.map(sub => (
                sub.action === undefined ? (
                  renderSubmenuPrimary(sub)
                ) : (
                  <div key={sub.id} className={clsx(css.itemWrap, css.itemWrapWithAction)}>
                    {renderSubmenuPrimary(sub)}
                    {renderAction(sub, false)}
                  </div>
                )
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const list = open && (
    <div
      ref={listRef}
      className={clsx(css.list, dense && css.denseList, compact && css.compactList, hasSubmenu ? css.hasSubmenu : css.scrollable,
        portal && css.portal, matchAnchorWidth && css.matchAnchorWidth,
        side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={{
        ...portal ? fixedPos?.style ?? MEASURE_STYLE : {},
        ...hasSubmenu ? { '--menu-submenu-width': `min(${SUBMENU_WIDTH}px, calc((100vw - ${2 * VIEWPORT_MARGIN + SUBMENU_GAP}px) / 2))`,
          '--menu-submenu-gap': `${SUBMENU_GAP}px` } as CSSProperties : {},
        // 限高同时收敛到视口内：短视口下卡片仍留出与定位相同的 12px 边距。
        ...maxHeight === undefined ? {} : { maxHeight: `min(${maxHeight}px, calc(100vh - 24px))` },
      }}
      role="menu"
      onKeyDown={keyboardNavigation ? (event) => {
        const active = document.activeElement
        const level = active?.closest<HTMLElement>('[role="menu"]') ?? listRef.current
        const items = focusableItems(level)
        const current = items.findIndex(item => item === active)
        let next: number
        switch (event.key) {
          case 'ArrowDown': next = (current + 1) % items.length; break
          case 'ArrowUp': next = (current - 1 + items.length) % items.length; break
          case 'Home': next = 0; break
          case 'End': next = items.length - 1; break
          case 'Escape':
          case 'ArrowLeft':
            if (level === null || level !== submenuRef.current) return
            event.preventDefault()
            event.stopPropagation()
            level.parentElement?.querySelector('button')?.focus({ preventScroll: true })
            setOpenSubmenuId(null)
            return
          case 'Tab':
            event.preventDefault()
            onClose()
            rootRef.current?.querySelector('button')?.focus({ preventScroll: true })
            return
          default: return
        }
        if (items.length === 0) return
        event.preventDefault()
        items[next]?.focus({ preventScroll: true })
      } : undefined}
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
      {portal ? (list !== false && createPortal(list, portalContainer ?? document.body)) : list}
    </span>
  )
}
