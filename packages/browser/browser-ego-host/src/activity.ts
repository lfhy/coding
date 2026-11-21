/** 工具启动流：只公布计数、工具名与所属会话，不广播页面、画面或参数。 */
import type { ServerResponse } from 'node:http'
import type { SessionId } from 'coding-session/types'

interface Action { readonly tool: string; readonly at: number }
const clients = new Set<ServerResponse>()
const history = new Map<string, Action[]>()
const latest = new Map<string, { count: number; sessionId: string; tool: string; at: number }>()
const MAX_HISTORY = 20
let count = 0

/**
 * 会改变用户所见画面的工具：驱动页面、投递可见输入，或把页面交给用户操作。
 *
 * 只有这些调用会广播“展开视图”事件，让工作台自动为会话打开浏览器面板。
 * 未列出的工具一律按只读处理——列标签、读页面、截图、等待、查状态、查环境、
 * 同步登录态与任务空间准备都不会改变画面。为它们弹侧栏只会打断用户，
 * 所以这些调用仍然写入动作历史，只是不广播。
 *
 * 原始脚本类（`ego_js`、`ego_cdp`、`ego_cli`、`ego_script`）无从静态判断是否只读，
 * 按会驱动页面处理；`ego_tabs` 由 {@link revealsBrowserView} 按动作区分。
 */
const REVEALS: ReadonlySet<string> = new Set([
  'ego_navigate', 'ego_click', 'ego_fill', 'ego_key', 'ego_hover', 'ego_select', 'ego_drag',
  'ego_scroll', 'ego_check', 'ego_upload', 'ego_download', 'ego_dialog', 'ego_wait_for_human',
  'ego_js', 'ego_cdp', 'ego_cli', 'ego_script',
])

/**
 * 判断一次浏览器调用是否值得让工作台自动展开该会话的浏览器视图。
 *
 * 判断只决定是否广播“展开视图”事件，所有调用都仍然写入动作历史。
 * 未知工具名按不展开处理：宁可不打扰用户，也不要凭空弹出一个空侧栏。
 * @param tool - Host 侧工具名，带 `ego_` 前缀。
 * @param args - 已经收敛到当前会话的参数。
 * @returns 需要自动展开浏览器视图时为 true。
 */
export function revealsBrowserView(tool: string, args: Record<string, unknown>): boolean {
  // 标签页动作里只有 open、switch、close 改变用户看到的页面；list 与非法动作都不改变。
  if (tool === 'ego_tabs') {
    return args.action === 'open' || args.action === 'switch' || args.action === 'close'
  }
  return REVEALS.has(tool)
}

/**
 * 在工具通过 Host 会话复核、真正进入执行时记录一次动作。
 *
 * `reveal` 为 false 的调用只进历史，不广播也不参与重连回放：界面不应为只读查询
 * 自动展开视图。广播帧只含计数、会话、工具名与时间。
 * @param sessionId - 已确认存在的调用会话。
 * @param tool - Host 侧工具名，带 `ego_` 前缀。
 * @param reveal - 是否允许界面据此自动展开该会话的浏览器视图。
 */
export function markToolStart(sessionId: SessionId, tool = 'browser', reveal = true): void {
  const at = Date.now()
  const name = tool.replace(/^ego_/, 'browser_')
  const list = history.get(sessionId) ?? []
  list.push({ tool: name, at })
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
  history.set(sessionId, list)
  if (!reveal) return
  const activity = { count: ++count, sessionId, tool: name, at }
  latest.set(sessionId, activity)
  const frame = `event: tool-call\ndata: ${JSON.stringify(activity)}\n\n`
  for (const client of clients) {
    if (client.destroyed) { clients.delete(client); continue }
    try { client.write(frame) } catch { clients.delete(client) }
  }
}

/** 面板重建时读取本会话最近动作；只保留工具名与时间，会话结束即丢弃。 */
export function recentActions(sessionId: SessionId): readonly Action[] {
  return history.get(sessionId) ?? []
}

/** 连接后的最近活动由 Host 按存活会话筛选，避免页面晚于工具调用挂载时漏开。 */
export function replayActivity(res: ServerResponse, live: (sessionId: SessionId) => boolean): void {
  for (const item of latest.values()) {
    if (live(item.sessionId as SessionId)) res.write(`event: tool-call\ndata: ${JSON.stringify(item)}\n\n`)
  }
}

/** 将已经验证的 HTTP 响应绑定到活动广播，连接关闭即解除引用。 */
export function subscribeActivity(res: ServerResponse): () => void {
  clients.add(res)
  const close = (): void => { clients.delete(res) }
  res.once('close', close)
  return close
}
