/**
 * workspace domain contract. Wire projection of the host-side workspace
 * entity (@deepseek-ai/dsh-workspace): a stable id over a directory path,
 * a display title, and the ordered session account. Method signatures are the
 * source of truth, same as the sessions domain.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Git 工作树中一个已变更文件及其相对仓库根的路径。 */
export interface GitChangedFile {
  path: string
  status: string
  additions: number
  deletions: number
}

/** 当前会话目录所属 Git 仓库的状态；不属于仓库时返回 null。 */
export interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: GitChangedFile[]
}

/** 仓库的全部本地分支及当前分支；游离 HEAD 的 current 为 null。 */
export interface GitBranches {
  branches: string[]
  current: string | null
}

export const GIT_HISTORY_DEFAULT_COUNT = 60
export const GIT_HISTORY_MAX_COUNT = 300

/** 一次 Git 历史读取的请求范围；from 必须是完整提交哈希。 */
export interface GitHistoryQuery {
  /** 省略时读取 60 条；最多 300 条。 */
  count?: number
  /** 从该提交（含）沿父边读取；省略时从全部 refs 与 HEAD 读取。 */
  from?: string
}

/** 一个提交及其在 DAG 中的直接父提交（按父顺序）。 */
export interface GitCommit {
  /** 完整提交哈希。 */
  id: string
  parents: string[]
  subject: string
  author: string
  /** 作者时间，ISO-8601 且保留作者自己的时区偏移。 */
  authoredAt: string
  /** 指向该提交的本地／远端跟踪分支短名及 `tag: <name>` 标签。 */
  refs: string[]
}

/** 最近的提交，按 `git log --topo-order --all HEAD` 的拓扑顺序；非仓库时整个值为 null。 */
export interface GitHistory {
  /** 本次实际返回的提交，最多 300 条。 */
  commits: GitCommit[]
  /** 已有超过本次请求条数的提交，调用方可增加 count 重新请求。 */
  truncated: boolean
  /** 当前分支；游离 HEAD 为 null。 */
  current: string | null
  /** 全部 `refs/heads` 的短名（不只是已返回提交上的分支）。 */
  branches: string[]
}

/** 一次 Git 远端操作的凭据；值绝不回显，只在请求方向上携带明文。 */
export interface GitCredentials {
  username: string
  password: string
  /** 远端操作成功后把这组凭据保存到本机凭据存储；省略时只用于本次请求。 */
  remember?: boolean
}

export interface GitOperationResult {
  branch: string | null
  commitCreated: boolean
  commit?: string
}


/**
 * Wire-side workspace id brand. Deliberately re-declared here rather than
 * imported from dsh-workspace: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/** One workspace row: the record projection every workspace.* value carries. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** 显示标题；首次创建默认使用本地路径的 basename，也可显式指定。 */
  title: string
  /**
   * Sessions accounted under this workspace, in manually owned order
   * (attach prepends, insertSessionBefore reorders; activity never does).
   */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** Workspace-domain unary methods (the map keys workspace.* of RpcMethodMap). */
export interface WorkspaceApi {
  /** 查询当前会话 cwd 的 Git 状态；非 Git 目录返回 null，远端工作区显式拒绝。 */
  gitStatus(request: RpcRequest<{ sessionId: SessionId }>, signal: AbortSignal): Promise<RpcResponse<GitStatus | null>>

  /** 查询已有本地分支；非 Git 目录返回 null，远端工作区显式拒绝。 */
  gitBranches(request: RpcRequest<{ sessionId: SessionId }>, signal: AbortSignal): Promise<RpcResponse<GitBranches | null>>

  /** 查询只读提交 DAG；非 Git 目录返回 null，远端工作区显式拒绝。 */
  gitHistory(request: RpcRequest<{ sessionId: SessionId } & GitHistoryQuery>, signal: AbortSignal): Promise<RpcResponse<GitHistory | null>>

  /** 只切换已有本地分支；未提交改动阻止切换，成功后返回最新状态。 */
  gitCheckout(request: RpcRequest<{ sessionId: SessionId; branch: string }>, signal: AbortSignal): Promise<RpcResponse<GitStatus>>

  /**
   * 明确用户操作：提交该仓库全部未忽略的工作树改动，然后推送其当前上游分支。
   * 认证依次尝试宿主凭据助手、本机已保存的凭据和本次显式凭据；前两级都失败时以
   * git-auth-required 作答，调用方可带 credentials 重试，成功后按 remember 保存凭据。
   */
  gitPush(request: RpcRequest<{ sessionId: SessionId; credentials?: GitCredentials }>, signal: AbortSignal):
  Promise<RpcResponse<GitOperationResult>>

  /** 从当前上游拉取；冲突以 git-conflict 错误返回，保留 Git 的冲突现场。认证与 remember 同 gitPush。 */
  gitPull(request: RpcRequest<{ sessionId: SessionId; credentials?: GitCredentials }>, signal: AbortSignal):
  Promise<RpcResponse<GitOperationResult>>

  /**
   * Lists all workspaces in the registry's durable display order, plus the
   * registry-global archive set (the reconnect baseline of
   * `host/archived-sessions-changed`). Archived sessions stay in their
   * workspace's `sessionIds` account; grouping surfaces hide them.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }>>

  /**
   * 为已有目录创建或查找工作区，不创建目录；路径不存在或不是目录时返回
   * `workspace-invalid-path`。规范路径已有工作区时返回该记录与 `created: false`，
   * 不修改原标题。新记录使用可选非空 `title`，否则使用本地路径的 basename；
   * 不同规范路径允许使用相同标题。
   */
  create(request: RpcRequest<{ path: string; title?: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>

  /**
   * Renames a workspace. `title` is trimmed and must be non-empty
   * (schema-enforced). An unknown id fails with `workspace-not-found`; a
   * title equal to another workspace's fails with `workspace-name-conflict`.
   * Renaming to the current title is a no-op success (no durable write).
   */
  rename(request: RpcRequest<{ workspaceId: WorkspaceId; title: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Removes one Workspace registration. The directory, every user file, and
   * every session log remain untouched; those Sessions consequently become
   * ungrouped. An unknown id fails with `workspace-not-found`.
   */
  delete(request: RpcRequest<{ workspaceId: WorkspaceId }>):
  Promise<RpcResponse<{ deleted: true }>>

  /**
   * Moves one Workspace within the registry display order,
   * DOM-insertBefore-like. An omitted anchor appends to the end.
   */
  insertBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    beforeWorkspaceId?: WorkspaceId
  }>): Promise<RpcResponse<{ workspaceIds: WorkspaceId[] }>>

  /**
   * Moves an accounted session within its workspace's manual order,
   * DOM-insertBefore-like: with `beforeSessionId` the session is inserted
   * before that anchor; omitted appends to the end. An unknown workspace
   * fails with `workspace-not-found`; a session or anchor not accounted by
   * the workspace fails with `workspace-move-invalid`. A move to the current
   * position is a no-op success.
   */
  insertSessionBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    beforeSessionId?: SessionId
  }>): Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Adds one session to the registry-global archive set: the session
   * disappears from every grouping surface but keeps its session log and its
   * workspace accounting slot (a future unarchive restores its position).
   * Idempotent for an already archived id. A session neither live nor in
   * session persistence fails with `session-not-found`. Returns the full
   * updated set (same snapshot the changed frame carries).
   */
  archiveSession(request: RpcRequest<{ sessionId: SessionId }>):
  Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>
}
