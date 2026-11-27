import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Icon, type IconName } from 'coding-client-ui-icons'
import css from './SidebarRoot.module.css'

/** 宽内容淡出到图标轨落定的延迟；与 150ms 的淡出、300ms 的宽度过渡配套。 */
const COLLAPSE_SETTLE_MS = 150

/**
 * 主内容侧栏的一个条目。展开时按 `variant` 呈现图标行或缩略图行；
 * 收起后一律退化为 36×36 图标按钮，因此每个条目必须给出语义图标。
 */
export interface SidebarRootItem {
  id: string
  /** 用户可见文案，同时是收起态的悬停提示与可访问名称。 */
  label: string
  icon: IconName
  /** 可选的图标语义色；只着色图标，不影响文字和选中底色。 */
  iconTone?: 'amber' | 'green' | 'blue' | 'violet'
  /** `media` 变体里的缩略图；`rows` 变体忽略该字段。 */
  media?: ReactNode
  /** 摘要行右侧的一小段元数据。 */
  meta?: string
  /** 展开态的行尾按钮；悬停或键盘聚焦时替代元数据，独立于主按钮。 */
  actions?: ReactNode
  active?: boolean
  onSelect?: () => void
  /** 条目是否可作为拖拽源；展开与收起态使用同一套拖拽事件。 */
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void
  /** 拖拽投放位置；`inside` 用于目录，前后位置用于同级排序。 */
  dropPosition?: 'before' | 'after' | 'inside'
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDragLeave?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  /** 右键菜单入口；调用方负责根据事件位置打开上下文操作。 */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void
  /** 树形条目的缩进层级（0 起）；非树条目缺省 0。 */
  depth?: number
  /** 目录行：图标前渲染展开箭头，点击只切换展开状态。 */
  folder?: boolean
  /** 目录行的展开状态，驱动箭头朝向与 `aria-expanded`。 */
  open?: boolean
}

export interface SidebarRootProps {
  /** 整列的可访问名称。 */
  label: string
  /** 展开态标题行文案。 */
  title: string
  items: readonly SidebarRootItem[]
  /** 收起态图标轨条目；缺省复用展开条目，传空数组可隐藏整条文件轨。 */
  railItems?: readonly SidebarRootItem[]
  collapsed: boolean
  /** 对话侧栏的实际宽度，由根布局计算；收起时为 56px。 */
  width: number
  /** 行几何：紧凑图标行、带元数据的摘要行，或带缩略图的行。 */
  variant?: 'rows' | 'media' | 'summary'
  /** 无条目时的说明；收起态不显示。 */
  empty?: string
  /**
   * 标题行之上的页面自有入口（如画图的三子页切换、对话侧栏的新建对话行）。
   * 宽度、安全区与折叠动画仍由本组件持有；展开与收起时的呈现由调用方按 `collapsed` 自行切换。
   */
  header?: ReactNode
  /** 标题同行的紧凑动作；收起后保留在图标轨顶部，调用方提供无障碍名称。 */
  headerAction?: ReactNode
  /** 标题下方的搜索或筛选；始终位于滚动区域之外。 */
  toolbar?: ReactNode
}

/**
 * 主内容页共享的侧栏根：跟随对话侧栏实际宽度，收起后 56px 图标轨，顶部避让 macOS 交通灯。
 * 页面只提供条目与折叠状态，几何、悬停、焦点与动画由这里统一。
 * @param props - 标题、条目、折叠状态与动作。
 * @returns 展开列或收起轨。
 */
export function SidebarRoot({
  label, title, items, railItems, collapsed, width, variant = 'rows', empty, header, headerAction, toolbar,
}: SidebarRootProps) {
  // 与对话侧栏同一套折叠时序：宽度先滑动，宽内容就地淡出 150ms，落定后换成图标轨并淡入。
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled
  // 折叠过程中冻结原展开内容的宽度，图标轨入场后再使用当前宽度。
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true
  return (
    <aside
      className={clsx(
        css.shell, !wide && css.collapsed, collapsed && wide && css.fading,
        !wide && everWide.current && css.railIn,
      )}
      style={{ width: wide && collapsed ? lastWideWidth.current : width }}
      aria-label={label}
      data-variant={variant}
    >
      {header}
      {(wide || headerAction !== undefined) && (
        <div className={clsx(css.headerRow, !wide && css.railHeader)}>
          {wide && <span className={css.sectionLabel} title={title}>{title}</span>}
          {headerAction}
        </div>
      )}
      {wide && toolbar}
      <div className={css.viewport}>
        {wide ? (
          items.length === 0 && empty !== undefined
            ? <p className={css.empty}>{empty}</p>
            : (
              <div className={clsx(css.rows, variant === 'media' && css.mediaRows)} role="list">
                {items.map((item) => {
                  const meta = variant === 'summary' && item.meta !== undefined ? <span className={css.summaryMeta}>{item.meta}</span> : null
                  const row = (
                    <button key={item.id} type="button" role={item.actions == null ? 'listitem' : undefined} title={item.label}
                      className={clsx(css.row, variant === 'media' && css.mediaRow, variant === 'summary' && css.summaryRow)}
                      style={{ '--tree-depth': item.depth ?? 0 } as CSSProperties}
                      aria-current={item.active === true ? 'true' : undefined} data-icon-tone={item.iconTone}
                      aria-expanded={item.folder ? item.open === true : undefined} onClick={item.onSelect}
                      draggable={item.draggable === true}
                      onDragStart={item.onDragStart} onDragEnd={item.onDragEnd}
                      data-drop-position={item.actions == null ? item.dropPosition : undefined}
                      onDragOver={item.actions == null ? item.onDragOver : undefined}
                      onDragLeave={item.actions == null ? item.onDragLeave : undefined}
                      onDrop={item.actions == null ? item.onDrop : undefined}
                      onContextMenu={item.onContextMenu}>
                      {(item.folder || variant === 'summary') && (
                        <span className={css.chevronSlot} aria-hidden="true">
                          {item.folder && <span className={css.chevron} data-open={item.open ? '' : undefined} />}
                        </span>
                      )}
                      {variant === 'media' && item.media !== undefined
                        ? <span className={css.mediaBox}>{item.media}</span>
                        : <span className={css.rowIcon} aria-hidden="true"><Icon name={item.icon} size={16} /></span>}
                      <span className={css.rowLabel}>{item.label}</span>
                      {item.actions == null && meta}
                    </button>
                  )
                  return item.actions == null ? row : (
                    <div key={item.id} role="listitem" className={css.rowSeat}
                      data-drop-position={item.dropPosition}
                      onDragOver={item.onDragOver} onDragLeave={item.onDragLeave} onDrop={item.onDrop}>
                      {row}
                      <div className={css.rowEnd}>
                        <div className={css.rowActions}>{item.actions}</div>
                        {meta}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
        ) : (
          <div className={css.rail}>
            {(railItems ?? items).filter(item => !item.folder).map(item => (
              <button key={item.id} type="button" className={css.railButton}
                aria-label={item.label} title={item.label} aria-pressed={item.active === true} data-icon-tone={item.iconTone}
                onClick={item.onSelect} draggable={item.draggable === true}
                onDragStart={item.onDragStart} onDragEnd={item.onDragEnd}
                data-drop-position={item.dropPosition}
                onDragOver={item.onDragOver} onDragLeave={item.onDragLeave} onDrop={item.onDrop}
                onContextMenu={item.onContextMenu}>
                <Icon name={item.icon} size={18} />
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
