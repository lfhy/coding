/** 面向本机用户的会话浏览器控制，不借用 Agent 的模型工具审批。 */
import type { BrowserHumanCommand, BrowserSessionState } from '@deepseek-ai/dsh-browser/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** 只作用于已附着的本地 Session；关闭最后一个标签页返回 null。 */
export interface BrowserApi {
  /**
   * 执行人工导航或标签页操作；不会授予或复用模型工具审批。
   * @param request - 会话身份与严格校验的人工操作。
   * @param signal - HTTP 请求取消信号，传给浏览器提供方。
   * @returns 最新状态；最后一个标签页关闭时为 null。
   */
  control(
    request: RpcRequest<{ sessionId: SessionId; command: BrowserHumanCommand }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<BrowserSessionState | null>>
}
