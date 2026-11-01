/** 全局工具启动流只公布计数和会话身份，不广播任何页面、画面或参数。 */
import type { ServerResponse } from 'node:http'
import type { SessionId } from 'coding-session/types'

const clients = new Set<ServerResponse>()
let count = 0

/** 在工具通过 Host 会话复核、真正进入执行时发出一次活动通知。 */
export function markToolStart(sessionId: SessionId): void {
  const frame = `event: tool-call\ndata: ${JSON.stringify({ count: ++count, sessionId })}\n\n`
  for (const client of clients) {
    if (client.destroyed) { clients.delete(client); continue }
    try { client.write(frame) } catch { clients.delete(client) }
  }
}

/** 将已经验证的 HTTP 响应绑定到活动广播，连接关闭即解除引用。 */
export function subscribeActivity(res: ServerResponse): () => void {
  clients.add(res)
  const close = (): void => { clients.delete(res) }
  res.once('close', close)
  return close
}
