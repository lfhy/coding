/** 独立侧聊的浏览器安全 RPC 契约；仅 sideChat.* 能读取它的标识。 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcId, RpcRequest, RpcResponse } from './rpc.ts'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolEventView } from './events.ts'

/** 单次轮询最多返回的原始日志事件数；另有 2 MiB 整页限制。 */
export const SIDE_CHAT_STATE_PAGE_EVENTS = 100
/** 含 wire 信封的单次轮询响应字节上限。 */
export const SIDE_CHAT_STATE_MAX_BYTES = 2 * 1024 * 1024

/** 未完成的权限请求或用户提问，仅由该 sideChat.state 返回。 */
export type SideChatInteraction =
  | { type: 'approval/requested'; rpcId: RpcId; sideChatId: SessionId; approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
  | { type: 'question/requested'; rpcId: RpcId; sideChatId: SessionId; questions: AskUserQuestionItem[] }

/** 侧聊状态与连续日志切片；`nextSeq` 是下次请求的起始序号。 */
export interface SideChatState {
  status: 'idle' | 'running'
  events: SessionEvent[]
  /** 与 events 对齐的工具调用/结果展示；失败时为 null，客户端回退通用卡片。 */
  views: (ToolEventView | null)[]
  nextSeq: number
  hasMore: boolean
  interactions: SideChatInteraction[]
}

/** 临时侧聊方法：关闭时停止 Agent 并销毁全部会话历史。 */
export interface SideChatApi {
  /** 创建私有 Agent；可从当前普通实时会话继承可信 cwd、模型与 preset。 */
  create(request: RpcRequest<{ sourceSessionId?: SessionId; agentPreset?: string }>):
  Promise<RpcResponse<{ sideChatId: SessionId; agentPreset?: string }>>
  /** 排入真人文本提示词；接受回执不表示轮次结束。 */
  send(request: RpcRequest<{ sideChatId: SessionId; text: string }>): Promise<RpcResponse<{}>>
  /** 从 afterSeq（包含）读取至多 100 个事件；省略时从零开始，轮询同时续租 30 秒。 */
  state(request: RpcRequest<{ sideChatId: SessionId; afterSeq?: number }>): Promise<RpcResponse<SideChatState>>
  /** 幂等地停止运行中 Agent、移除私有会话并丢弃日志。 */
  close(request: RpcRequest<{ sideChatId: SessionId }>): Promise<RpcResponse<{}>>
}
