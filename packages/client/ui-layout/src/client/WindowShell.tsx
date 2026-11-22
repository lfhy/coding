/** 窗口级外壳包裹原布局；导航动作复用布局 store，不重建会话或工作台。 */
import { useState } from 'react'
import {
  Button,
  Icon,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconDarkOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  Tooltip,
} from 'coding-client-ui-primitives'
import type { PropsRenderSlots } from 'coding-client-ui-slots'
import { AppFrame } from './AppFrame.tsx'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './WindowShell.module.css'

const THEME_ICONS = { light: IconLightOutline16, dark: IconDarkOutline16, system: IconFollowsystemOutline16 }

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
  const returnToDifferentSession = props.useStore(state => state.page?.returnSessionId !== undefined)
  const sidebarCollapsed = props.useStore(state => state.narrow ? !state.narrowExpanded : state.sidebar === 0)
  const preference = props.useTheme(state => state.preference)
  const themeScheme = props.useTheme(state => state.active.colorScheme)
  // 只记本轮第二个手动档位；系统配色中途改变也不会跳过它。
  const [followSystemAfter, setFollowSystemAfter] = useState<'light' | 'dark'>()
  if (followSystemAfter !== undefined && followSystemAfter !== preference) setFollowSystemAfter(undefined)
  const nextTheme = preference === followSystemAfter ? 'system' : themeScheme === 'dark' ? 'light' : 'dark'
  const themeLabel = props.t(`shell.theme.${nextTheme}`)
  const ThemeIcon = THEME_ICONS[nextTheme]
  const toggleLabel = props.t(sidebarCollapsed ? 'shell.sidebar.expand' : 'shell.sidebar.collapse')

  return (
    <div className={css.shell} data-window-shell>
      <div className={css.titleDragInset} data-window-drag-region aria-hidden="true" />
      <nav className={css.navigation} aria-label={props.t('shell.navigation')}>
        <Tooltip label={props.t('shell.conversation')} delayMs={500}>
          <span className={css.navAnchor}>
            <Button
              className={css.navButton}
              aria-label={props.t('shell.conversation')}
              aria-current={conversationVisible ? 'page' : undefined}
              onClick={() => {
                // 页面关闭后归还原会话；全屏工作台的同会话对话仍可展开浮窗。
                if (!conversationVisible) {
                  props.actions.closePage()
                  if (current !== undefined && !returnToDifferentSession) props.actions.requestShowConversation(current)
                  return
                }
                if (current !== undefined) props.actions.requestShowConversation(current)
              }}
            >
              <Icon name="home" size={20} />
            </Button>
          </span>
        </Tooltip>
        {/* 中部入口自带紧凑图标按钮，与主页图标同列；底部依次提供侧栏开关、主题切换和设置入口。 */}
        {props.renderSlot('shell.navigation.entry', {})}
        {/* 侧栏开关固定在导航列底部：既不压在交通灯上，收起后也不落进内容区；
            桌面端与普通 Web 共用这一枚，页内不再渲染第二枚。 */}
        <div className={css.footer}>
          <div className={css.sidebarToggle}>
            <Tooltip label={toggleLabel} delayMs={500}>
              <span className={css.sidebarToggleAnchor}>
                <Button className={css.sidebarToggleButton} aria-label={toggleLabel}
                  onClick={() => { props.actions.toggleSidebar() }}>
                  {sidebarCollapsed ? <IconChevronRightOutline14 size={18} /> : <IconChevronLeftOutline14 size={18} />}
                </Button>
              </span>
            </Tooltip>
          </div>
          <div className={css.themeToggle}>
            <Tooltip label={themeLabel} delayMs={500}>
              <span className={css.themeToggleAnchor}>
                <Button className={css.themeToggleButton} aria-label={themeLabel}
                  onClick={() => {
                    const manual = preference === 'light' || preference === 'dark'
                    setFollowSystemAfter(manual && nextTheme !== 'system' ? nextTheme : undefined)
                    props.setTheme(nextTheme)
                  }}>
                  <ThemeIcon size={18} />
                </Button>
              </span>
            </Tooltip>
          </div>
          <div className={css.settings}>
            {props.renderSlot('shell.settings', { wide: false })}
          </div>
        </div>
      </nav>
      <div className={css.surface} data-window-content>
        <AppFrame {...props} />
      </div>
    </div>
  )
}
