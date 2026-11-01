/** 仅监听新工具活动，不读取任何页面、画面或模型文本。 */
import { parseActivity, validId } from './wire.ts'

export const WATCH_KIND = 'ego-browser:watch'
export const WATCH_ID = 'client.browser-ego.watch'

/**
 * 活动通道可缺席；首次新事件即可按其确切会话打开一次面板。
 * @param open - 定向打开侧栏的调用方回调。
 * @param connect - 注入的 EventSource 工厂，便于测试断线和迟到事件。
 * @returns 停止监听并防止迟到通知的 disposer。
 */
export function watchActivity(open: (sessionId: string) => void,
  connect: (url: string) => EventSource = url => new EventSource(url)): () => void {
  let source: EventSource
  try { source = connect('/api/ego/activity') }
  catch { return () => {} }
  const seen = new Map<string, number>()
  const opened = new Set<string>()
  let disposed = false
  const onCall = (event: MessageEvent): void => {
    if (disposed || typeof event.data !== 'string') return
    let activity
    try { activity = parseActivity(JSON.parse(event.data) as unknown) }
    catch { return }
    if (!activity || !validId(activity.sessionId)) return
    const previous = seen.get(activity.sessionId) ?? 0
    if (activity.count <= previous) return
    seen.set(activity.sessionId, activity.count)
    if (opened.has(activity.sessionId)) return
    try {
      open(activity.sessionId)
      opened.add(activity.sessionId)
    } catch { /* 会话尚未装载时留给后续事件重试，人工入口仍可使用。 */ }
  }
  const onError = (): void => {
    // Host 尚未挂载活动路由时关闭自动重试；手动打开面板不依赖该通道。
    source.close()
  }
  source.addEventListener('tool-call', onCall)
  source.addEventListener('error', onError)
  return () => {
    disposed = true
    source.removeEventListener('tool-call', onCall)
    source.removeEventListener('error', onError)
    source.close()
  }
}
