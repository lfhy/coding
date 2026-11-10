/** 会话页头左侧的只读模式标签；会话开始后模式只能在新会话里重新选择。 */

import { useEffect } from 'react'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import { IconAgentPresetOutline16 } from 'coding-client-ui-primitives'
// 类型导入使页头操作 slot 的定义在此包中可见。
import type {} from 'coding-client-ui-conversation/client'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { currentPresetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'

/** 页头模式标签的名单读取接口。 */
export interface AgentPresetLabelInjected {
  hooks: {
    /** 由渲染器绑定的模式名单快照。 */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** 请求模式名单，以便用显示名称代替标识。 */
  load: () => Promise<void>
}

/** 会话页头标签的完整属性。 */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * 只显示当前会话的模式名称，不提供切换入口。
 * @param props - 会话摘要与模式名单。
 * @returns 会话记录了模式时的标签，否则不渲染。
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, load, t,
}: AgentPresetLabelProps) {
  const preset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const options = useAgentPresets(state => state.options)

  useEffect(() => {
    // 会话未记录模式时，不发起名单请求。
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const text = currentPresetDisplayText(preset, options, t)
  return (
    <span className={css.label} title={text?.description ?? t('headerHint')}>
      <IconAgentPresetOutline16 size={14} className={css.icon} />
      {text?.name ?? preset}
    </span>
  )
}
