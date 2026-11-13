/** 工具行只有仍属于当前会话的已结算结果才能发送预设话题消息。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNode } from 'coding-client-ui-conversation/client'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import type { ToolCallBlock } from 'coding-client-runtime/client'
import { chatSourceOf, sourceSessionOf } from './dom-source.ts'
import type { GenuiMessageSender } from './message-context.ts'

/** 只在用户发送时查当前投影，避免旧工具行、失败结果或会话切换误投递。 */
export function toolTopicSender(
  ctx: Context, props: ToolCallViewProps, sendMessage: GenuiMessageSender,
): GenuiMessageSender | undefined {
  const { block, callId, sessionId, toolName } = props
  if (!('kind' in block) || block.isError || block.call?.name !== 'render_ui'
    || block.callId !== callId || toolName !== 'render_ui') return undefined
  return (message) => {
    const current = sourceSessionOf(ctx)
    const chat = current.available && current.sessionId === sessionId
      ? chatSourceOf(ctx, sessionId)?.getSnapshot()
      : undefined
    if (chat === undefined) return Promise.reject(new Error('session changed'))
    // 子调用与根调用走同一工具行；仅在点击时遍历已投影的调用树。
    const ownsResult = chat.nodes.values().some((node) => {
      if (node.kind !== 'tool-call' || node.visibility !== 'visible') return false
      const pending: ToolCallBlock[] = [(node as ChatNode<'tool-call'>).data.root]
      while (pending.length > 0) {
        const candidate = pending.pop()
        if (candidate === undefined) continue
        if (candidate === block) return true
        pending.push(...candidate.subCalls)
      }
      return false
    })
    return ownsResult ? sendMessage(message) : Promise.reject(new Error('tool result changed'))
  }
}
