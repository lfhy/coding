/**
 * `ctx.layout` 的跨插件视图动作。布局几何由 root entry 的 store 持有，服务只
 * 转发其他插件需要触发的导航栏、详情栏和工作台状态转换。
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** 框架从布局 store 绑定出的 action 集合。 */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** `ctx.layout` 的公开动作。 */
export interface ILayout {
  /** 切换导航栏展开状态。 */
  toggleSidebar(): void
  /** 打开详情栏；已打开时保持当前宽度。 */
  openDetails(): void
  /** 关闭详情栏。 */
  closeDetails(): void
  /** 打开工作台并关闭详情栏。 */
  openWorkbench(): void
  /** 关闭工作台。 */
  closeWorkbench(): void
  /** 切换工作台；打开时同时关闭详情栏。 */
  toggleWorkbench(): void
}

/** `ctx.layout` 的具体实现。 */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined

  /**
   * 接管 root entry 当前实例的绑定 actions；重新注册时新实例会替换旧引用。
   * @param actions - root 布局 store 的绑定 actions。
   * @returns 无返回值。
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
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

  /** 打开工作台并关闭详情栏。 */
  openWorkbench(): void {
    this.#require().openWorkbench()
  }

  /** 关闭工作台。 */
  closeWorkbench(): void {
    this.#require().closeWorkbench()
  }

  /** 切换工作台；打开时同时关闭详情栏。 */
  toggleWorkbench(): void {
    this.#require().toggleWorkbench()
  }

  #require(): PanelActions {
    // UI 手势只能在 root entry 首次渲染并接线后触发；未接线表示启动顺序错误。
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
