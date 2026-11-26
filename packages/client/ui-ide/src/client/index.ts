/** 代码工作区的外侧入口与独立欢迎页。 */
import type { ClientContext, WorkspaceId } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { IdeNavigationEntry } from './IdeNavigationEntry.tsx'
import { IdePage } from './IdePage.tsx'
import { en, zh, NS, type IdeLocaleKey } from './locales.ts'

const PAGE = 'ide'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 代码工作区文案。 */
    'ide': IdeLocaleKey
  }

  interface SlotMap {
    /** 欢迎页声明的目录选择交互；由已装配的目录选择包占用。 */
    'shell.ide.welcome.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** 页面与目录流所需服务。 */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces']

/**
 * 注册代码工作区导航与欢迎页。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ide: dictionaries')
  ctx.slots.inject('shell.navigation.entry', () => ctx.slots.register({
    name: 'shell.navigation.entry', id: 'ide', order: 12, locale: NS,
    inject: () => ({ hooks: { idePage: ctx.layout.page }, openIde: openIdeFor(ctx) }),
  }, IdeNavigationEntry))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: PAGE, locale: NS,
    children: { 'shell.ide.welcome.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => ({
      createWorkspace: (input: { path: string }) => ctx.workspaces.create(input),
      openWorkspace: (workspaceId: WorkspaceId) => openWorkspaceFor(ctx, workspaceId),
    }),
  }, IdePage))
}

/** 首次进入沿用当前会话；没有会话时用 Host 默认目录建立布局锚点。 */
function openIdeFor(ctx: ClientContext): () => Promise<void> {
  let opening: Promise<void> | undefined
  return () => {
    opening ??= (async () => {
      const current = ctx.sessions.list.getSnapshot().current
      const origin = ctx.layout.page.getSnapshot()?.returnSessionId ?? current
      const target = current ?? await ctx.workspaces.connectHome()
      ctx.sessions.open(target)
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          ctx.layout.togglePage(PAGE, target, origin)
          // 欢迎阶段只展示入口本身，不提前展开共享助手栏。
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

/** 打开工作区的空白会话，并离开独立欢迎页进入现有三栏工作区。 */
async function openWorkspaceFor(ctx: ClientContext, workspaceId: WorkspaceId): Promise<void> {
  const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
  ctx.sessions.open(sessionId)
  ctx.layout.closePage()
}
