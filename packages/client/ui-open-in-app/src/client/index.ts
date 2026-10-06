/** 工作区本地启动入口、功能工作台与底栏终端的浏览器插件。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { OPEN_IN_APP_ICON_PREFIX } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionInjected } from './OpenInAppAction.tsx'
import { WorkspaceWorkbench, type WorkspaceWorkbenchInjected } from './WorkspaceWorkbench.tsx'
import {
  HeroPanelToggle, WorkbenchPanelToggles,
  type HeroPanelToggleInjected, type WorkbenchPanelTogglesInjected,
} from './WorkbenchPanelToggles.tsx'
import { RetainedTerminalPanel } from './RetainedTerminalPanel.tsx'
import { createRetainedWorkbenchStore } from './store.ts'
import type { SidebarRightTabDefinition } from './sidebar-tab-registry.ts'
import { SidebarRightTabRegistry } from './sidebar-tab-registry.ts'
import { SidebarRightController } from './sidebar-tab-service.ts'
import { tabInfoInject, type SidebarRightTabOwnerProps, type SidebarRightTabSlotInject } from './sidebar-tab-contract.ts'
import { en, NS, zh } from './locales.ts'

export type { OpenInAppActionInjected, OpenInAppActionProps } from './OpenInAppAction.tsx'
export type { WorkbenchPanelTogglesInjected, WorkbenchPanelTogglesProps } from './WorkbenchPanelToggles.tsx'
export type { SidebarRightTabDefinition, SidebarRightGuideEntry, SidebarRightGuideBox } from './sidebar-tab-registry.ts'
export type { SidebarRightTabOwnerProps } from './sidebar-tab-contract.ts'
export type {
  ISidebarRight, SidebarRightKindOptions, SidebarRightOpenOptions, SidebarRightUpdateOptions,
} from './sidebar-tab-service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前 Client 插件树贡献的右侧标签类型。 */
    sidebarRightTabs: SidebarRightTabRegistry
    /** 指定 Session 的单面板标签动作。 */
    sidebarRight: SidebarRightController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 工作台右侧预览区的会话级浏览器；隐藏时条目仍保持挂载。 */
    'workbench.browser': { kind: 'single'; scope: 'session'; owner: WorkbenchBrowserOwnerProps }
    /** 每个浏览器页面向工作台统一顶栏贡献一个标签。 */
    'workbench.browser.tabs': { kind: 'single'; scope: 'session'; owner: WorkbenchBrowserOwnerProps }
    /** 第三方标签的内容座位；注册键等于定义 id。 */
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      owner: SidebarRightTabOwnerProps
      hookContext: SidebarRightTabOwnerProps
      inject: SidebarRightTabSlotInject
    }
    /** 第三方标签的标题座位；未注册时工作台使用保存的名称。 */
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      owner: SidebarRightTabOwnerProps
      hookContext: SidebarRightTabOwnerProps
      inject: SidebarRightTabSlotInject
    }
  }
}

/** 浏览器内容由贡献条目绘制；容器只持有视图显隐与切换动作。 */
export interface WorkbenchBrowserOwnerProps {
  shown: boolean
  openBrowser: (tabId?: string) => void
  interactionEpoch: number
  browserAutoRevealed: boolean
  requestAutoReveal: (epoch: number) => boolean
  autoRevealBrowser: (tabId: string, epoch: number) => void
  syncBrowserTabs: (tabs: readonly { id: string; name: string }[], activeId: string | null) => void
  tabId?: string
  tabName?: string
  tabDomId?: string
  panelDomId?: string
  selectedTabId?: string
  browserShown?: boolean
  /** 工作台菜单每次选择浏览器递增，内容贡献者为每个序号建立一个页面。 */
  newTabRequest: number
  /** 已交给浏览器命令的序号由工作台保留，贡献条目重挂载时不重复执行。 */
  handledTabRequest: number
  markTabRequestHandled: (request: number) => void
  focusBrowserTab: (tabId: string) => void
  focusPendingBrowserTab: (tabId: string) => void
}

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
 * 注册会话页头入口、功能工作台、保留式底栏终端与面板开关。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  const controller = new OpenInAppController()
  const workbench = createRetainedWorkbenchStore()
  const sidebarRightTabs = new SidebarRightTabRegistry()
  const sidebarRight = new SidebarRightController(sidebarRightTabs, ctx.layout, () => activeSessionId(ctx))
  const sidebarRightSource: HostObservable<readonly SidebarRightTabDefinition[]> = {
    getSnapshot: () => sidebarRightTabs.entries(),
    subscribe: listener => sidebarRightTabs.subscribe(listener),
  }
  ctx.effect(() => {
    const disposeTabs = ctx.reflect.provide('sidebarRightTabs', sidebarRightTabs)
    const disposeActions = ctx.reflect.provide('sidebarRight', sidebarRight)
    return () => {
      void disposeActions()
      void disposeTabs()
    }
  }, 'open-in-app: sidebar right services')
  ctx.effect(() => {
    const knownIds = new Set(sidebarRightTabs.entries().map(definition => definition.id))
    return sidebarRightTabs.subscribe(() => {
      for (const id of knownIds) {
        if (sidebarRightTabs.has(id)) continue
        sidebarRight.closeDefinitionTabs(id)
        knownIds.delete(id)
      }
      for (const definition of sidebarRightTabs.entries()) knownIds.add(definition.id)
    })
  }, 'open-in-app: close unloaded tab definitions')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-app: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'open-in-app',
    order: -10,
    locale: NS,
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

  ctx.slots.inject('workbench', () => {
    const disposeWorkbench = ctx.slots.register({
      name: 'workbench',
      children: {
        'workbench.browser': { kind: 'single', scope: 'session' },
        'workbench.browser.tabs': { kind: 'single', scope: 'session' },
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: tabInfoInject },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: tabInfoInject },
      },
      locale: NS,
      store: workbench,
      inject: (actions): WorkspaceWorkbenchInjected => {
        sidebarRight.attach(actions)
        return {
          hooks: { sidebarRightTabs: sidebarRightSource },
          listFiles: (sessionId, segments, signal) => controller.listFiles(sessionId, segments, signal),
          readFile: (sessionId, segments, signal) => controller.readFile(sessionId, segments, signal),
          terminalUrl: sessionId => controller.terminalUrl(sessionId),
          closeWorkbench: (sessionId) => { ctx.layout.closeWorkbench(sessionId) },
          openWorkbench: (sessionId) => { ctx.layout.openWorkbench(sessionId) },
          toggleWorkbenchFullscreen: (sessionId) => { ctx.layout.toggleWorkbenchFullscreen(sessionId) },
          toggleBottom: (sessionId) => { ctx.layout.toggleWorkbenchBottom(sessionId) },
          openSidebarTab: (sessionId, kind) => { sidebarRight.openTabForSession(sessionId, kind) },
        }
      },
    }, WorkspaceWorkbench)
    return () => {
      sidebarRight.detach()
      disposeWorkbench()
    }
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workbench-panels',
    order: 20,
    locale: NS,
    inject: (sessionId: SessionId): WorkbenchPanelTogglesInjected => ({
      hooks: { workbenchLayout: ctx.layout.workbench(sessionId) },
      toggleWorkbench: () => { ctx.layout.toggleWorkbench(sessionId) },
      toggleBottom: () => { ctx.layout.toggleWorkbenchBottom(sessionId) },
    }),
  }, WorkbenchPanelToggles))

  let connectingHeroSession: Promise<SessionId> | undefined
  let latestHeroRequest = 0
  const toggleHeroPanel = async (panel: HeroPanelToggleInjected['panel']): Promise<void> => {
    const request = ++latestHeroRequest
    let sessionId = activeSessionId(ctx)
    if (sessionId === undefined) {
      connectingHeroSession ??= (async () => {
        const target = ctx.workspaces.list.getSnapshot().recentWorkspaceId
        return target === undefined
          ? ctx.workspaces.connectHome()
          : ctx.workspaces.connectWorkspace(target)
      })().finally(() => { connectingHeroSession = undefined })
      sessionId = await connectingHeroSession
      // 共用连接期间的旧点击不得先打开会话，否则最后一次点击会被误判为外部切换。
      if (request !== latestHeroRequest) return
      // 异步创建期间若用户切换到另一会话，不抢占其当前视图。
      if (ctx.sessions.list.getSnapshot().current !== undefined) return
      ctx.sessions.open(sessionId)
    }
    ctx.layout.toggleHeroPanel(sessionId, panel)
  }
  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions',
    id: 'bottom-toggle',
    order: 0,
    locale: NS,
    inject: (): HeroPanelToggleInjected => ({
      panel: 'bottom',
      workbenchSource: sessionId => ctx.layout.workbench(sessionId),
      togglePanel: () => toggleHeroPanel('bottom'),
    }),
  }, HeroPanelToggle))
  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions',
    id: 'files-toggle',
    order: 10,
    locale: NS,
    inject: (): HeroPanelToggleInjected => ({
      panel: 'files',
      workbenchSource: sessionId => ctx.layout.workbench(sessionId),
      togglePanel: () => toggleHeroPanel('files'),
    }),
  }, HeroPanelToggle))

  ctx.slots.inject('workbench.bottom', () => ctx.slots.register({
    name: 'workbench.bottom',
    locale: NS,
    inject: () => ({
      terminalUrl: (sessionId: SessionId) => controller.terminalUrl(sessionId),
      closeBottom: (sessionId: SessionId) => { ctx.layout.closeWorkbenchBottom(sessionId) },
    }),
  }, RetainedTerminalPanel))
}
