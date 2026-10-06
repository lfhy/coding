/** 以现有单面板工作台的会话级 store 为后端的外部标签动作。 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabRegistry } from './sidebar-tab-registry.ts'
import type { WorkbenchExternalParams, createRetainedWorkbenchStore } from './store.ts'

type WorkbenchActions = BoundActions<ReturnType<typeof createRetainedWorkbenchStore>>

/** 资源地址的路由选择和导航数据。 */
export interface SidebarRightOpenOptions {
  readonly kind?: string
  readonly params?: WorkbenchExternalParams
}

/** 类型入口只接收导航参数，地址由工作台合成为 `sidebar://<kind>`。 */
export type SidebarRightKindOptions = Pick<SidebarRightOpenOptions, 'params'>

/** 导航现有标签时可覆盖显示标题；地址仍由调用方提供。 */
export interface SidebarRightUpdateOptions {
  readonly address: string
  readonly name?: string
  readonly params?: WorkbenchExternalParams
}

/** 已选 Session 的右侧单面板动作；不宣称支持分栏、浮动或跨 Session 标签。 */
export interface ISidebarRight {
  openTab(kind: string, options?: SidebarRightKindOptions): void
  openTabForSession(sessionId: SessionId, kind: string, options?: SidebarRightKindOptions): void
  openResourceForSession(sessionId: SessionId, address: string, options?: SidebarRightOpenOptions): void
  focusTab(sessionId: SessionId, tabId: string): void
  updateTab(sessionId: SessionId, tabId: string, update: SidebarRightUpdateOptions): void
  closeTab(sessionId: SessionId, tabId: string): void
}

/** 在工作台 entry 挂载时接收框架绑定的 store actions。 */
export class SidebarRightController implements ISidebarRight {
  private actions: WorkbenchActions | undefined

  constructor(
    private readonly registry: SidebarRightTabRegistry,
    private readonly layout: { openWorkbench(sessionId: SessionId): void },
    private readonly currentSessionId: () => SessionId | undefined,
  ) {}

  /**
   * 绑定当前工作台实例。
   * @param actions - slot renderer 绑定的工作台动作。
   */
  attach(actions: WorkbenchActions): void {
    this.actions = actions
  }

  /** 工作台 slot 撤销后不再使用 renderer 已释放的 actions。 */
  detach(): void {
    this.actions = undefined
  }

  /** 注册项真正释放时关闭其在所有 Session 中仍保留的标签。 */
  closeDefinitionTabs(definitionId: string): void {
    this.actions?.closeExternalByDefinition(definitionId)
  }

  /** 打开当前选中 Session 的类型入口；无当前会话时明确失败。 */
  openTab(kind: string, options: SidebarRightKindOptions = {}): void {
    const sessionId = this.currentSessionId()
    if (sessionId === undefined) throw new Error('sidebarRight: no current session for openTab')
    this.openTabForSession(sessionId, kind, options)
  }

  /** 在指定 Session 打开类型入口，不更改当前会话选择。 */
  openTabForSession(sessionId: SessionId, kind: string, options: SidebarRightKindOptions = {}): void {
    this.openResourceForSession(sessionId, `sidebar://${encodeURIComponent(kind)}`, { kind, ...options })
  }

  /** 根据地址或显式 kind 路由并选中标签，随后展示该 Session 的工作台。 */
  openResourceForSession(sessionId: SessionId, address: string, options: SidebarRightOpenOptions = {}): void {
    const claim = this.registry.claim(address, options.kind)
    const definition = this.registry.get(claim.kind)
    if (definition === undefined) throw new Error(`sidebarRight: tab kind "${claim.kind}" disappeared`)
    this.requireActions().openExternalTab(sessionId, {
      definitionId: definition.id,
      kind: claim.kind,
      name: claim.title,
      address: claim.contentId,
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
    })
    this.layout.openWorkbench(sessionId)
  }

  /** 只聚焦已存在的标签；store 对已关闭的 id 保持幂等。 */
  focusTab(sessionId: SessionId, tabId: string): void {
    this.requireActions().activateTab(sessionId, tabId)
    this.layout.openWorkbench(sessionId)
  }

  /** 更新已存在的第三方标签，不影响同一 Session 的内置标签。 */
  updateTab(sessionId: SessionId, tabId: string, update: SidebarRightUpdateOptions): void {
    this.requireActions().updateExternalTab(sessionId, tabId, update)
  }

  /** 只关闭第三方标签，最后一个关闭时交还工作台菜单。 */
  closeTab(sessionId: SessionId, tabId: string): void {
    this.requireActions().closeExternalTab(sessionId, tabId)
  }

  private requireActions(): WorkbenchActions {
    if (this.actions === undefined) {
      throw new Error('sidebarRight: workbench actions are not wired (workbench entry not mounted)')
    }
    return this.actions
  }
}
