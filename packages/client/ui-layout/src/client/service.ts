/**
 * `ctx.layout` 的跨插件视图动作。布局几何仍由 root entry 的 store 持有；服务
 * 只转发布局动作，并向会话页头与工作台顶栏提供由 AppFrame 投影的工作台可见状态。
 */
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SnapshotStore,
} from 'coding-client-runtime/client'
import type { BoundActions } from 'coding-client-ui-slots'
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
  /** 返回指定工作区的工作台状态源。 */
  workbench(key: string): ObservableSnapshot<WorkbenchLayoutSnapshot>
  /** 打开指定工作区的工作台并关闭详情栏。 */
  openWorkbench(key: string): void
  /** 关闭指定工作区的右侧工作台，保留正在显示的底栏。 */
  closeWorkbench(key: string): void
  /** 切换指定工作区的工作台；打开时同时关闭详情栏。 */
  toggleWorkbench(key: string): void
  /** 切换指定工作区的工作台最大化偏好。 */
  toggleWorkbenchFullscreen(key: string): void
  /** 切换指定工作区的终端底栏；右侧工作台关闭时仅显示底栏。 */
  toggleWorkbenchBottom(key: string): void
  /** 隐藏指定工作区的终端底栏；已隐藏时不改变工作台或详情栏。 */
  closeWorkbenchBottom(key: string): void
  /** 欢迎页两面板入口：打开其中一个时隐藏另一面板。 */
  toggleHeroPanel(key: string, panel: 'bottom' | 'files'): void
}

/** `ctx.layout` 的具体实现。 */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #views: SnapshotStore<Readonly<Record<string, WorkbenchLayoutSnapshot | undefined>>> = createSnapshotStore({})
  #sources = new Map<string, ObservableSnapshot<WorkbenchLayoutSnapshot>>()

  /**
   * 接管 root entry 当前实例的绑定 actions；重新注册时新实例会替换旧引用。
   * @param actions - root 布局 store 的绑定 actions。
   * @returns 无返回值。
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** 返回指定工作区的工作台状态源。 */
  workbench(key: string): ObservableSnapshot<WorkbenchLayoutSnapshot> {
    let source = this.#sources.get(key)
    if (source !== undefined) return source
    source = {
      getSnapshot: () => this.#views.getSnapshot()[key] ?? CLOSED_WORKBENCH,
      subscribe: listener => this.#views.subscribe(listener),
    }
    this.#sources.set(key, source)
    return source
  }

  /** 由 AppFrame 发送一个工作区的已解析工作台状态。
   * @param key - 工作区键；没有工作区服务时可使用会话 id。
   * @param next - 只包含页头入口与视图控制需要的状态。
   * @returns 无返回值。
   */
  publishWorkbench(key: string, next: WorkbenchLayoutSnapshot): void {
    const current = this.#views.getSnapshot()[key]
    if (current?.open === next.open
      && current.fullscreen === next.fullscreen
      && current.bottomOpen === next.bottomOpen) return
    this.#views.set({ ...this.#views.getSnapshot(), [key]: next })
  }

  /**
   * 删除已经不再被活动会话使用的工作区状态源快照。
   * @param keys - 仍然存活的工作区键。
   * @returns 无返回值。
   */
  retainWorkbenchViews(keys: readonly string[]): void {
    const retained = new Set<string>(keys)
    const current = this.#views.getSnapshot()
    let changed = false
    const next: Record<string, WorkbenchLayoutSnapshot | undefined> = {}
    for (const [key, state] of Object.entries(current)) {
      if (!retained.has(key)) {
        changed = true
        this.#sources.delete(key)
        continue
      }
      next[key] = state
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

  /** 打开指定工作区的工作台。 */
  openWorkbench(key: string): void {
    this.#require().openWorkbench(key)
  }

  /** 关闭指定工作区的右侧工作台，保留正在显示的底栏。 */
  closeWorkbench(key: string): void {
    this.#require().closeWorkbench(key)
  }

  /** 切换指定工作区的工作台。 */
  toggleWorkbench(key: string): void {
    this.#require().toggleWorkbench(key)
  }

  /** 切换指定工作区的工作台最大化偏好。 */
  toggleWorkbenchFullscreen(key: string): void {
    this.#require().toggleWorkbenchFullscreen(key)
  }

  /** 切换指定工作区的终端底栏；右侧工作台关闭时仅显示底栏。 */
  toggleWorkbenchBottom(key: string): void {
    this.#require().toggleWorkbenchBottom(key)
  }

  /** 隐藏指定工作区的终端底栏。 */
  closeWorkbenchBottom(key: string): void {
    this.#require().closeWorkbenchBottom(key)
  }

  /**
   * 欢迎页专用互斥面板入口。
   * @param key - 当前工作区键。
   * @param panel - 要切换的底栏或 `files` 工作台右栏。
   * @returns 无返回值。
   */
  toggleHeroPanel(key: string, panel: 'bottom' | 'files'): void {
    this.#require().toggleHeroPanel(key, panel)
  }

  #require(): PanelActions {
    // UI 手势只能在 root entry 首次渲染并接线后触发；未接线表示启动顺序错误。
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
