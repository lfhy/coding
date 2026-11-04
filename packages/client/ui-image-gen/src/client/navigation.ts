/** 画图入口只切换空白会话的模式，非空历史绝不重新组装。 */
import type { IApiClient } from 'coding-api-remotes/client'
import type { ISessions, IWorkspaces, SessionId } from 'coding-client-runtime/client'

/**
 * 新建或选择图像会话后才打开画廊；预设失败时保持当前会话不变。
 * @param sessions - 会话选择与摘要所有者。
 * @param workspaces - 当前工作区归属与空白创建。
 * @param api - 切换预设的 Host RPC。
 * @param conversation - 会话视图动作。
 * @returns 可点击入口的异步动作。
 */
export function createGalleryNavigation(
  sessions: Pick<ISessions, 'list' | 'open' | 'noteAgentPreset'>,
  workspaces: Pick<IWorkspaces, 'list' | 'connectWorkspace' | 'connectHome'>,
  api: Pick<IApiClient, 'agentPresets'>,
  conversation: { selectView(sessionId: SessionId, view: string): void },
): () => Promise<void> {
  let opening: Promise<void> | undefined
  const navigate = async (): Promise<void> => {
    const snapshot = sessions.list.getSnapshot()
    const current = snapshot.current
    const summary = current === undefined ? undefined : snapshot.byId[current]
    let target: SessionId
    if (summary !== undefined && (!summary.blank && summary.agentPreset === 'image' || summary.blank)) {
      target = summary.id
    } else {
      const workspace = current === undefined ? undefined
        : workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(current))
      if (current === undefined) {
        const recent = workspaces.list.getSnapshot().recentWorkspaceId
        target = recent === undefined ? await workspaces.connectHome() : await workspaces.connectWorkspace(recent)
      } else {
        target = workspace === undefined
          ? await workspaces.connectHome()
          : await workspaces.connectWorkspace(workspace.workspaceId)
      }
    }
    const targetSummary = sessions.list.getSnapshot().byId[target]
    if (targetSummary?.agentPreset !== 'image') {
      if (!targetSummary?.blank) throw new Error('image preset requires a blank session')
      const response = await api.agentPresets.select({ sessionId: target, agentPreset: 'image' })
      if (!response.result.ok || response.result.value.agentPreset !== 'image') throw new Error('image preset unavailable')
      sessions.noteAgentPreset(target, 'image')
    }
    sessions.open(target)
    // 会话 slot 的 store action 在 React 挂载后才存在；下一帧再请求 owner 切换。
    for (let attempt = 0; attempt < 30; attempt++) {
      try { conversation.selectView(target, 'image-gallery'); return } catch {
        await new Promise<void>((resolve) => { setTimeout(resolve, 32) })
      }
    }
    throw new Error('image gallery view unavailable')
  }
  return () => {
    opening ??= navigate().finally(() => { opening = undefined })
    return opening
  }
}
