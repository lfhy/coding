/** 窗口级外壳包裹原布局；导航动作复用布局 store，不重建会话或工作台。 */
import { Button, Icon, Tooltip } from 'coding-client-ui-primitives'
import type { PropsRenderSlots } from 'coding-client-ui-slots'
import { AppFrame } from './AppFrame.tsx'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './WindowShell.module.css'

/** 外壳与内层共用根注册，只在外层增加底部设置的渲染权限。 */
export type WindowShellProps = Omit<AppFrameProps, 'renderSlot' | '__renders'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'workbench' | 'workbench.bottom'
    | 'shell.overlay' | 'shell.page' | 'shell.settings'>

/**
 * 渲染窗口顶栏、全局导航和常驻的内层布局。
 * @param props - 根 slot 派生的布局、会话与本地化能力，原样交给 AppFrame。
 * @returns 固定一屏的窗口外壳；仅内层内容区域拥有滚动。
 */
export function WindowShell(props: WindowShellProps) {
  const current = props.useSessions(state => state.current)
  const conversationVisible = props.useStore(state => state.page === null)

  return (
    <div className={css.shell} data-window-shell>
      <header className={css.titlebar} data-window-drag-region aria-hidden="true" />
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
