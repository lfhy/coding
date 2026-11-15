/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog shared with the browser).
 *
 * Each registration also declares one **directory-flow hole** (`single`
 * kind): the slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * Two holes exist because the two menu surfaces are independent slot entries
 * and a hole has exactly one declaring entry — they carry the same owner
 * contract and the same occupant.
 */
import type { HostDescriptionSource } from 'coding-client-connection/client'
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from 'coding-client-ui-sidebar/client'
import type {} from 'coding-client-ui-conversation/client'
import type {
  SessionId, SessionSearchResultItem, WorkspaceId, WorkspaceView,
} from 'coding-client-runtime/client'
import type { createWorkspaceViewStore } from '../stores.ts'

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

declare module 'coding-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = PropsHooks<DirectoryPickingInjected['hooks']>

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = {
  hooks: DirectoryPickingInjected['hooks'] & {
    /** Current generation's Host description, bound by the slot renderer. */
    hostDescription: HostDescriptionSource
  }
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session and
   * open it; without an explicit workspace, inherit the current Session
   * Workspace, then the recent Workspace, or clear into the New Session view.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /**
   * Search current visible conversation messages. The Host fixes the result
   * bound; `hasMore` means the query needs narrowing.
   */
  searchSessions: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** Maximum number of merged rows rendered for one search. */
  searchResultLimit: number
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a Workspace in the durable registry display order.
   * Omitted anchor appends to the end.
   */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /**
   * Archive a Session into the registry-global set: hidden from grouping
   * surfaces, log and accounting slot retained. Archiving the current
   * session clears the selection into the New Session view state.
   */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /**
   * Reorder a session inside its Workspace account (DOM-insertBefore
   * semantics: omitted anchor appends to the end). The view refreshes from
   * the Host response/changed frame; failures leave the order unchanged.
   */
  insertSessionBefore: (workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId) => Promise<void>
  /** 注册已选本地目录；可选标题只在新工作区创建时生效。 */
  createWorkspace: (input: { path: string; title?: string }) => Promise<WorkspaceView>
}

/** Full browser props: shell owner share + viewing store + injected actions + the locale seat. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & PropsHooks<WorkspaceBrowserInjected['hooks']>
  & PropsLocale<'workspace'>

/** 克隆仓库的一次请求；保存路径允许以 `~` 开头，HOME 由 Host 展开。 */
export interface GitCloneRequestInput {
  /** 远端地址：HTTPS、SSH 或本机路径。 */
  url: string
  /** 目标目录；`~/repo` 形式由 Host 解析成账户主目录下的路径。 */
  path: string
  /** 要检出的分支或标签；省略时使用远端 HEAD。 */
  ref?: string
  /** 只取该深度的历史。 */
  depth?: number
  /** HTTPS 代理；未安装 git 的内置实现不支持代理。 */
  proxy?: string
  /** 写入新仓库的用户身份，后续自动提交使用它。 */
  identity?: { name?: string; email?: string }
  credentials?: { username: string; password: string; remember?: boolean }
}

/** 克隆结果：实际目录、检出分支与本次使用的实现。 */
export interface GitCloneOutcome {
  path: string
  branch: string | null
  /** `cli` 是本机 git，`js` 是未安装 git 时使用的内置实现。 */
  mechanism: 'cli' | 'js'
}

/**
 * 克隆需要认证：前两级来源（宿主凭据助手、本机已保存凭据）都没有可用材料。
 * `credentialRef` 存在时表示这组已存凭据被拒，界面提示并允许清除它。
 */
export class GitCloneAuthRequired extends Error {
  /**
   * @param url - 需要认证的远端地址。
   * @param credentialRef - 被拒绝的本机已存凭据引用。
   */
  constructor(readonly url: string, readonly credentialRef?: string) {
    super('Git clone requires credentials')
    this.name = 'GitCloneAuthRequired'
  }
}

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** 注册已选本地目录；可选标题只在新工作区创建时生效。 */
  createWorkspace: (input: { path: string; title?: string }) => Promise<WorkspaceView>
  /** 创建并打开不归属任何工作区的会话。 */
  startUnscopedSession: () => Promise<void>
  /** 把远端仓库克隆到 Host 目录；需要认证时以 {@link GitCloneAuthRequired} 拒绝。 */
  cloneRepository: (input: GitCloneRequestInput) => Promise<GitCloneOutcome>
  /** 清除本机为该远端保存的 Git 凭据；本就没有保存时同样成功。 */
  forgetGitCredentials: (ref: string) => Promise<void>
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The two picker holes (blank-session hero / New-Session view)
 * share one owner currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>
