/** 进度事实的校验与日志折叠；所有状态均可由所属会话重建。 */
import { z } from 'zod'
import type { SessionEvent } from 'coding-session'
import type {} from './types.ts'

/** 短进度按 Unicode 码点计数，避免多行正文或不可见控制符进入状态行。 */
export const STATUS_TEXT_MAX_LENGTH = 120

/** 持久值和跨进程投影使用同一个规范字符串边界。 */
export const statusTextSchema = z.string().refine(text =>
  text.length > 0 && text.trim() === text
  && Array.from(text).length <= STATUS_TEXT_MAX_LENGTH
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text),
'status text must be a trimmed, non-empty single line of at most 120 characters without control characters')

/** status/set 全量事件的持久形状。 */
export const statusEventSchema = z.object({
  turn: z.number().int().nonnegative(),
  text: statusTextSchema.nullable(),
}).strict()

/** 向客户端发布当前进度；null 表示由更低优先级来源决定文案。 */
export const statusProjectionSchema = statusTextSchema.nullable()

/** 投影内部记录开放轮次，防止过时事件把其他轮次的进度带回来。 */
export interface StatusState {
  readonly turn: number | null
  readonly text: string | null
}

/**
 * 待办更新会接管进度，轮次边界清空；不相关事件保留原引用。
 * @param state 上一份已提交状态。
 * @param event 下一条持久事件。
 * @returns 更新后的当前轮次进度。
 */
export function applyStatus(state: StatusState, event: SessionEvent): StatusState {
  if (event.type === 'turn/start') return { turn: event.data.turn, text: null }
  if (event.type === 'turn/end') return { turn: null, text: null }
  if (event.type === 'todo/write') return state.text === null ? state : { turn: state.turn, text: null }
  if (event.type !== 'status/set') return state
  const value = statusEventSchema.parse(event.data)
  return value.turn === state.turn ? value : state
}
