/** 侧栏三种浏览范围的轻描边胶囊；组合共享 Button，不引入额外视图状态。 */
import { Button, Icon, IconFolderClose16 } from 'coding-client-ui-primitives'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { WorkspaceViewMode } from './stores.ts'
import css from './WorkspaceViewTabs.module.css'

const VIEWS: readonly WorkspaceViewMode[] = ['work', 'conversations', 'recent']

/**
 * 用单一 Tab 停靠点与自动激活模式切换浏览范围。
 * @param props - 当前持久化视图、选择动作、稳定的无障碍标识与字典。
 * @returns 宽侧栏专用的选项卡列表。
 */
export function WorkspaceViewTabs({ view, onSelect, id, t }: {
  view: WorkspaceViewMode
  onSelect: (view: WorkspaceViewMode) => void
  id: string
  t: WorkspaceBrowserProps['t']
}) {
  return (
    <div className={css.tabs} role="tablist" aria-label={t('views.label')} aria-orientation="horizontal">
      {VIEWS.map((mode, index) => (
        <Button
          key={mode}
          size="sm"
          icon={mode === 'work' ? <IconFolderClose16 /> : <Icon name={mode === 'recent' ? 'recent' : 'conversation'} size={16} />}
          className={css.tab}
          role="tab"
          id={`${id}-${mode}`}
          aria-selected={view === mode}
          aria-controls={`${id}-panel`}
          tabIndex={view === mode ? 0 : -1}
          onClick={() => { onSelect(mode) }}
          onKeyDown={(event) => {
            let next: number
            if (event.key === 'ArrowRight') next = (index + 1) % VIEWS.length
            else if (event.key === 'ArrowLeft') next = (index + VIEWS.length - 1) % VIEWS.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = VIEWS.length - 1
            else return
            event.preventDefault()
            const nextView = VIEWS[next]
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
