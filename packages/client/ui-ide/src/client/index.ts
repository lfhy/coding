/** 代码工作区的外侧入口与独立欢迎页。 */
import type { ClientContext, WorkspaceId } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import type {} from 'coding-client-ui-open-in-app/client'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { IdeNavigationEntry } from './IdeNavigationEntry.tsx'
import { IdePage } from './IdePage.tsx'
import { createIdeWorkspaceStore } from './ide-store.ts'
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
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces', 'workspaceFiles']

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
    name: 'shell.page', key: PAGE, locale: NS, store: createIdeWorkspaceStore,
    children: { 'shell.ide.welcome.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => ({
      createWorkspace: (input: { path: string }) => ctx.workspaces.create(input),
      openWorkspace: (workspaceId: WorkspaceId) => openWorkspaceFor(ctx, workspaceId),
      workspaceFiles: ctx.workspaceFiles,
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
          const inWorkspace = ctx.workspaces.list.getSnapshot().items.some(item => item.sessionIds.includes(target))
          // 欢迎阶段收起助手；已绑定工作区的会话直接进入三栏并自动并排助手。
          ctx.layout.setPageAssistant(inWorkspace ? 'auto' : false)
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

/** 打开工作区的空白会话，并留在同一 IDE 页进入三栏工作区。 */
async function openWorkspaceFor(ctx: ClientContext, workspaceId: WorkspaceId): Promise<void> {
  const page = ctx.layout.page.getSnapshot()
  const origin = page?.returnSessionId ?? page?.sessionId ?? ctx.sessions.list.getSnapshot().current
  const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
  ctx.sessions.open(sessionId)
  ctx.layout.openPage(PAGE, sessionId, origin)
  ctx.layout.setPageAssistant('auto')
}
