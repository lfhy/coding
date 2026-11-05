/** 画图入口只切换空白会话的模式，随后打开右侧画廊面板；非空历史绝不重新组装。 */
import type { IApiClient } from 'coding-api-remotes/client'
import type { ISessions, IWorkspaces, SessionId } from 'coding-client-runtime/client'

/** 工作台尚未挂载时的重试节奏；约 1 秒后放弃，面板可由页头按钮再次打开。 */
const RETRY_MS = 32
const RETRY_LIMIT = 30

/**
 * 新建或选择图像会话后才打开画廊面板；预设失败时保持当前会话不变。
 * @param sessions - 会话选择与摘要所有者。
 * @param workspaces - 当前工作区归属与空白创建。
 * @param api - 切换预设的 Host RPC。
 * @param openPanel - 在指定会话打开画廊标签，工作台未挂载时返回 false。
 * @returns 可点击入口的异步动作。
 */
export function createGalleryNavigation(
  sessions: Pick<ISessions, 'list' | 'open' | 'noteAgentPreset'>,
  workspaces: Pick<IWorkspaces, 'list' | 'connectWorkspace' | 'connectHome'>,
  api: Pick<IApiClient, 'agentPresets'>,
  openPanel: (sessionId: SessionId) => boolean,
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
    // 工作台的标签动作在会话视图挂载后才存在；下一帧起按固定节奏重试。
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      if (openPanel(target)) return
      await new Promise<void>((resolve) => { setTimeout(resolve, RETRY_MS) })
    }
    throw new Error('image gallery panel unavailable')
  }
  return () => {
    opening ??= navigate().finally(() => { opening = undefined })
    return opening
  }
}
