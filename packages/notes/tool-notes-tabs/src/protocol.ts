/** 笔记标签的浏览器到 Host 发布协议；客户端只发送笔记根目录下的相对路径。 */

/** 当前页面完整标签状态。`version` 在同一窗口会话内单调递增，重新挂载可重置为 1。 */
export interface NotesTabsPublishRequest {
  readonly sessionId: string
  readonly windowId: string
  readonly version: number
  readonly openTabs: readonly string[]
  readonly activeTabPath: string | null
  readonly activeKind: 'note' | 'ppt'
}

/** Host 接受完整快照后的回执；失败响应的 `error` 是稳定代码。 */
export type NotesTabsPublishResponse =
  | { readonly ok: true; readonly sessionId: string; readonly windowId: string; readonly version: number }
  | { readonly ok: false; readonly error: 'invalid' | 'stale' | 'session-mismatch' }
