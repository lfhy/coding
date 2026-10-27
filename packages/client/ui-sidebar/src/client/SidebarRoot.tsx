/**
 * 侧边栏壳负责折叠动画、新对话行、交通灯避让和滚动条可见性。展开时第一行是新对话入口，
 * 收起按钮由浏览区域的标题行渲染（壳层通过 owner share 交出动作）；收起的 56px rail 里
 * 新对话图标与展开按钮都排在这一行。折叠动画冻结宽内容，等淡出后再切换到 rail；浏览区域
 * 与页脚仍由各自 slot 占用者绘制。
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Icon, IconNewChatOutline16, Tooltip,
} from 'coding-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import css from './SidebarRoot.module.css'

/** 宽内容卸载延迟；与 150ms 的宽内容淡出对齐。 */
const COLLAPSE_SETTLE_MS = 150

/**
 * 指针离开后栏内滚动条继续绘制的时长。滚动条在这里只是指针可供性：如果在离开事件
 * 当场隐藏，指针只是路过栏边缘（去往会话区或经过 portal 菜单）时滑块就会闪烁。
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * 渲染侧边栏壳：新对话行持有唯一的新建入口，并交出浏览区域标题行要用的收起动作；
 * 欢迎页操作可见时只隐藏重复的工作台面板动作。
 * @param props - 布局 owner、slot、回调与本地化文案。
 * @returns 侧边栏元素树。
 */
export function SidebarRoot({
  collapsed,
  width,
  welcomeActionsVisible,
  startSession,
  toggleSidebar,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  // 折叠动画期间宽内容保持挂载（用 .wide 淡出），落定后卸载，展开时立即重新挂载。
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // 淡出期间把内容冻结在展开宽度（collapsed && wide）：滑动中的列只是裁切它而不是重排；
  // rail 布局（.collapsed 样式）要等淡出落定后才生效。
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // rail 入场只用于实时折叠：刷新后直接处于收起状态时静态渲染 rail，不隐藏图标。
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // 栏内滚动条跟随指针（.quietBars 把它们绑定为透明）：指针在栏内时绘制，离开后继续
  // 保留 SCROLLBAR_LINGER_MS。窗口内返回的指针取消待执行的隐藏，而不是从隐藏状态重来。
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // 离开与否由列的盒子判定，而不是 DOM containment，且只在滑块绘制期内生效：
  // ui-settings 把整屏面板渲染成这一列 fixed 定位的后代，指针移到面板上（或面板关闭后
  // 移到会话区）都不会触发本列的 pointerleave，滑块就会留在没人指向的列上。元素自身的
  // leave 事件仍保留，因为指针离开窗口后不会再产生移动事件，那是几何判定给不出的信号。
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- 监听只在列挂载并可见时存在。 */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.windowDragInset} data-window-drag-inset data-window-drag-region aria-hidden="true" />

      <div className={css.logoRow} data-window-drag-region>
        {/* 品牌位改为新对话入口；rail 中没有文字位置，退化为纯图标控件并保留展开按钮。 */}
        <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide}>
          <button
            type="button"
            className={clsx(css.newSession, css.wide)}
            aria-label={t('session.new.label')}
            onClick={() => { startSession() }}
          >
            <IconNewChatOutline16 size={wide ? 16 : 18} />
            {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
          </button>
        </Tooltip>
        {!welcomeActionsVisible && (
          <div className={css.brandActions}>
            {renderSlot('sidebar.brand.action', { wide })}
          </div>
        )}
        {!wide && (
          <Tooltip label={t('toggle.open')} delayMs={500}>
            <button
              type="button"
              className={clsx(css.iconButton, css.toggle)}
              aria-label={t('toggle.open')}
              onClick={() => { toggleSidebar() }}
            >
              {/* rail 始终提供侧边栏展开入口。 */}
              <Icon name="sidebar" className={css.panelIcon} size={18} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* 浏览区域在两种状态下都填满控件与页脚之间的空间，rail 的图标列走同一个 slot。 */}
      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {
          wide,
          expandSidebar: () => { if (collapsed) toggleSidebar() },
          // 宽侧栏的收起按钮由浏览区域的标题行渲染；已收起时点击不重复收起。
          collapseSidebar: () => { if (!collapsed) toggleSidebar() },
        })}
      </div>

      {/* 页脚动作在两种侧栏宽度下都堆叠在设置之上。 */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', { wide })}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', { wide })}
        </div>
      </div>
    </div>
  )
}
