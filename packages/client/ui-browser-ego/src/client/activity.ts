/** 仅监听新工具活动，不读取任何页面、画面或模型文本。 */
import { parseActivity, validId } from './wire.ts'

export const WATCH_KIND = 'ego-browser:watch'
export const WATCH_ID = 'client.browser-ego.watch'

/**
 * 活动通道可缺席；重连后按服务端最近活动补足首次错过的页面。
 * @param open - 定向打开侧栏的调用方回调。
 * @param connect - 注入的 EventSource 工厂，便于测试断线和迟到事件。
 * @returns 停止监听并防止迟到通知的 disposer。
 */
export function watchActivity(open: (sessionId: string) => void,
  connect: (url: string) => EventSource = url => new EventSource(url)): () => void {
  let source: EventSource | null = null
  const seen = new Map<string, number>()
  const opened = new Set<string>()
  const pending = new Map<string, number>()
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let pendingRetry: ReturnType<typeof setTimeout> | null = null
  const retryPending = (): void => {
    pendingRetry = null
    for (const [sessionId] of pending) {
      try { open(sessionId); pending.delete(sessionId); opened.add(sessionId) }
      catch { /* 会话载入后再尝试；不会重复打开已成功的会话。 */ }
    }
    if (pending.size > 0 && !disposed && source !== null) pendingRetry = setTimeout(retryPending, 1500)
  }
  const accept = (raw: unknown): void => {
    if (disposed) return
    const activity = parseActivity(raw)
    if (!activity || !validId(activity.sessionId)) return
    const previous = seen.get(activity.sessionId) ?? 0
    if (activity.count <= previous) return
    seen.set(activity.sessionId, activity.count)
    if (opened.has(activity.sessionId)) return
    try {
      open(activity.sessionId)
      pending.delete(activity.sessionId)
      opened.add(activity.sessionId)
    } catch {
      pending.set(activity.sessionId, activity.count)
      if (pendingRetry === null) pendingRetry = setTimeout(retryPending, 1500)
    }
  }
  const onCall = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') return
    try { accept(JSON.parse(event.data) as unknown) } catch { /* 畸形通知不阻断后续活动。 */ }
  }
  const disconnect = (): void => {
    source?.removeEventListener('tool-call', onCall)
    source?.removeEventListener('error', onError)
    source?.close()
    source = null
  }
  const reconnect = (): void => {
    if (disposed) return
    try {
      source = connect('/api/ego/activity')
      source.addEventListener('tool-call', onCall)
      source.addEventListener('error', onError)
      if (pending.size > 0 && pendingRetry === null) pendingRetry = setTimeout(retryPending, 1500)
    } catch { scheduleRetry() }
  }
  const scheduleRetry = (): void => {
    if (retry === null && !disposed) retry = setTimeout(() => {
      retry = null
      reconnect()
    }, 1500)
  }
  const onError = (): void => {
    disconnect()
    if (pendingRetry !== null) clearTimeout(pendingRetry)
    pendingRetry = null
    scheduleRetry()
  }
  reconnect()
  return () => {
    disposed = true
    if (retry !== null) clearTimeout(retry)
    if (pendingRetry !== null) clearTimeout(pendingRetry)
    disconnect()
  }
}
