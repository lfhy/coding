/**
 * pi-ai 助手事件到 harness 流式分片的转换。
 *
 * 与 `llm-pi-ai` 同一协议约定：`finish` 之前先发 `usage`，工具参数全程保持原始
 * JSON 字符串，失败以错误 `finish` 交付而不是从 `stream()` 抛出。上游免费通道
 * 用 403 表达两种不同含义（客户端受限与地区封锁），因此这里的分类必须先把它们
 * 从通用的 AUTH 里分出来——否则用户会看到「API 密钥无效」这种误导性诊断。
 *
 * @module coding-llm-opencode/stream
 */

import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from 'coding-llm'
import type { FinishReason, StreamChunk, TokenUsage } from 'coding-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'

/** 上游客户端受限时的稳定错误码；不可重试，因为重发同样会被拒。 */
export const FREE_TIER_RESTRICTED_CODE = 'FREE_TIER_RESTRICTED'

/** 上游按出口地区封锁模型时的稳定错误码。 */
export const REGION_BLOCKED_CODE = 'REGION_BLOCKED'

/**
 * 把 pi-ai 的用量折算成 harness 计数（pi-ai 已把推理 token 并入输出）。
 * @param usage - 终止事件上的累计用量。
 * @returns harness 计数；缓存字段仅在非零时出现。
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/**
 * 给上游错误文本分类。顺序有语义：地区与客户端受限都走 403，
 * 必须在通用的 401/403 判定之前分出来。
 * @param message - pi-ai 交付的错误文本。
 * @returns harness 的稳定错误码。
 */
export function classifyUpstreamError(message: string): string {
  if (/\bRegionError\b|not available in your country/i.test(message)) return REGION_BLOCKED_CODE
  if (/\bFreeTierError\b|free tier can only be used from within OpenCode/i.test(message)) {
    return FREE_TIER_RESTRICTED_CODE
  }
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'UPSTREAM'
}

/**
 * 把终止的 pi-ai 事件映射成 harness 结束原因。
 * @param message - `done` 或 `error` 事件携带的助手消息。
 * @param contextWindow - 该模型的上下文容量，用于按用量判定溢出。
 * @returns harness 结束原因；无内容块的 `stop` 是退化完成，映射为错误而非空消息。
 */
export function mapStopReason(message: AssistantMessage, contextWindow: number): FinishReason {
  if (isContextOverflow(message, contextWindow)) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }
  if (message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)) {
    return {
      kind: 'error',
      failure: { message: message.errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'OpenCode Zen stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'OpenCode Zen stream error'
      return { kind: 'error', failure: { message: text, code: classifyUpstreamError(text) } }
    }
  }
}

/**
 * 把一个 pi-ai 助手事件流翻译成 harness 分片。pi-ai 从不在流中抛出：
 * 失败以 `error` 事件到达，并在这里变成错误 finish 分片。
 * @param events - 一次助手轮次的 pi-ai 事件流。
 * @param contextWindow - 该模型的上下文容量。
 * @returns harness 分片，以 `usage` 与 `finish` 收尾。
 * @throws LlmError 源在没有终止事件的情况下结束（`STREAM_CLOSED`）。
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow: number,
): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known === undefined || known.name.length === 0 ? {} : { name: known.name },
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai 交回的是已解析对象；harness 词汇保留原始字符串。
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
    }
  }
  throw new LlmError('OpenCode Zen event stream ended without a terminal event', 'STREAM_CLOSED')
}
