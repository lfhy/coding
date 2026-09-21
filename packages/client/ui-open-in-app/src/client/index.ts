/** 工作区本地启动入口、文件工作台与底栏终端的浏览器插件。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { OPEN_IN_APP_ICON_PREFIX } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionInjected } from './OpenInAppAction.tsx'
import { WorkspaceWorkbench, type WorkspaceWorkbenchInjected } from './WorkspaceWorkbench.tsx'
import { RetainedTerminalPanel } from './RetainedTerminalPanel.tsx'
import type { TerminalPanelInjected } from './TerminalPanel.tsx'
import { createWorkbenchStore } from './store.ts'
import { en, NS, zh } from './locales.ts'

export type { OpenInAppActionInjected, OpenInAppActionProps } from './OpenInAppAction.tsx'

/** locale、slot 与布局控制需要的服务。 */
export const inject = ['slots', 'locale', 'layout']

/**
 * 注册会话页头入口、文件工作台和保留式底栏终端。
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
      toggleWorkbenchBottom: () => { ctx.layout.toggleWorkbenchBottom(sessionId) },
    }),
  }, WorkspaceWorkbench))

  ctx.slots.inject('workbench.bottom', () => ctx.slots.register({
    name: 'workbench.bottom',
    locale: NS,
    inject: (sessionId: SessionId): TerminalPanelInjected => ({
      terminalUrl: controller.terminalUrl(sessionId),
    }),
  }, RetainedTerminalPanel))
}
