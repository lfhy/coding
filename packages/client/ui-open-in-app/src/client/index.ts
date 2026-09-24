/** 工作区本地启动入口、文件工作台与底栏终端的浏览器插件。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OPEN_IN_APP_ICON_PREFIX } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionInjected } from './OpenInAppAction.tsx'
import { WorkspaceWorkbench, type WorkspaceWorkbenchInjected } from './WorkspaceWorkbench.tsx'
import {
  HeroBottomToggle, WorkbenchPanelToggles,
  type HeroBottomToggleInjected, type WorkbenchPanelTogglesInjected,
} from './WorkbenchPanelToggles.tsx'
import { RetainedTerminalPanel } from './RetainedTerminalPanel.tsx'
import type { TerminalPanelInjected } from './TerminalPanel.tsx'
import { createWorkbenchStore } from './store.ts'
import { en, NS, zh } from './locales.ts'

export type { OpenInAppActionInjected, OpenInAppActionProps } from './OpenInAppAction.tsx'
export type { WorkbenchPanelTogglesInjected, WorkbenchPanelTogglesProps } from './WorkbenchPanelToggles.tsx'

/** locale、slot、布局、会话与工作区选择需要的服务。 */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces']

/**
 * 读取可以操作工作台的当前会话：包括空白会话，只有当前会话尚不可寻址时返回 undefined。
 * @param ctx - Client 根上下文。
 * @returns 可操作工作台的会话 id，或 undefined。
 */
function activeSessionId(ctx: ClientContext): SessionId | undefined {
  const state = ctx.sessions.list.getSnapshot()
  const current = state.current
  return current !== undefined && state.byId[current] !== undefined ? current : undefined
}

/**
 * 注册会话页头入口、文件工作台、保留式底栏终端，以及侧边栏品牌行里的常驻
 * 面板开关。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  const controller = new OpenInAppController()
  const workbench = createWorkbenchStore()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-app: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'open-in-app',
    order: -10,
    locale: NS,
    store: workbench,
    inject: (sessionId: SessionId): OpenInAppActionInjected => ({
      hooks: {
        openInAppTargets: controller.targets,
        openInAppChoice: controller.choice,
        workbenchLayout: ctx.layout.workbench(sessionId),
      },
      load: path => controller.load(path),
      launch: (appId, path) => controller.launch(appId, path),
      choose: (appId) => { controller.choose(appId) },
      iconUrl: appId => `${OPEN_IN_APP_ICON_PREFIX}/${appId}`,
      openWorkbench: () => { ctx.layout.openWorkbench(sessionId) },
    }),
  }, OpenInAppAction))

  ctx.slots.inject('workbench', () => ctx.slots.register({
    name: 'workbench',
    locale: NS,
    store: workbench,
    inject: (sessionId: SessionId): WorkspaceWorkbenchInjected => ({
      listFiles: (segments, signal) => controller.listFiles(sessionId, segments, signal),
      readFile: (segments, signal) => controller.readFile(sessionId, segments, signal),
      closeWorkbench: () => { ctx.layout.closeWorkbench(sessionId) },
      toggleWorkbenchFullscreen: () => { ctx.layout.toggleWorkbenchFullscreen(sessionId) },
    }),
  }, WorkspaceWorkbench))

  ctx.slots.inject('sidebar.brand.action', () => ctx.slots.register({
    name: 'sidebar.brand.action',
    id: 'workbench-panels',
    order: 20,
    locale: NS,
    inject: (): WorkbenchPanelTogglesInjected => ({
      workbenchSource: sessionId => ctx.layout.workbench(sessionId),
      toggleFiles: () => {
        const sessionId = activeSessionId(ctx)
        if (sessionId !== undefined) ctx.layout.toggleWorkbenchFiles(sessionId)
      },
      toggleBottom: () => {
        const sessionId = activeSessionId(ctx)
        if (sessionId !== undefined) ctx.layout.toggleWorkbenchBottom(sessionId)
      },
    }),
  }, WorkbenchPanelToggles))

  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions',
    id: 'bottom-toggle',
    order: 10,
    locale: NS,
    inject: (): HeroBottomToggleInjected => ({
      workbenchSource: sessionId => ctx.layout.workbench(sessionId),
      toggleBottom: async () => {
        let sessionId = activeSessionId(ctx)
        if (sessionId === undefined) {
          const target = ctx.workspaces.list.getSnapshot().recentWorkspaceId
          sessionId = target === undefined
            ? await ctx.workspaces.connectHome()
            : await ctx.workspaces.connectWorkspace(target)
          // 异步创建期间若用户切换到另一会话，不抢占其当前视图。
          if (ctx.sessions.list.getSnapshot().current !== undefined) return
          ctx.sessions.open(sessionId)
        }
        ctx.layout.toggleWorkbenchBottom(sessionId)
      },
    }),
  }, HeroBottomToggle))

  ctx.slots.inject('workbench.bottom', () => ctx.slots.register({
    name: 'workbench.bottom',
    locale: NS,
    inject: (sessionId: SessionId): TerminalPanelInjected => ({
      terminalUrl: controller.terminalUrl(sessionId),
    }),
  }, RetainedTerminalPanel))
}
