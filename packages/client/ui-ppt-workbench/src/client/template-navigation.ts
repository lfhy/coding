/** PPT 模板入口只准备同会话输入草稿，不创建模板或发送消息。 */
import type { Branded } from 'coding-brand'
import type { IApiClient } from 'coding-api-remotes/client'
import type { ISessions, IWorkspaces, SessionId } from 'coding-client-runtime/client'
import type { IConversation } from 'coding-client-ui-conversation/client'
import type { ILayout } from 'coding-client-ui-layout/client'

type Sessions = Pick<ISessions, 'list' | 'open' | 'scope' | 'noteAgentPreset' | 'create'>
type Workspaces = Pick<IWorkspaces, 'list' | 'connectWorkspace' | 'connectHome'>
type Api = { agentPresets: Pick<IApiClient['agentPresets'], 'select'> }
type Conversation = Pick<IConversation, 'input' | 'focusInput'>
type Layout = Pick<ILayout, 'showConversation'>

/** 一次 UI 手势持有的交接身份；关闭入口只取消自己的异步动作。 */
export type TemplateHandoffId = Branded<'PptTemplateHandoffId'>

interface Handoff {
  readonly id: TemplateHandoffId
  readonly text: string
  canceled: boolean
  promise: Promise<void>
}

/** 会话 scope 异步就绪时的短有界等待；新建会话通常首轮即已可用。 */
const SCOPE_RETRIES = 12
const SCOPE_RETRY_MS = 16

/**
 * 构造模板目录到 PPT 对话草稿的私有导航动作。
 * @param sessions - 会话摘要、scope 与创建动作。
 * @param workspaces - 当前工作区归属与空白会话连接动作。
 * @param api - 仅用于空白会话的预设选择。
 * @param conversation - 会话输入与聚焦动作。
 * @param layout - 最大化工作台的同会话对话呈现动作。
 * @returns 草稿交接、后续聚焦与生命周期释放动作。
 */
export function createTemplateNavigation(
  sessions: Sessions,
  workspaces: Workspaces,
  api: Api,
  conversation: Conversation,
  layout: Layout,
): {
  handoffPrompt(text: string, id: TemplateHandoffId): Promise<void>
  cancelHandoff(id: TemplateHandoffId): void
  focusPrompt(id: TemplateHandoffId): void
  dispose(): void
} {
  let disposed = false
  let pending: Handoff | undefined
  let prepared: { id: TemplateHandoffId; target: SessionId } | undefined
  const usedIds = new Set<TemplateHandoffId>()

  const ensureLive = (original: SessionId | undefined, handoff: Handoff): void => {
    if (disposed) throw new Error('PPT 模板对话入口已关闭')
    if (handoff.canceled) throw new Error('PPT 模板草稿交接已取消')
    if (sessions.list.getSnapshot().current !== original) {
      throw new Error('当前会话已切换，已取消 PPT 模板草稿交接')
    }
  }

  const ensureTarget = (target: SessionId, handoff: Handoff): void => {
    if (disposed || handoff.canceled || sessions.list.getSnapshot().current !== target) {
      throw new Error('PPT 模板草稿交接已取消')
    }
  }

  const inputFor = async (id: SessionId, original: SessionId | undefined, handoff: Handoff) => {
    for (let attempt = 0; attempt <= SCOPE_RETRIES; attempt++) {
      ensureLive(original, handoff)
      const scope = sessions.scope(id)
      if (scope !== undefined) return conversation.input.for(scope)
      if (attempt < SCOPE_RETRIES) {
        await new Promise<void>((resolve) => { setTimeout(resolve, SCOPE_RETRY_MS) })
      }
    }
    throw new Error('PPT 会话输入尚未就绪，请重试')
  }

  const prepare = async (handoff: Handoff): Promise<void> => {
    const { text } = handoff
    const original = sessions.list.getSnapshot().current
    const initial = original === undefined ? undefined : sessions.list.getSnapshot().byId[original]
    let target: SessionId
    if (initial?.agentPreset === 'ppt') {
      target = initial.id
    } else {
      const workspaceState = workspaces.list.getSnapshot()
      const currentWorkspace = original === undefined ? undefined
        : workspaceState.items.find(item => item.sessionIds.includes(original))?.workspaceId
      const workspaceId = currentWorkspace ?? (original === undefined ? workspaceState.recentWorkspaceId : undefined)
      if (workspaceId === undefined) {
        target = await workspaces.connectHome()
      } else {
        const previouslyListed = new Set(Object.keys(sessions.list.getSnapshot().byId))
        const candidate = await workspaces.connectWorkspace(workspaceId)
        ensureLive(original, handoff)
        const summary = sessions.list.getSnapshot().byId[candidate]
        if (summary?.blank !== true) throw new Error('工作区未返回空白会话')
        // 未选中的旧会话可能尚未把持久 UI 草稿恢复进 InputHub；不读取空快照后劫持它。
        if (previouslyListed.has(candidate) || summary.agentPreset !== undefined && summary.agentPreset !== 'ppt') {
          target = await sessions.create({ workspaceId })
        } else {
          const input = await inputFor(candidate, original, handoff)
          ensureLive(original, handoff)
          const state = input.state.getSnapshot()
          target = state.draft !== '' || state.imageIds.length > 0 || state.phase !== 'plain'
            ? await sessions.create({ workspaceId }) : candidate
        }
      }
    }

    ensureLive(original, handoff)
    const summary = sessions.list.getSnapshot().byId[target]
    if (summary === undefined) throw new Error('PPT 会话尚未出现在列表中')
    if (summary.agentPreset !== 'ppt') {
      if (!summary.blank) throw new Error('已开始的会话不能切换到 PPT 模式')
      const response = await api.agentPresets.select({ sessionId: target, agentPreset: 'ppt' })
      ensureLive(original, handoff)
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (response.result.value.agentPreset !== 'ppt') throw new Error('PPT 模式未生效')
      sessions.noteAgentPreset(target, 'ppt')
    }

    const input = await inputFor(target, original, handoff)
    ensureLive(original, handoff)
    const state = input.state.getSnapshot()
    if (state.phase === 'adjudicating' || state.phase === 'submitting') {
      throw new Error('输入正在提交，无法填入 PPT 模板草稿')
    }
    if (state.phase !== 'plain') throw new Error('输入正处理命令，无法填入 PPT 模板草稿')
    // 最后才导航；失败和用户中途切换都不覆盖此前的会话与草稿。
    ensureLive(original, handoff)
    if (target !== original) sessions.open(target)
    ensureTarget(target, handoff)
    const latest = input.state.getSnapshot()
    if (latest.phase !== 'plain') throw new Error('输入正在处理，无法填入 PPT 模板草稿')
    ensureTarget(target, handoff)
    input.setDraft(latest.draft === '' ? text : `${latest.draft}\n\n${text}`)
    prepared = { id: handoff.id, target }
  }

  return {
    handoffPrompt(text, id) {
      if (disposed) return Promise.reject(new Error('PPT 模板对话入口已关闭'))
      if (pending !== undefined) {
        if (pending.id === id) {
          return pending.text === text ? pending.promise
            : Promise.reject(new Error('同一交接动作不能更换草稿'))
        }
        return Promise.reject(new Error('正在准备另一个 PPT 模板草稿'))
      }
      if (usedIds.has(id)) return Promise.reject(new Error('PPT 模板草稿交接身份已使用'))
      usedIds.add(id)
      prepared = undefined
      const handoff: Handoff = { id, text, canceled: false, promise: Promise.resolve() }
      handoff.promise = prepare(handoff).finally(() => { if (pending === handoff) pending = undefined })
      pending = handoff
      return handoff.promise
    },
    cancelHandoff(id) {
      if (pending?.id === id) {
        pending.canceled = true
        pending = undefined
      }
      if (prepared?.id === id) prepared = undefined
    },
    focusPrompt(id) {
      const canFocus = () => !disposed && prepared?.id === id
        && sessions.list.getSnapshot().current === prepared.target
      const target = prepared?.target
      if (target === undefined || !canFocus()) return
      layout.showConversation(target)
      if (canFocus()) conversation.focusInput(target)
    },
    dispose() {
      disposed = true
      if (pending !== undefined) pending.canceled = true
      pending = undefined
      prepared = undefined
    },
  }
}
