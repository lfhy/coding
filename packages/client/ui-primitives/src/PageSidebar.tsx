import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Icon, type IconName } from 'coding-client-ui-icons'
import css from './PageSidebar.module.css'

/** 宽内容淡出到图标轨落定的延迟；与 150ms 的淡出、300ms 的宽度过渡配套。 */
const COLLAPSE_SETTLE_MS = 150

/**
 * 独立主内容页左侧栏的一个条目。展开时按 `variant` 呈现图标行或缩略图行；
 * 收起后一律退化为 36×36 图标按钮，因此每个条目必须给出语义图标。
 */
export interface PageSidebarItem {
  id: string
  /** 用户可见文案，同时是收起态的悬停提示与可访问名称。 */
  label: string
  icon: IconName
  /** `media` 变体里的缩略图；`rows` 变体忽略该字段。 */
  media?: ReactNode
  active?: boolean
  onSelect?: () => void
}

export interface PageSidebarLabels {
  collapse: string
  expand: string
}

export interface PageSidebarProps {
  /** 整列的可访问名称。 */
  label: string
  /** 展开态标题行文案。 */
  title: string
  items: readonly PageSidebarItem[]
  collapsed: boolean
  onToggle: () => void
  labels: PageSidebarLabels
  /** 行几何：紧凑图标行，或带缩略图的行。宽度与折叠行为两者一致。 */
  variant?: 'rows' | 'media'
  /** 无条目时的说明；收起态不显示。 */
  empty?: string
}

/**
 * 主内容页共享的左侧栏：固定 210px，收起后 56px 图标轨，顶部避让 macOS 交通灯。
 * 页面只提供条目与折叠状态，几何、悬停、焦点与动画由这里统一。
 * @param props - 标题、条目、折叠状态与动作。
 * @returns 展开列或收起轨。
 */
export function PageSidebar({
  label, title, items, collapsed, onToggle, labels, variant = 'rows', empty,
}: PageSidebarProps) {
  // 与对话侧栏同一套折叠时序：宽度先滑动，宽内容就地淡出 150ms，落定后换成图标轨并淡入。
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true
  return (
    <aside
      className={clsx(
        css.shell, collapsed && css.collapsed, collapsed && wide && css.fading,
        !wide && everWide.current && css.railIn,
      )}
      style={{ width: wide ? 210 : 56 }}
      aria-label={label}
    >
      {wide ? (
        <>
          <div className={css.headerRow}>
            <span className={css.sectionLabel}>{title}</span>
            <button type="button" className={css.iconButton} aria-label={labels.collapse} title={labels.collapse} onClick={onToggle}>
              <Icon name="sidebar" size={16} />
            </button>
          </div>
          {items.length === 0 && empty !== undefined
            ? <p className={css.empty}>{empty}</p>
            : (
              <div className={clsx(css.rows, variant === 'media' && css.mediaRows)} role="list">
                {items.map(item => (
                  <button key={item.id} type="button" role="listitem" className={clsx(css.row, variant === 'media' && css.mediaRow)}
                    aria-current={item.active === true ? 'true' : undefined} onClick={item.onSelect}>
                    {variant === 'media' && item.media !== undefined
                      ? <span className={css.mediaBox}>{item.media}</span>
                      : <span className={css.rowIcon} aria-hidden="true"><Icon name={item.icon} size={16} /></span>}
                    <span className={css.rowLabel}>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
        </>
      ) : (
        <>
          {items.map(item => (
            <button key={item.id} type="button" className={css.railButton}
              aria-label={item.label} title={item.label} aria-pressed={item.active === true}
              onClick={item.onSelect}>
              <Icon name={item.icon} size={18} />
            </button>
          ))}
          <div className={css.railDivider} aria-hidden="true" />
          <button type="button" className={css.railButton} aria-label={labels.expand} title={labels.expand} onClick={onToggle}>
            <Icon name="sidebar" size={18} />
          </button>
        </>
      )}
    </aside>
  )
}
