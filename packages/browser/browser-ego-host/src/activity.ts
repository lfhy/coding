/** 工具启动流：只公布计数、工具名与所属会话，不广播页面、画面或参数。 */
import type { ServerResponse } from 'node:http'
import type { SessionId } from 'coding-session/types'

interface Action { readonly tool: string; readonly at: number }
const clients = new Set<ServerResponse>()
const history = new Map<string, Action[]>()
const MAX_HISTORY = 20
let count = 0

/** 在工具通过 Host 会话复核、真正进入执行时发出一次活动通知并记录轻量历史。 */
export function markToolStart(sessionId: SessionId, tool = 'browser'): void {
  const at = Date.now()
  const name = tool.replace(/^ego_/, 'browser_')
  const list = history.get(sessionId) ?? []
  list.push({ tool: name, at })
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
  history.set(sessionId, list)
  const frame = `event: tool-call\ndata: ${JSON.stringify({ count: ++count, sessionId, tool: name, at })}\n\n`
  for (const client of clients) {
    if (client.destroyed) { clients.delete(client); continue }
    try { client.write(frame) } catch { clients.delete(client) }
  }
}

/** 面板重建时读取本会话最近动作；只保留工具名与时间，会话结束即丢弃。 */
export function recentActions(sessionId: SessionId): readonly Action[] {
  return history.get(sessionId) ?? []
}

/** 将已经验证的 HTTP 响应绑定到活动广播，连接关闭即解除引用。 */
export function subscribeActivity(res: ServerResponse): () => void {
  clients.add(res)
  const close = (): void => { clients.delete(res) }
  res.once('close', close)
  return close
}
