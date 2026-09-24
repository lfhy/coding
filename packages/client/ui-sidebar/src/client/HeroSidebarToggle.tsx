/** 欢迎页右上角的侧边栏入口，沿用布局服务的全局开关。 */
import { IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SidebarRoot.module.css'

/** 欢迎页侧边栏按钮的注入动作。 */
export interface HeroSidebarToggleInjected {
  toggleSidebar: () => void
}

/**
 * 按实际收起状态选择按钮名称，供指针和键盘操作。
 * @param props - 布局状态、开关动作与本地化文案。
 * @returns 欢迎页的侧边栏图标按钮。
 */
export function HeroSidebarToggle({ sidebarCollapsed, toggleSidebar, t }:
  PropsRuntime<'conversation.hero.actions'> & InjectFace<HeroSidebarToggleInjected> & PropsLocale<'sidebar'>) {
  const label = t(sidebarCollapsed ? 'toggle.open' : 'toggle.collapse')
  return (
    <Tooltip label={label} delayMs={500}>
      <button type="button" className={css.iconButton} title={label} aria-label={label} onClick={toggleSidebar}>
        <IconPanelLeftOutline16 size={18} />
      </button>
    </Tooltip>
  )
}
