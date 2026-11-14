/** 新对话页的入口选择只向侧栏发布浏览范围，不消费侧栏的选择作为页面模式。 */
import type { PropsLocale, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import type { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceViewTabs } from './WorkspaceViewTabs.tsx'

/** 顶部入口的 owner、共享侧栏 store 与文案均由 slot 注册派生。 */
export type NewConversationModeSwitchProps = PropsRuntime<'conversation.hero.mode'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & PropsLocale<'workspace'>

/**
 * 显示工作／对话入口；只有顶部操作会写入侧栏范围，反方向的筛选不会切换页面。
 * @param props - 新对话页的当前模式及选择动作、共享侧栏动作和本地化文案。
 * @returns 复用侧栏交互、放大并带外圈描边的两段切换。
 */
export function NewConversationModeSwitch({ mode, busy, onPick, id, actions, t }: NewConversationModeSwitchProps) {
  return (
    <WorkspaceViewTabs
      id={id}
      view={mode === 'conversation' ? 'conversations' : 'work'}
      views={['work', 'conversations']}
      size="md"
      label={t('newConversation.mode.label')}
      disabled={busy}
      t={t}
      onSelect={(view) => {
        if (view === 'recent') return
        actions.setView(view)
        onPick(view === 'conversations' ? 'conversation' : 'work')
      }}
    />
  )
}
