/** 侧聊 RPC 的有界日志分页与仅允许 Host 铸造标识的 wire 校验。 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionEventSchema, sessionIdSchema, toolEventViewSchema } from './sessions.schema.ts'
import { approvalRequestIdSchema } from './approvals.schema.ts'
import { askUserQuestionItemSchema } from './events.schema.ts'
import { rpcIdSchema } from './rpc.schema.ts'
import { SIDE_CHAT_STATE_PAGE_EVENTS } from './side-chat.ts'

/** sideChat.create 请求和响应。 */
export const sideChatCreateRequestSchema = z.object({
  sourceSessionId: sessionIdSchema.optional(),
  agentPreset: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'sideChat.create'>>>
export const sideChatCreateValueSchema = z.object({
  sideChatId: sessionIdSchema,
  agentPreset: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'sideChat.create'>>>

/** sideChat.send 只接纳非空文本，不接受附件或未校验的模型消息。 */
export const sideChatSendRequestSchema = z.object({
  sideChatId: sessionIdSchema,
  text: z.string().trim().min(1).max(20_000),
}) satisfies z.ZodType<Wire<RequestPayload<'sideChat.send'>>>
export const sideChatSendValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'sideChat.send'>>>

/** afterSeq 包含在本页；nextSeq 是严格递增的续传游标。 */
export const sideChatStateRequestSchema = z.object({
  sideChatId: sessionIdSchema,
  afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'sideChat.state'>>>
export const sideChatStateValueSchema = z.object({
  status: z.enum(['idle', 'running']),
  events: z.array(sessionEventSchema).max(SIDE_CHAT_STATE_PAGE_EVENTS),
  views: z.array(toolEventViewSchema.nullable()).max(SIDE_CHAT_STATE_PAGE_EVENTS),
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  interactions: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('approval/requested'), rpcId: rpcIdSchema, sideChatId: sessionIdSchema,
      approvalId: approvalRequestIdSchema, toolName: z.string(), callId: z.string().optional(), reason: z.string().optional(),
    }),
    z.object({ type: z.literal('question/requested'), rpcId: rpcIdSchema, sideChatId: sessionIdSchema, questions: z.array(askUserQuestionItemSchema).min(1) }),
  ])),
}) as unknown as z.ZodType<Wire<ResponseValue<'sideChat.state'>>>

/** close 对已关闭的标识也返回空成功回执。 */
export const sideChatCloseRequestSchema = z.object({ sideChatId: sessionIdSchema }) satisfies z.ZodType<Wire<RequestPayload<'sideChat.close'>>>
export const sideChatCloseValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'sideChat.close'>>>
