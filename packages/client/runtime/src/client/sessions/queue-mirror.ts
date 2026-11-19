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

type QueueItems = Extract<MuxFrame, { type: 'session/queue' }>['items']

/** Authoritative transient queue projection and durable steering handoff. */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []

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
    if (this.current.length === 0) return false
    this.current = []
    return true
  }

  /**
   * Replace from one authoritative stream queue frame.
   * @param items - complete host queue snapshot.
   */
  replace(items: QueueItems): void {
    this.current = items.map(item => ({
      id: item.id,
      messageId: item.message.id,
      placement: item.placement,
      content: item.message.content,
      preview: previewOf(item.message.content),
      text: textOf(item.message.content),
    }))
  }

  /**
   * 持久用户消息进入日志后，折叠一个对应的瞬态排队项。
   * 同一 MessageId 可能有多个待处理出现，因此只消费当前最早的一项。
   * @param event - 新到达且已连续的 Session 事件。
   * @returns 投影是否发生变化。
   */
  acceptDurable(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const messageId = event.data.id
    const index = this.current.findIndex(item =>
      (item.placement === 'queued' || item.placement === 'steering') && item.messageId === messageId)
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
