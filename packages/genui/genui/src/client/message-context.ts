/** 预设话题消息的发送能力由会话渲染入口提供，不经过模型动作回传。 */
import { createContext, useContext } from 'react'

/** 用户主动选择话题后，向所属会话发送原样的用户消息。 */
export type GenuiMessageSender = (message: string) => Promise<void>

export const GenuiMessageContext = createContext<GenuiMessageSender | undefined>(undefined)

/** 无所属会话时话题引导保持不可发送。 */
export function useGenuiMessage(): GenuiMessageSender | undefined {
  return useContext(GenuiMessageContext)
}
