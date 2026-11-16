/** 窗口级外壳包裹原布局；导航动作复用布局 store，不重建会话或工作台。 */
import { Button, Icon, Tooltip } from 'coding-client-ui-primitives'
import type { PropsRenderSlots } from 'coding-client-ui-slots'
import { AppFrame } from './AppFrame.tsx'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './WindowShell.module.css'

/** 外壳与内层共用根注册，只在外层增加底部设置的渲染权限。 */
export type WindowShellProps = Omit<AppFrameProps, 'renderSlot' | '__renders'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'workbench' | 'workbench.bottom'
    | 'shell.overlay' | 'shell.page' | 'shell.navigation.entry' | 'shell.settings'>

/**
 * 渲染全局导航和常驻的内层布局；内层顶到窗口上沿，原生窗口按钮由内层各自避让。
 * @param props - 根 slot 派生的布局、会话与本地化能力，原样交给 AppFrame。
 * @returns 固定一屏的窗口外壳；仅内层内容区域拥有滚动。
 */
export function WindowShell(props: WindowShellProps) {
  const current = props.useSessions(state => state.current)
  const conversationVisible = props.useStore(state => state.page === null)
  const sidebarCollapsed = props.useStore(state => state.narrow ? !state.narrowExpanded : state.sidebar === 0)

  return (
    <div className={css.shell} data-window-shell>
      <div className={css.titleDragInset} data-window-drag-region aria-hidden="true" />
      {/* 仅桌面窗口显示：靠近交通灯，操作的是与页内侧栏共用的根布局状态。 */}
      <div className={css.desktopSidebarToggle}>
        <Tooltip label={props.t(sidebarCollapsed ? 'shell.sidebar.expand' : 'shell.sidebar.collapse')} delayMs={500}>
          <span className={css.sidebarToggleAnchor}>
            <Button size="sm" className={css.sidebarToggleButton}
              aria-label={props.t(sidebarCollapsed ? 'shell.sidebar.expand' : 'shell.sidebar.collapse')}
              onClick={() => { props.actions.toggleSidebar() }}>
              <Icon name="sidebar" size={18} />
            </Button>
          </span>
        </Tooltip>
      </div>
      <nav className={css.navigation} aria-label={props.t('shell.navigation')}>
        <Tooltip label={props.t('shell.conversation')} delayMs={500}>
          <span className={css.navAnchor}>
            <Button
              className={css.navButton}
              aria-label={props.t('shell.conversation')}
              aria-current={conversationVisible ? 'page' : undefined}
              onClick={() => {
                props.actions.closePage()
                if (current !== undefined) props.actions.requestShowConversation(current)
              }}
            >
              <Icon name="home" size={20} />
            </Button>
          </span>
        </Tooltip>
        {/* 中部入口自带紧凑图标按钮，与主页图标同列；底部设置仍贴住导航栏下沿。 */}
        {props.renderSlot('shell.navigation.entry', {})}
        <div className={css.settings}>
          {props.renderSlot('shell.settings', { wide: false })}
        </div>
      </nav>
      <div className={css.surface} data-window-content>
        <AppFrame {...props} />
      </div>
    </div>
  )
}
