/** 代码工作区的外侧入口、独立欢迎页与工作区切换。 */
import type { ClientContext, SessionId, WorkspaceId } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import type {} from 'coding-client-ui-open-in-app/client'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { IdeNavigationEntry } from './IdeNavigationEntry.tsx'
import { IdePage, type IdePageFace } from './IdePage.tsx'
import { createIdeStore } from './ide-store.ts'
import { en, zh, NS, type IdeLocaleKey } from './locales.ts'

const PAGE = 'ide'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 代码工作区文案。 */
    ide: IdeLocaleKey
  }

  interface SlotMap {
    /** 欢迎页声明的目录选择交互；由已装配的目录选择包占用。 */
    'shell.ide.welcome.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** 页面与目录流所需服务。 */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces', 'workspaceFiles']

/**
 * 注册代码工作区导航与欢迎页。
 *
 * 页面状态实例在 apply 里创建一次、挂在 inject 面上，而不是注册成会话级 store：
 * 它必须跨页面挂载与会话切换存活。这样进入页面永远从欢迎页或本包记住的工作区开始，
 * 对话页当前工作区不会渗进来；页内切换工作区也不改变对话页的原选择。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ide: dictionaries')
  const state = createIdeStore().create()
  /**
   * 把一个工作区设为页面锚点：优先复用已绑定且仍在列表里的会话，
   * 只有会话不在了才向 Host 重新建立空白会话。
   */
  const anchorWorkspace = async (workspaceId: WorkspaceId): Promise<SessionId> => {
    const bound = state.getSnapshot().sessions[workspaceId]
    const listed = ctx.sessions.list.getSnapshot()
    const sessionId = bound !== undefined && listed.byId[bound] !== undefined
      ? bound
      : await ctx.workspaces.connectWorkspace(workspaceId)
    state.actions.bindSession(workspaceId, sessionId)
    state.actions.enter(workspaceId)
    const page = ctx.layout.page.getSnapshot()
    const origin = page?.returnSessionId ?? page?.sessionId ?? listed.current
    ctx.sessions.open(sessionId)
    ctx.layout.openPage(PAGE, sessionId, origin)
    ctx.layout.setPageAssistant('auto')
    return sessionId
  }
  /**
   * 打开欢迎页选中的工作区。
   *
   * 刚创建的工作区要等 Host 列表投影回来才出现在 `workspaces.items` 里，因此这里
   * 不做「必须在列表中」的前置校验：先记下选择并绑定会话，页面在列表到达前显示
   * 欢迎页，到达后自动进入三栏。
   */
  const openWorkspace = async (workspaceId: WorkspaceId): Promise<void> => {
    await anchorWorkspace(workspaceId)
  }
  const face: IdePageFace = {
    hooks: { ideState: state },
    actions: state.actions,
    createWorkspace: async input => await ctx.workspaces.create(input),
    openWorkspace,
    leaveWorkspace: () => {
      state.actions.enter(null)
      ctx.layout.setPageAssistant(false)
    },
    workspaceFiles: ctx.workspaceFiles,
  }
  ctx.slots.inject('shell.navigation.entry', () => ctx.slots.register({
    name: 'shell.navigation.entry', id: 'ide', order: 12, locale: NS,
    inject: () => ({ hooks: { idePage: ctx.layout.page }, openIde: openIdeFor(ctx, state, openWorkspace) }),
  }, IdeNavigationEntry))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: PAGE, locale: NS,
    children: { 'shell.ide.welcome.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => face,
  }, IdePage))
}

type IdeState = ReturnType<ReturnType<typeof createIdeStore>['create']>

/**
 * 打开代码工作区页面。
 *
 * 外壳要求页面绑定一个会话，这里只保证存在可用的当前会话；页面显示欢迎页还是三栏
 * 完全由本包状态决定。本包记住的工作区还在时回到它（复用它的绑定会话），否则显示
 * 欢迎页；无论哪种情况都不把对话页的工作区当成代码工作区的选择。
 * @param ctx - 浏览器插件 Context。
 * @param state - 代码工作区状态实例。
 * @param openWorkspace - 进入某个工作区的动作。
 * @returns 打开动作；并发点击共用同一次在途打开。
 */
function openIdeFor(
  ctx: ClientContext,
  state: IdeState,
  openWorkspace: (workspaceId: WorkspaceId) => Promise<void>,
): () => Promise<void> {
  let opening: Promise<void> | undefined
  return () => {
    opening ??= (async() => {
      const page = ctx.layout.page.getSnapshot()
      const current = ctx.sessions.list.getSnapshot().current
      const origin = page?.returnSessionId ?? current
      const remembered = state.getSnapshot().workspaceId
      const known = remembered === null
        ? undefined
        : ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === remembered)
      if (remembered !== null && known !== undefined && current !== undefined) {
        await openWorkspace(remembered)
        return
      }
      state.actions.enter(null)
      const target = current ?? await ctx.workspaces.connectHome()
      ctx.sessions.open(target)
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          ctx.layout.togglePage(PAGE, target, origin)
          ctx.layout.setPageAssistant(false)
          return
        } catch {
          await new Promise<void>((resolve) => { window.setTimeout(resolve, 32) })
        }
      }
      throw new Error('ide page unavailable')
    })().finally(() => { opening = undefined })
    return opening
  }
}
