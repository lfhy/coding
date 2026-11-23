/** 工作区业务动作及面向界面的列表投影。 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DirectoryListing, IApiClient, RpcError,
  SessionId, WorkspaceId, WorkspaceView,
} from 'coding-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsPort, SessionsPortList } from '../contract/sessions-port.ts'
import type { IWorkspaces } from '../contract/workspaces.ts'
import { WorkspaceManager, type WorkspaceListPhase } from './manager.ts'

/** Workspace list plus the two-baseline readiness and default-target projection. */
export interface WorkspaceListState {
  items: readonly WorkspaceView[]
  /**
   * Registry-global archive set in Host order: grouping surfaces hide these
   * sessions everywhere (workspace groups and the ungrouped bucket) while
   * their session logs and workspace accounting slots remain. A plain array
   * (store-engine vocabulary; immer drafts reject Sets) — membership lookups
   * build their own transient Set.
   */
  archivedSessionIds: readonly SessionId[]
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
  /** True only after both workspace.list and session.list have succeeded. */
  baselinesReady: boolean
  /** Most recently active Workspace, derived without changing `items` order. */
  recentWorkspaceId: WorkspaceId | undefined
  /** 最近一次显式新建会话失败；供界面按目标重试。 */
  startSessionError?: WorkspaceStartSessionError
}

/** 面向 UI 投影、可重试的新建会话失败。 */
export interface WorkspaceStartSessionError {
  /** 单调递增的 attempt；新尝试会替换旧错误。 */
  attempt: number
  /** 失败动作选中的工作区，供重试沿用。 */
  workspaceId: WorkspaceId
  /** 从拒绝原因提取、可安全展示的文本。 */
  message: string
}

/** 将会话创建错误压成不重复操作前缀的可显示文本。 */
function startSessionErrorMessage(reason: unknown): string {
  if (!(reason instanceof Error)) return String(reason)
  const rpcError = (reason as { rpcError?: { message?: unknown } }).rpcError
  return typeof rpcError?.message === 'string' ? rpcError.message : reason.message
}

/** 判断一次新会话失败是否来自浏览器到 Host 的传输层。 */
function isTransportFailure(message: string): boolean {
  return /failed to fetch|fetch failed|networkerror|transport failure/iu.test(message)
}

/** Structured create failure for UI flows that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorkspaceCreateError'
  }
}

/** Structured browse failure so the directory browser can branch on Host business codes. */
export class DirectoryBrowseError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'DirectoryBrowseError'
  }
}

/** Host 打开失败时的稳定上下文前缀；Host 与 Client 共用同一个，避免重复。 */
const PATH_OPEN_FAILED = 'path open failed: '

/** 命中远端占位目录本身或其内部路径：捕获远端目录名与相对剩余部分。 */
const REMOTE_WORKSPACE_SEGMENT = /(?:^|[\\/])remote-workspaces[\\/][a-f0-9]{20}[\\/]([A-Za-z0-9_-]+)-[a-f0-9]{20}((?:[\\/].*)?)$/u

/**
 * 把远端工作区的本地占位路径换成可展示的名字。
 *
 * marker 目录名是 `<远端目录名>-<20 位哈希>`，哈希只是本地路由身份；界面里显示它等于
 * 把内部标识当成路径给用户看。占位目录本身显示成远端目录名，目录内部显示成
 * `<远端目录名>/<相对路径>`。非远端路径返回 `undefined`，调用方据此保留原路径。
 * @param path - 会话 cwd 或工具调用的工作目录。
 * @returns 可展示的名字；不是远端占位路径时为 undefined。
 */
export function remoteWorkspaceDisplayPath(path: string): string | undefined {
  const matched = REMOTE_WORKSPACE_SEGMENT.exec(path)
  const label = matched?.[1]
  if (label === undefined) return undefined
  const rest = (matched?.[2] ?? '').replace(/^[\\/]+/u, '')
  return rest === '' ? label : `${label}/${rest}`
}

export class WorkspaceRuntime implements IWorkspaces {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<WorkspaceListState>
  /** Workspace baseline and frame owner. */
  private readonly manager: WorkspaceManager
  /** 同一工作区的在途空白会话创建；重复点击使用同一结果。 */
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  /** Guards the runtime-owned one-shot initial-selection subscription. */
  private initialSelectionStarted = false
  /** 显式新建会话的单调 attempt，旧完成结果不能覆盖新尝试。 */
  private startSessionAttempt = 0
  /** 新建期间改变当前选择时，撤回该请求的导航权。 */
  private startingSession: { source: SessionId | undefined } | undefined
  /** 最近一次显式新建会话失败，随工作区列表一起投影。 */
  private startSessionError: WorkspaceStartSessionError | undefined

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - cross-domain sessions face used for recency and blank-session reuse.
   */
  constructor(private readonly ctx: Context, private readonly api: IApiClient, private readonly sessions: SessionsPort) {
    this.manager = new WorkspaceManager(api)
    this.list = createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'pending', error: null,
      baselinesReady: false, recentWorkspaceId: undefined,
    })
    this.manager.subscribe(() => { this.project() })
    this.sessions.list.subscribe(() => {
      if (this.startingSession !== undefined && this.sessions.list.getSnapshot().current !== this.startingSession.source) {
        this.startingSession = undefined
      }
      this.project()
    })
    ctx.reflect.provide('workspaces', this, undefined)
  }

  /**
   * 复用或创建指定工作区的空白会话；远端连接不属于这一步。
   * 调用方负责导航，也可在打开前先把草稿移交给目标会话。
   * @param workspaceId - 列表里的目标工作区。
   * @returns 已进入列表、可同步寻址的会话 id。
   */
  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspaces.connectWorkspace: unknown workspace ${workspaceId}`)
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight
    // 空白会话由本地 Host 持有；打开输入页不需要远程连接。
    const reusable = this.reusableBlankSession(workspace)
    if (reusable !== undefined) return reusable
    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  /**
   * 找出该工作区当前可复用的空白会话。复用必须同时满足成员关系（id 在
   * sessionIds 里）与同一 canonical cwd——那是 Host 自己的归属规则；仅凭 cwd
   * 命中会打开一个没有归属账号的会话。已归档的空白会话永不复用：打开它也无处
   * 展示，新建更符合预期。
   * @param workspace - 目标工作区。
   * @returns 可复用的空白会话 id；没有时 undefined。
   */
  private reusableBlankSession(workspace: WorkspaceView): SessionId | undefined {
    const archived = this.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }
    return undefined
  }

  /**
   * 解析会话所属的工作区键，供按工作区共享的界面状态（底栏终端、布局偏好）使用。
   * @param sessionId - 当前会话。
   * @returns 工作区 id；会话没有归属工作区时退回它的 cwd，再退回 `'home'`。
   */
  workspaceKeyOf(sessionId: SessionId): string {
    const workspace = this.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))
    if (workspace !== undefined) return workspace.workspaceId
    const summary = this.sessions.list.getSnapshot().byId[sessionId]
    return summary?.cwd ?? 'home'
  }

  /**
   * Follow the first complete Workspace/Session baseline and select a default
   * session exactly once. A restored current session wins; otherwise the most
   * recent Workspace is connected (reusing or creating its blank session).
   * Later explicit clears stay cleared instead of retriggering this startup
   * policy. A failed connect may retry on the next baseline projection.
   * @returns disposer for the baseline subscription; late work cannot navigate after disposal.
   */
  startInitialSelection(): () => void {
    if (this.initialSelectionStarted) {
      throw new Error('workspaces.startInitialSelection: already started')
    }
    this.initialSelectionStarted = true
    let state: 'waiting' | 'connecting' | 'done' = 'waiting'
    let disposed = false
    const reconcile = (): void => {
      if (disposed || state !== 'waiting') return
      const workspace = this.list.getSnapshot()
      if (!workspace.baselinesReady) return
      const current = this.sessions.list.getSnapshot().current
      const target = workspace.recentWorkspaceId
      if (current !== undefined || target === undefined) {
        state = 'done'
        return
      }
      state = 'connecting'
      void this.connectWorkspace(target).then(
        (sessionId) => {
          if (disposed) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          state = 'done'
        },
        (reason: unknown) => {
          if (disposed) return
          state = 'waiting'
          console.warn('initial workspace selection failed:', reason)
        },
      )
    }
    const unsubscribe = this.list.subscribe(reconcile)
    reconcile()
    return () => {
      disposed = true
      unsubscribe()
    }
  }

  /**
   * 新建入口依次采用明确目标、当前会话归属和最近工作区；无目标时显示空白入口页。
   * 连接远端不阻塞打开空白页；创建期间切走后，迟到结果不抢回导航。
   * @param workspaceId - 分组等入口明确指定的工作区。
   */
  startSession(workspaceId?: WorkspaceId): void {
    const attempt = ++this.startSessionAttempt
    const hadError = this.startSessionError !== undefined
    this.startSessionError = undefined
    const workspace = this.list.getSnapshot()
    const current = this.sessions.list.getSnapshot().current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
    const request = { source: current }
    this.startingSession = target === undefined ? undefined : request
    if (hadError) this.project()
    if (target === undefined) {
      this.sessions.clear()
      return
    }
    void this.connectWorkspace(target).then(
      (sessionId) => {
        if (this.startingSession !== request) return
        this.startingSession = undefined
        this.sessions.open(sessionId)
        this.startSessionError = undefined
        this.project()
      },
      (reason: unknown) => {
        if (this.startingSession !== request) return
        this.startingSession = undefined
        const message = startSessionErrorMessage(reason)
        if (isTransportFailure(message)) {
          const connection = this.ctx.get('connection') as { reconnect?: () => void } | undefined
          connection?.reconnect?.()
        }
        this.startSessionError = { attempt, workspaceId: target, message }
        this.project()
        console.warn('new session failed:', reason)
      },
    )
  }

  /**
   * 在 Host 用户 HOME 目录创建未分组会话；使用 Host 返回的路径，不猜测浏览器所在机器的 HOME。
   * @returns 已可寻址的会话 id。
   */
  async connectHome(): Promise<SessionId> {
    const response = await this.api.host.describe({})
    if (!response.result.ok) throw new Error(`host.describe failed: ${response.result.error.message}`)
    return await this.sessions.create({ cwd: response.result.value.home })
  }

  /** 创建并选择一个以 Host 用户 HOME 为目录的未分组会话；失败交给调用方呈现。 */
  async startSessionWithoutWorkspace(): Promise<void> {
    const sessionId = await this.connectHome()
    this.sessions.open(sessionId)
  }

  /**
   * 注册已有目录；可选标题只在首次创建时提交，重复采用不会覆盖原标题。
   * @param input - Host 创建请求，包含本地路径与可选显示名。
   * @returns 新建或已注册的工作区视图。
   */
  async create(input: { path: string; title?: string }): Promise<WorkspaceView> {
    const result = await this.manager.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  /**
   * Open the Host's native directory picker (the `native` capability).
   * @returns the selected path, or null when the user cancelled.
   */
  async pickDirectory(): Promise<string | null> {
    const response = await this.api.host.pickDirectory({})
    if (!response.result.ok) {
      throw new Error(`directory picker failed: ${response.result.error.message}`)
    }
    return response.result.value.path
  }

  /**
   * 经 Host 的 `browse` 能力列举一层目录。
   * @param path - 要列举的绝对目录；省略时列举 Host 用户主目录。
   * @param signal - 调用方改主意时中断线上请求（同时停掉 Host 侧扫描）。
   * @returns 该层条目、同层文件与面包屑祖先链。
   */
  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const response = await this.api.host.listDirectory(path === undefined ? {} : { path }, signal)
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * 经 Host 的 `browse` 能力新建一个子目录。
   * @param path - 已存在的绝对父目录。
   * @param name - 单个非空白路径段。
   * @returns 新目录的绝对路径。
   */
  async createDirectory(path: string, name: string): Promise<string> {
    const response = await this.api.host.createDirectory({ path, name })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value.path
  }

  /**
   * 经 Host 的 `browse` 能力在同一父目录下改名（文件与目录都支持）。
   * @param path - 要改名的条目绝对路径。
   * @param nextName - 单个非空白路径段。
   * @returns 改名后的绝对路径。
   */
  async renameDirectoryEntry(path: string, nextName: string): Promise<string> {
    const response = await this.api.host.renameDirectoryEntry({ path, name: nextName })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value.path
  }

  /**
   * 经 Host 的 `browse` 能力删除条目（文件，或连同内容的目录）。破坏性操作：
   * 二次确认由调用方持有，本方法一经调用立即删除。
   * @param path - 要删除的条目绝对路径。
   */
  async deleteDirectoryEntry(path: string): Promise<void> {
    const response = await this.api.host.deleteDirectoryEntry({ path })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
  }

  /**
   * 用 Host 操作系统的默认程序打开一个路径。
   * @param path - 绝对路径或 Host 能解析的路径。
   * @throws 当 Host 拒绝或打开失败时；Host 已经给出 `path open failed` 前缀时不再重复。
   */
  async openPath(path: string): Promise<void> {
    const response = await this.api.host.openPath({ path })
    if (!response.result.ok) {
      // Host 的 `openTarget` 已经带同一个前缀，这里只补缺失的上下文，避免出现两遍。
      const message = response.result.error.message
      throw new Error(message.startsWith(PATH_OPEN_FAILED) ? message : `${PATH_OPEN_FAILED}${message === '' ? 'unknown error' : message}`)
    }
  }

  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - new display title (trimmed non-empty by the Host).
   * @returns the renamed Workspace view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.manager.rename(workspaceId, title)
    if (!result.ok) throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Delete one Workspace registration. Sessions, session logs, and the
   * directory remain Host-owned outside this operation.
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.manager.delete(workspaceId)
    if (!result.ok) throw new Error(`workspace delete failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Move a Workspace within the durable registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.manager.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw new Error(`workspace reorder failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Archive a session into the registry-global set. Clearing an archived
   * current selection is the projection sweep's job (one rule for the local
   * echo and a remote tab's frame alike).
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.manager.archiveSession(sessionId)
    if (!result.ok) throw new Error(`session archive failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Move a session within its Workspace's manual order (DOM-insertBefore-like).
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Refresh the workspace baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started workspace baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refresh()
  }

  /**
   * Route a Host stream envelope into the Workspace object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<WorkspaceManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Workspace baseline after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  private project(): void {
    const workspace = this.manager.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready'
    // An archived current selection clears into the New Session view state —
    // a hidden row must not stay open behind the list. Sweeping here covers
    // every install path with one rule: the local unary echo, another tab's
    // changed frame, and a reconnect baseline restoring a persisted
    // selection that was archived while this client was away.
    if (sessions.current !== undefined && workspace.archivedSessionIds.includes(sessions.current)) {
      this.sessions.clear()
    }
    this.list.set({
      items: workspace.items,
      archivedSessionIds: workspace.archivedSessionIds,
      state: workspace.state,
      phase: workspace.phase,
      error: workspace.error,
      baselinesReady,
      recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
      ...(this.startSessionError === undefined ? {} : { startSessionError: this.startSessionError }),
    })
  }
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionsPortList['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
