import { isImageEnvelope } from 'coding-llm/src/image-envelope.ts'
import type { ContentBlock } from 'coding-llm/types'
import type { MuxFrame } from 'coding-api-remotes/client'
import type { SessionEvent } from 'coding-session/types'
import type { QueuedMessage } from './conversation.ts'

const QUEUE_PREVIEW_CHARS = 200

function previewOf(content: readonly ContentBlock[]): string {
  const flat = content
    // 图片路径说明只服务模型，不应占用队列行的预览文本。
    .filter(block => !(block.type === 'text' && isImageEnvelope(block.text)))
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join('')}…` : flat
}

function textOf(content: readonly ContentBlock[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}

type QueueFrame = Extract<MuxFrame, { type: 'session/queue' }>

/** Host 队列镜像；在正式消息可呈现时交接已领取项。 */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []
  private asOfSeq: number | undefined

  /**
   * Return the current immutable queue projection.
   * @returns current queue rows.
   */
  snapshot(): readonly QueuedMessage[] {
    return this.current
  }

  /**
   * Drop the stale generation before its replacement queue baseline arrives.
   * @returns whether any projected queue row was removed.
   */
  reset(): boolean {
    this.asOfSeq = undefined
    if (this.current.length === 0) return false
    this.current = []
    return true
  }

  /**
   * 用同一 Host 序号的整份队列快照替换镜像。
   * @param frame - mux 中收到的完整队列快照。
   */
  replace(frame: QueueFrame): void {
    this.asOfSeq = frame.asOfSeq
    this.current = frame.items.map(item => ({
      id: item.id,
      messageId: item.message.id,
      placement: item.placement,
      content: item.message.content,
      preview: previewOf(item.message.content),
      text: textOf(item.message.content),
    }))
  }

  /**
   * 正式消息进入窗口后，消费一个对应的临时项。快照已覆盖的事件不能删除后来复用同一标识的排队项。
   * @param event - 已加载到连续窗口的会话事件。
   * @returns 投影是否发生变化。
   */
  acceptDurable(event: SessionEvent, fromHistory = false): boolean {
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return false
    if (this.asOfSeq === undefined ? fromHistory : event.seq <= this.asOfSeq) return false
    const messageId = event.data.id
    const matches = (item: QueuedMessage): boolean => item.messageId === messageId
    const claimed = this.current.findIndex(item => item.placement === 'preparing' && matches(item))
    const index = claimed >= 0 ? claimed : this.current.findIndex(item =>
      (item.placement === 'steering' || (this.asOfSeq === undefined && item.placement === 'queued')) && matches(item))
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
