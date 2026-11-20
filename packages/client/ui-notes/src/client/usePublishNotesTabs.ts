import { useEffect, useRef } from 'react'

/** 会话页面打开时发布当前标签，窗口刷新后重新认领；服务端仅接受已核验的相对路径。 */
const WINDOW_ID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `notes-${Date.now()}-${Math.random().toString(36).slice(2)}`
const HEARTBEAT_MS = 10_000

/**
 * 发布经过目录加载确认的标签快照；重放和多窗口安全判断由 Host 持有。
 * @param sessionId - 页面的笔记专用会话 ID。
 * @param paths - 当前页可见的打开标签。
 * @param activePath - 当前中央显示的文件，欢迎页为 null。
 * @param ready - 目录首次加载完成后才可发布，避免把未校验的本地缓存发给 Host。
 */
export function usePublishNotesTabs(sessionId: string, paths: readonly string[], activePath: string | null, ready: boolean): void {
  const version = useRef(0)
  const snapshot = useRef({ paths, activePath })
  const sessionRef = useRef(sessionId)
  snapshot.current = { paths, activePath }
  sessionRef.current = sessionId
  useEffect(() => {
    if (!ready) return
    const publish = () => {
      const { paths: tabs, activePath: active } = snapshot.current
      const body = {
        sessionId: sessionRef.current, windowId: WINDOW_ID, version: ++version.current,
        openTabs: tabs, activeTabPath: active,
        activeKind: active !== null && /\.pptx$/iu.test(active) ? 'ppt' : 'note',
      }
      void fetch('/api/notes/tabs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .catch(() => { /* 服务不可用时由工具明确报告未发布，而非猜测当前标签。 */ })
    }
    publish()
    const timer = window.setInterval(publish, HEARTBEAT_MS)
    return () => { window.clearInterval(timer) }
  }, [sessionId, ready])
}
