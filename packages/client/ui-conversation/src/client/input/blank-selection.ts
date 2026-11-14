/** 空白会话选择的导航租约与草稿交接；Host 创建完成不等于仍有权改变当前页面。 */
import type { ISessions, IWorkspaces, SessionId, WorkspaceId } from 'coding-client-runtime/client'
import type { ILayout } from 'coding-client-ui-layout/client'
import type { InputHub } from './hub.ts'

/** 仅在 apply 中创建；所有入口共用递增代次，禁止旧选择覆盖新导航。 */
export class BlankSelection {
  private attempt = 0

  /**
   * @param sessions - 当前选择及可寻址的会话。
   * @param workspaces - Host 拥有的项目与 HOME 创建入口。
   * @param input - 包内已有的每会话草稿所有者。
   * @param layout - 新对话意图版本与独立页面来源；仅在请求期间监听导航失效。
   * @param prepareStandalone - 无项目目标打开前等待所属模式插件准备。
   */
  constructor(
    private readonly sessions: ISessions,
    private readonly workspaces: IWorkspaces,
    private readonly input: InputHub,
    private readonly layout: Pick<ILayout, 'conversationIntent' | 'page'>,
    private readonly prepareStandalone: (sessionId: SessionId) => Promise<void>,
  ) {}

  /** 撤销正在等待的选择；同一函数身份可安全用于常驻页面卸载。 */
  readonly abort = (): void => { this.attempt++ }

  /**
   * 连接项目空白会话；草稿只在请求仍拥有当前导航时迁移。
   * @param source - 发起手势时的当前会话。
   * @param workspaceId - 用户明确选择的工作区。
   * @returns 打开的会话，或失效选择的 undefined。
   */
  workspace(source: SessionId | undefined, workspaceId: WorkspaceId): Promise<SessionId | undefined> {
    return this.select(source, () => this.workspaces.connectWorkspace(workspaceId))
  }

  /**
   * 通过 Host HOME 创建未分组会话；已有无项目空白时直接复用。
   * @param source - 发起手势时的当前会话。
   * @returns 打开的会话，或失效选择的 undefined。
   */
  withoutWorkspace(source: SessionId | undefined): Promise<SessionId | undefined> {
    return this.select(source, () => {
      const summary = source === undefined ? undefined : this.sessions.list.getSnapshot().byId[source]
      const workspaces = this.workspaces.list.getSnapshot()
      if (source !== undefined && summary?.blank === true && workspaces.phase === 'ready'
        && !workspaces.items.some(item => item.sessionIds.includes(source))) return Promise.resolve(source)
      return this.workspaces.connectHome()
    }, this.prepareStandalone)
  }

  private async select(
    source: SessionId | undefined,
    connect: () => Promise<SessionId>,
    prepare?: (sessionId: SessionId) => Promise<void>,
  ): Promise<SessionId | undefined> {
    const attempt = ++this.attempt
    const intent = this.layout.conversationIntent
    const page = this.layout.page.getSnapshot()
    let navigatedAway = false
    // 导航一旦离开即失效，即使用户在 Host 返回前又切回来也不能恢复旧请求的导航权。
    const checkNavigation = (): void => {
      if (this.sessions.list.getSnapshot().current !== source || this.layout.page.getSnapshot() !== page) {
        navigatedAway = true
      }
    }
    const owns = () => attempt === this.attempt
      && !navigatedAway
      && intent === this.layout.conversationIntent
      && page === null && this.layout.page.getSnapshot() === page
      && this.sessions.list.getSnapshot().current === source
    if (!owns()) return undefined
    const releaseSession = this.sessions.list.subscribe(checkNavigation)
    const releasePage = this.layout.page.subscribe(checkNavigation)
    try {
      const target = await connect()
      if (!owns()) return undefined
      await prepare?.(target)
      if (!owns()) return undefined
      if (source !== undefined && target !== source) this.carryDraft(source, target)
      this.sessions.open(target)
      return target
    } catch (error: unknown) {
      if (!owns()) return undefined
      throw error
    } finally {
      releaseSession()
      releasePage()
    }
  }

  private carryDraft(source: SessionId, target: SessionId): void {
    if (!this.input.shell(source).moveDraftTo(this.input.shell(target))) {
      throw new Error('blank conversation draft is busy')
    }
  }
}
