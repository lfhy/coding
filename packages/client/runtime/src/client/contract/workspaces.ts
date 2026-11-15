/**
 * The outward workspaces-service face — what `ctx.workspaces` exposes to
 * feature packages and the renderer host, and therefore exactly what the
 * test runtime's workspaces double must implement. Wire-pump entry points
 * (handleHostEnvelope/handleConnected/refresh/startInitialSelection) stay on
 * the concrete class. Widening this interface is the explicit act of
 * widening what features may do to the workspaces domain.
 */
import type { DirectoryListing, SessionId, WorkspaceId, WorkspaceView } from 'coding-api-remotes/client'
import type { WorkspaceListState } from '../workspaces/service.ts'
import type { ObservableSnapshot } from './store.ts'

/** The workspaces-service face injected as `ctx.workspaces`. */
export interface IWorkspaces {
  /** The useWorkspaces standard feed (read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<WorkspaceListState>
  /**
   * Connect a Workspace to its reusable or freshly created blank session.
   * @param workspaceId - target workspace.
   * @returns the connected session id.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * 新建会话流程：连接显式、当前会话所属或最近使用的工作区并打开结果；
   * 失败通过 `WorkspaceListState.startSessionError` 投影为可重试的 UI 动作。
   * @param workspaceId - 显式目标；省略时先沿用当前会话工作区，再回退到最近工作区。
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * 在 Host 用户 HOME 目录创建不归属工作区的空白会话，但不改变当前选择。
   * @returns 已可寻址的会话 id。
   */
  connectHome(): Promise<SessionId>
  /**
   * 在 Host 用户 HOME 目录创建并打开一个不归属工作区的会话。
   * @returns 新会话在列表中可同步寻址后完成。
   */
  startSessionWithoutWorkspace(): Promise<void>
  /**
   * 注册已有目录；可选标题只用于新工作区，重复采用保留原有标题。
   * @param input - Host 创建请求；`path` 是本地目录，`title` 是可选显示名。
   * @returns 新建或已注册的工作区视图。
   */
  create(input: { path: string; title?: string }): Promise<WorkspaceView>
  /**
   * Open the Host's native directory picker.
   * @returns the selected path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * 经 Host 的 `browse` 能力列举一层目录。
   * @param path - 要列举的绝对目录；省略时列举 Host 用户主目录。
   * @param signal - 调用方改主意时中断线上请求（同时停掉 Host 侧扫描）。
   * @returns 该层条目、同层文件与面包屑祖先链。
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * 经 Host 的 `browse` 能力新建一个子目录。
   * @param path - 已存在的绝对父目录。
   * @param name - 单个非空白路径段。
   * @returns 新目录的绝对路径。
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * 经 Host 的 `browse` 能力在同一父目录下改名（文件与目录都支持）。
   * @param path - 要改名的条目绝对路径。
   * @param nextName - 单个非空白路径段。
   * @returns 改名后的绝对路径。
   */
  renameDirectoryEntry(path: string, nextName: string): Promise<string>
  /**
   * 经 Host 的 `browse` 能力删除条目（文件，或连同内容的目录）。破坏性操作：
   * 二次确认由调用方持有，本方法一经调用立即删除。
   * @param path - 要删除的条目绝对路径。
   */
  deleteDirectoryEntry(path: string): Promise<void>
  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  openPath(path: string): Promise<void>
  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - the new display title.
   * @returns the updated Workspace view.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  /**
   * Delete a Workspace (its sessions fall back to the unaccounted group).
   * @param workspaceId - target workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>
  /**
   * Move a Workspace within the registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  /**
   * Move an accounted session within/into a Workspace's ordered list.
   * @param workspaceId - target workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>
  /**
   * Archive a session into the registry-global set (hidden from grouping
   * surfaces; session log and accounting slot remain). Archiving the current
   * session clears the selection into the New Session view state.
   * @param sessionId - session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
}
