/** 侧栏范围与新对话入口共用的分段切换；选中状态完全由调用方持有。 */
import { Button, Icon, IconFolderClose16 } from 'coding-client-ui-primitives'
import clsx from 'clsx'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { WorkspaceViewMode } from './stores.ts'
import css from './WorkspaceViewTabs.module.css'

const VIEWS: readonly WorkspaceViewMode[] = ['work', 'conversations', 'recent']

/**
 * 用单一 Tab 停靠点与自动激活模式切换浏览范围。
 * @param props - 当前选项、选择动作、可用范围、忙碌状态、无障碍标识与字典。
 * @returns 侧栏与新对话页共用的分段选项卡列表。
 */
export function WorkspaceViewTabs({ view, onSelect, id, t, views = VIEWS, label, disabled = false, size = 'sm' }: {
  view: WorkspaceViewMode
  onSelect: (view: WorkspaceViewMode) => void
  id: string
  t: WorkspaceBrowserProps['t']
  views?: readonly WorkspaceViewMode[]
  label?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <div className={clsx(css.tabs, size === 'md' && css.prominent)} role="tablist" aria-label={label ?? t('views.label')} aria-orientation="horizontal">
      {views.map((mode, index) => (
        <Button
          key={mode}
          size={size}
          icon={mode === 'work' ? <IconFolderClose16 /> : <Icon name={mode === 'recent' ? 'recent' : 'conversation'} size={16} />}
          className={css.tab}
          role="tab"
          id={`${id}-${mode}`}
          aria-selected={view === mode}
          disabled={disabled}
          aria-controls={`${id}-panel`}
          tabIndex={view === mode ? 0 : -1}
          onClick={() => { onSelect(mode) }}
          onKeyDown={(event) => {
            let next: number
            if (disabled) return
            if (event.key === 'ArrowRight') next = (index + 1) % views.length
            else if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = views.length - 1
            else return
            event.preventDefault()
            const nextView = views[next]
            if (nextView === undefined) return
            onSelect(nextView)
            event.currentTarget.closest('[role="tablist"]')
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}
        >
          {t(`views.${mode}`)}
        </Button>
      ))}
    </div>
  )
}
