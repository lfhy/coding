/** 只保存本页面的发起选择与请求呈现；不读取或订阅侧栏浏览状态。 */
import { useEffect, useRef, useState } from 'react'
import type { SessionId, WorkspaceId } from 'coding-client-runtime/client'
import type { ConversationInjected } from '../contract/slots.ts'
import type { NewConversationMode } from '../contract/hero-mode.ts'

interface Selection {
  sessionId: SessionId | undefined
  mode: NewConversationMode
  workWorkspaceId: WorkspaceId | undefined
  pendingWorkspaceId: WorkspaceId | undefined
  busy: boolean
}

interface HeroSelectionProps extends Pick<ConversationInjected,
  'selectWorkspace' | 'selectWithoutWorkspace' | 'abortBlankSelection'> {
  sessionId: SessionId | undefined
  workspaceId: WorkspaceId | undefined
  workspacesReady: boolean
  hero: boolean
}

/**
 * 页面选择随自己的空白会话交接保留，外部切换会话则按实际归属重新推导。
 * @param props - 当前页面身份、项目归属与 apply 提供的受保护选择操作。
 * @returns 顶部模式、输入锁定、工作区选择及可恢复的失败反馈。
 */
export function useHeroSelection({
  sessionId, workspaceId, workspacesReady, hero,
  selectWorkspace, selectWithoutWorkspace, abortBlankSelection,
}: HeroSelectionProps) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [failure, setFailure] = useState(0)
  const request = useRef(0)
  const latest = useRef({ sessionId, hero })
  latest.current = { sessionId, hero }
  const current = selection?.sessionId === sessionId ? selection : null
  const mode = current?.mode
    ?? (sessionId !== undefined && workspaceId === undefined && workspacesReady ? 'conversation' : 'work')
  const workWorkspaceId = workspaceId ?? current?.workWorkspaceId
  const busy = current?.busy === true

  useEffect(() => () => { abortBlankSelection() }, [abortBlankSelection])
  useEffect(() => {
    setSelection(value => value?.sessionId === sessionId ? value : null)
    setFailure(0)
  }, [sessionId])
  useEffect(() => {
    if (!hero) {
      request.current++
      abortBlankSelection()
      setSelection(null)
      setFailure(0)
    }
  }, [hero, abortBlankSelection])

  const choose = async (
    nextMode: NewConversationMode, targetWorkspaceId?: WorkspaceId, feedback = true,
  ): Promise<void> => {
    const attempt = ++request.current
    abortBlankSelection()
    const previous = current
    const next: Selection = {
      sessionId, mode: nextMode, workWorkspaceId,
      pendingWorkspaceId: targetWorkspaceId, busy: false,
    }
    setFailure(0)
    if (nextMode === 'work' && targetWorkspaceId === undefined) {
      setSelection(next)
      return
    }
    // 菜单发起的无项目动作保留工作区子树，失败留在同一个弹层内处理。
    const pendingSelection = { ...next, mode: feedback ? nextMode : mode, busy: true }
    setSelection(pendingSelection)
    try {
      const target = await (targetWorkspaceId === undefined
        ? selectWithoutWorkspace()
        : selectWorkspace(targetWorkspaceId))
      if (attempt !== request.current) return
      if (target === undefined) {
        // 外部切换已清理本地选择时，旧请求不能在用户返回后恢复旧模式。
        setSelection(value => value === pendingSelection ? previous : value)
        return
      }
      if (!latest.current.hero
        || (latest.current.sessionId !== sessionId && latest.current.sessionId !== target)) return
      setSelection({
        ...next, sessionId: target,
        workWorkspaceId: targetWorkspaceId ?? workWorkspaceId,
      })
    } catch (error: unknown) {
      if (attempt !== request.current || latest.current.sessionId !== sessionId || !latest.current.hero) return
      setSelection(value => value === pendingSelection ? previous : value)
      if (feedback) setFailure(attempt)
      else throw error
    }
  }

  return {
    mode, busy, failure,
    pendingWorkspaceId: current?.pendingWorkspaceId,
    locked: busy || sessionId === undefined || (hero && mode === 'work' && workspaceId === undefined),
    pickMode: (nextMode: NewConversationMode) => {
      if (mode !== nextMode) void choose(nextMode, nextMode === 'work' ? workWorkspaceId : undefined)
    },
    pickWorkspace: (id: WorkspaceId) => { void choose('work', id) },
    selectConversation: () => choose('conversation', undefined, false),
    dismissFailure: () => { setFailure(0) },
  }
}
