/** 主对话复用的纯展示控件；会话状态与提交动作由调用方持有。 */
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import { IconSendOutline16, IconStopFill16 } from 'coding-client-ui-icons'
import css from './ChatSurfaces.module.css'

/** 用户消息的共同气泡，不解析用户输入中的 Markdown。 */
export function ChatUserBubble({ children }: { children: ReactNode }) {
  return <div className={css.userBubble}>{children}</div>
}

/** 助手正文的共同排版；调用方决定消息块及流式状态。 */
export function ChatAssistantBody({ children, streaming = false }: { children: ReactNode; streaming?: boolean }) {
  return <div className={css.assistantBody} data-streaming={streaming || undefined}>
    <div className={css.assistantBlocks}>{children}</div>
  </div>
}

/** 与主会话同款输入卡片；本身不持有草稿或发送语义。 */
export const ChatComposerCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ChatComposerCard(
  { className, ...props }, ref,
) {
  return <div ref={ref} className={clsx(css.composerCard, className)} {...props} />
})

/** 输入卡片的发送／停止圆形按钮；动作与禁用条件由调用方决定。 */
export const ChatComposerAction = forwardRef<HTMLButtonElement, {
  kind?: 'send' | 'stop'
} & ButtonHTMLAttributes<HTMLButtonElement>>(function ChatComposerAction(
  { kind = 'send', className, ...props }, ref,
) {
  return <button ref={ref} type="button" className={clsx(css.composerAction, className)} {...props}>
    <span className={css.composerActionIcon} aria-hidden="true">
      {kind === 'send' ? <IconSendOutline16 /> : <IconStopFill16 />}
    </span>
  </button>
})
