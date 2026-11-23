/**
 * `ctx.layout` 的跨插件视图动作。布局几何仍由 root entry 的 store 持有；服务
 * 只转发布局动作，并向会话页头与工作台顶栏提供由 AppFrame 投影的工作台可见状态。
 */
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SessionListState,
} from 'coding-client-runtime/client'
import type { BoundActions } from 'coding-client-ui-slots'
import type { SessionId } from 'coding-session/types'
import type { createLayoutStore, PageRoute } from './stores.ts'

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
  /**
   * 返回指定会话的可见工作台状态，非当前会话读取关闭态。
   * @param sessionId - 页头或欢迎页所属会话。
   * @returns 在该会话存活期间身份稳定的状态源。
   */
  workbench(sessionId: SessionId): ObservableSnapshot<WorkbenchLayoutSnapshot>
  /**
   * 打开指定会话的右栏。后台打开只更新目标会话，不改变当前详情栏或会话选择。
   * @param sessionId - 动作发起时所属的会话；会话已移除时不打开。
   * @returns 无返回值。
   */
  openWorkbench(sessionId: SessionId): void
  /**
   * 关闭指定会话的右栏，保留其标签和工作区底栏。
   * @param sessionId - 要关闭右栏的会话。
   * @returns 无返回值。
   */
  closeWorkbench(sessionId: SessionId): void
  /**
   * 切换当前会话的实际右栏显隐；被详情栏遮挡时恢复右栏。
   * @param sessionId - 点击开关时所属的会话。
   * @returns 无返回值。
   */
  toggleWorkbench(sessionId: SessionId): void
  /**
   * 切换指定会话已打开的右栏的最大化偏好。
   * @param sessionId - 右栏所属的会话。
   * @returns 无返回值。
   */
  toggleWorkbenchFullscreen(sessionId: SessionId): void
  /**
   * 切换工作区共享的终端底栏，不改变右栏开合。
   * @param key - 工作区布局键。
   * @returns 无返回值。
   */
  toggleWorkbenchBottom(key: string): void
  /** 隐藏指定工作区的终端底栏；已隐藏时不改变工作台或详情栏。 */
  closeWorkbenchBottom(key: string): void
  /**
   * 欢迎页打开一块面板时隐藏另一块；只改变目标会话的右栏及所属工作区的底栏。
   * @param key - 工作区布局键。
   * @param panel - 要切换的面板。
   * @param sessionId - 欢迎页所属的当前会话。
   * @returns 无返回值。
   */
  toggleHeroPanel(key: string, panel: 'bottom' | 'files', sessionId: SessionId): void
  /**
   * 新建对话入口重置可复用空白会话的右栏，取消之前的异步欢迎页操作。不改变已开始的会话或共享底栏。
   * @returns 无返回值。
   */
  beginNewConversation(): void
  /** 新对话意图的同步版本；供异步欢迎页面板操作确认其手势仍有效。 */
  readonly conversationIntent: number
  /** 在主内容区打开属于指定会话的独立页面；可选保留打开前的对话会话。 */
  openPage(kind: string, sessionId: SessionId, returnSessionId?: SessionId): void
  /** 同一会话再次点击入口会返回原界面；跨会话时返回指定原对话，须由页面调用方沿用原 id。 */
  togglePage(kind: string, sessionId: SessionId, returnSessionId?: SessionId): void
  /** 返回打开独立页面前的会话，页面所属会话已不是当前选择时不切换。 */
  closePage(): void
  /**
   * 设置当前主内容页的 AI 助手；没有页面时不记录偏好。
   * @param open - 显示、收起，或只在空间足够时自动并排。
   * @returns 无返回值。
   */
  setPageAssistant(open: boolean | 'auto'): void
  /**
   * 显示指定当前会话的对话；全屏工作台中打开原有悬浮对话。
   * @param sessionId - 发起动作时所属的会话。
   * @returns 无返回值。
   */
  showConversation(sessionId: SessionId): void
  /** 供导航入口显示是否正处于主内容页。 */
  readonly page: ObservableSnapshot<PageRoute | null>
  /**
   * 登记独立页助手的「新对话」入口；页面插件不登记时助手头部不渲染该按钮。
   * @param start - 在当前页面上下文开始新的助手对话；失败由登记方决定如何提示。
   * @returns 注销函数，页面插件卸载时移除入口。
   */
  attachPageConversation(start: () => Promise<void>): () => void
  /** 发起当前页面的助手新对话；未登记或上一次尚未完成时不重复触发。 */
  startPageConversation(): void
  /** 助手「新对话」入口是否可用，供根布局决定是否渲染按钮。 */
  readonly pageConversation: ObservableSnapshot<boolean>
}

/** `ctx.layout` 的具体实现。 */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #view = createSnapshotStore<{ sessionId: SessionId; state: WorkbenchLayoutSnapshot } | null>(null)
  #sources = new Map<SessionId, ObservableSnapshot<WorkbenchLayoutSnapshot>>()
  #page = createSnapshotStore<PageRoute | null>(null)
  #pageConversation = createSnapshotStore(false)
  #pageConversationStarter: (() => Promise<void>) | undefined
  #pageConversationRunning = false
  #conversationIntent = 0
  readonly page: ObservableSnapshot<PageRoute | null> = this.#page
  readonly pageConversation: ObservableSnapshot<boolean> = this.#pageConversation

  /** @param readSessions - 读取当前会话与空白状态，不依赖 React 提交时序。 */
  constructor(private readonly readSessions: () => Pick<SessionListState, 'current' | 'byId'>) {}

  /** 新对话意图的同步版本；异步欢迎页操作只可完成同版本手势。 */
  get conversationIntent(): number { return this.#conversationIntent }

  /**
   * 接管 root entry 当前实例的绑定 actions；重新注册时新实例会替换旧引用。
   * @param actions - root 布局 store 的绑定 actions。
   * @returns 无返回值。
   */
  attachPanels(actions: PanelActions): void {
    this.#panels?.clearConversationRequest()
    this.#panels = actions
  }

  /**
   * 卸载 root 注册时撤回旧动作与尚未消费的请求。
   * @returns 无返回值。
   */
  detachPanels(): void {
    this.#panels?.clearConversationRequest()
    this.#panels = undefined
    this.#view.set(null)
  }

  /** @inheritdoc */
  workbench(sessionId: SessionId): ObservableSnapshot<WorkbenchLayoutSnapshot> {
    let source = this.#sources.get(sessionId)
    if (source !== undefined) return source
    source = {
      getSnapshot: () => {
        const current = this.#view.getSnapshot()
        return current?.sessionId === sessionId ? current.state : CLOSED_WORKBENCH
      },
      subscribe: listener => this.#view.subscribe(listener),
    }
    this.#sources.set(sessionId, source)
    return source
  }

  /**
   * 由 AppFrame 一次发布所选会话及其可见状态；旧会话的来源同时回到关闭态。
   * @param sessionId - 当前会话，未选中时传入 undefined。
   * @param state - 页头面板控制所需的可见状态。
   * @returns 无返回值。
   */
  publishWorkbench(sessionId: SessionId | undefined, state: WorkbenchLayoutSnapshot): void {
    if (sessionId === undefined) {
      this.#view.set(null)
      return
    }
    const current = this.#view.getSnapshot()
    if (current?.sessionId === sessionId && current.state.open === state.open
      && current.state.fullscreen === state.fullscreen && current.state.bottomOpen === state.bottomOpen) return
    this.#view.set({ sessionId, state })
  }

  /**
   * 释放已离开列表的会话状态源。
   * @param sessionIds - 仍然存活的会话 id。
   * @returns 无返回值。
   */
  retainWorkbenchViews(sessionIds: readonly SessionId[]): void {
    const retained = new Set(sessionIds)
    for (const id of this.#sources.keys()) if (!retained.has(id)) this.#sources.delete(id)
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

  /** @inheritdoc */
  openWorkbench(sessionId: SessionId): void {
    const panels = this.#require()
    const { current, byId } = this.readSessions()
    if (byId[sessionId] !== undefined) panels.openWorkbench(sessionId, sessionId === current)
  }

  /** @inheritdoc */
  closeWorkbench(sessionId: SessionId): void {
    this.#require().closeWorkbench(sessionId)
  }

  /** @inheritdoc */
  toggleWorkbench(sessionId: SessionId): void {
    const panels = this.#require()
    if (this.readSessions().current === sessionId) panels.toggleWorkbench(sessionId)
  }

  /** @inheritdoc */
  toggleWorkbenchFullscreen(sessionId: SessionId): void {
    this.#require().toggleWorkbenchFullscreen(sessionId)
  }

  /** @inheritdoc */
  toggleWorkbenchBottom(key: string): void {
    this.#require().toggleWorkbenchBottom(key)
  }

  /** 隐藏指定工作区的终端底栏。 */
  closeWorkbenchBottom(key: string): void {
    this.#require().closeWorkbenchBottom(key)
  }

  /** @inheritdoc */
  toggleHeroPanel(key: string, panel: 'bottom' | 'files', sessionId: SessionId): void {
    const panels = this.#require()
    if (this.readSessions().current === sessionId) panels.toggleHeroPanel(key, panel, sessionId)
  }

  /** @inheritdoc */
  beginNewConversation(): void {
    const panels = this.#require()
    this.#conversationIntent++
    panels.resetBlankWorkbench(Object.values(this.readSessions().byId).filter(session => session.blank).map(session => session.id))
  }

  /**
   * 登记独立页助手的「新对话」入口；同一时刻只有一个登记方生效。
   * @param start - 在当前页面上下文开始新的助手对话。
   * @returns 注销函数；只有仍是当前登记方时才撤回，避免旧实例撤销新入口。
   */
  attachPageConversation(start: () => Promise<void>): () => void {
    this.#pageConversationStarter = start
    this.#pageConversation.set(true)
    return () => {
      if (this.#pageConversationStarter !== start) return
      this.#pageConversationStarter = undefined
      this.#pageConversation.set(false)
    }
  }

  /**
   * 发起当前页面的助手新对话；未登记或上一次仍在进行时忽略本次点击。
   * 失败不改动现有页面与对话，用户可再次点击重试。
   * @returns 无返回值。
   */
  startPageConversation(): void {
    const start = this.#pageConversationStarter
    if (start === undefined || this.#pageConversationRunning) return
    this.#pageConversationRunning = true
    void start().catch(() => {
      // 由登记方决定失败提示；不改变当前页面，保留会话与助手草稿。
    }).finally(() => { this.#pageConversationRunning = false })
  }

  /** 在主内容区打开会话页面，可选提供页面关闭后要恢复的会话。 */
  openPage(kind: string, sessionId: SessionId, returnSessionId?: SessionId): void {
    this.#require().openPage(kind, sessionId, returnSessionId)
  }

  /** 返回打开独立页面前的会话，原选择已变更时保持新选择。 */
  closePage(): void {
    this.#require().closePage()
  }

  /**
   * 请求根布局显示当前会话的对话；不切换会话，也不触碰草稿。
   * @param sessionId - 发起动作时所属的会话。
   * @returns 无返回值。
   */
  showConversation(sessionId: SessionId): void {
    this.#require().requestShowConversation(sessionId)
  }

  /** 同一页面入口可再次点击返回；可选保留打开前的会话。 */
  togglePage(kind: string, sessionId: SessionId, returnSessionId?: SessionId): void {
    this.#require().togglePage(kind, sessionId, returnSessionId)
  }

  /** @param open - 当前页的助手显隐或自动并排偏好。 */
  setPageAssistant(open: boolean | 'auto'): void {
    this.#require().setPageAssistant(open)
  }

  /** AppFrame 将最终路由投影给不持有根 store 的入口。 */
  publishPage(next: PageRoute | null): void {
    const current = this.#page.getSnapshot()
    if (current?.kind === next?.kind && current?.sessionId === next?.sessionId
      && current?.returnSessionId === next?.returnSessionId) return
    this.#page.set(next)
  }

  #require(): PanelActions {
    // UI 手势只能在 root entry 首次渲染并接线后触发；未接线表示启动顺序错误。
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
