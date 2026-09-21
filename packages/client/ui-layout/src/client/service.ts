/**
 * `ctx.layout` 的跨插件视图动作。布局几何仍由 root entry 的 store 持有；服务
 * 只转发布局动作，并向会话页头与工作台顶栏提供由 AppFrame 投影的工作台可见状态。
 */
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** 框架从布局 store 绑定出的 action 集合。 */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** 会话页头入口与工作台顶栏视图控制共用的工作台显隐投影。 */
export interface WorkbenchLayoutSnapshot {
  open: boolean
  fullscreen: boolean
  bottomOpen: boolean
}

const CLOSED_WORKBENCH: WorkbenchLayoutSnapshot = {
  open: false,
  fullscreen: false,
  bottomOpen: false,
}

/** `ctx.layout` 的公开动作。 */
export interface ILayout {
  /** 切换导航栏展开状态。 */
  toggleSidebar(): void
  /** 打开详情栏；已打开时保持当前宽度。 */
  openDetails(): void
  /** 关闭详情栏。 */
  closeDetails(): void
  /** 返回指定 Session 的工作台状态源。 */
  workbench(sessionId: SessionId): ObservableSnapshot<WorkbenchLayoutSnapshot>
  /** 打开指定 Session 的工作台并关闭详情栏。 */
  openWorkbench(sessionId: SessionId): void
  /** 关闭指定 Session 的工作台。 */
  closeWorkbench(sessionId: SessionId): void
  /** 切换指定 Session 的工作台；打开时同时关闭详情栏。 */
  toggleWorkbench(sessionId: SessionId): void
  /** 切换指定 Session 的工作台最大化偏好。 */
  toggleWorkbenchFullscreen(sessionId: SessionId): void
  /** 切换指定 Session 的终端底栏。 */
  toggleWorkbenchBottom(sessionId: SessionId): void
}

/** `ctx.layout` 的具体实现。 */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #views: SnapshotStore<Readonly<Record<string, WorkbenchLayoutSnapshot | undefined>>> = createSnapshotStore({})
  #sources = new Map<SessionId, ObservableSnapshot<WorkbenchLayoutSnapshot>>()

  /**
   * 接管 root entry 当前实例的绑定 actions；重新注册时新实例会替换旧引用。
   * @param actions - root 布局 store 的绑定 actions。
   * @returns 无返回值。
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** 返回指定 Session 的工作台状态源。 */
  workbench(sessionId: SessionId): ObservableSnapshot<WorkbenchLayoutSnapshot> {
    let source = this.#sources.get(sessionId)
    if (source !== undefined) return source
    source = {
      getSnapshot: () => this.#views.getSnapshot()[sessionId] ?? CLOSED_WORKBENCH,
      subscribe: listener => this.#views.subscribe(listener),
    }
    this.#sources.set(sessionId, source)
    return source
  }

  /**
   * 由 AppFrame 发送一个 Session 的已解析工作台状态。
   * @param sessionId - 当前渲染的 Session。
   * @param next - 只包含页头入口与视图控制需要的状态。
   * @returns 无返回值。
   */
  publishWorkbench(sessionId: SessionId, next: WorkbenchLayoutSnapshot): void {
    const current = this.#views.getSnapshot()[sessionId]
    if (current?.open === next.open
      && current.fullscreen === next.fullscreen
      && current.bottomOpen === next.bottomOpen) return
    this.#views.set({ ...this.#views.getSnapshot(), [sessionId]: next })
  }

  /**
   * 删除已经不在会话列表中的状态源快照。
   * @param sessionIds - 仍然存活的 Session。
   * @returns 无返回值。
   */
  retainWorkbenchViews(sessionIds: readonly SessionId[]): void {
    const retained = new Set(sessionIds)
    const current = this.#views.getSnapshot()
    let changed = false
    const next: Record<string, WorkbenchLayoutSnapshot | undefined> = {}
    for (const [sessionId, state] of Object.entries(current)) {
      if (!retained.has(sessionId as SessionId)) {
        changed = true
        this.#sources.delete(sessionId as SessionId)
        continue
      }
      next[sessionId] = state
    }
    if (changed) this.#views.set(next)
  }

  /** 切换导航栏展开状态。 */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** 打开详情栏。 */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** 关闭详情栏。 */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /** 打开指定 Session 的工作台。 */
  openWorkbench(sessionId: SessionId): void {
    this.#require().openWorkbench(sessionId)
  }

  /** 关闭指定 Session 的工作台。 */
  closeWorkbench(sessionId: SessionId): void {
    this.#require().closeWorkbench(sessionId)
  }

  /** 切换指定 Session 的工作台。 */
  toggleWorkbench(sessionId: SessionId): void {
    this.#require().toggleWorkbench(sessionId)
  }

  /** 切换指定 Session 的工作台最大化偏好。 */
  toggleWorkbenchFullscreen(sessionId: SessionId): void {
    this.#require().toggleWorkbenchFullscreen(sessionId)
  }

  /** 切换指定 Session 的终端底栏。 */
  toggleWorkbenchBottom(sessionId: SessionId): void {
    this.#require().toggleWorkbenchBottom(sessionId)
  }

  #require(): PanelActions {
    // UI 手势只能在 root entry 首次渲染并接线后触发；未接线表示启动顺序错误。
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
