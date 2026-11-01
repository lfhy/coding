/** 右侧工作台会话级 Agent 浏览器标签；Host 负责会话和目标校验。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import type {} from 'coding-client-ui-open-in-app/client'
import type {} from 'coding-client-locale/client'
import { IconBrowseOutline16 } from 'coding-client-ui-icons'
import { BrowserEgoController } from './controller.ts'
import { watchActivity, WATCH_ID, WATCH_KIND } from './activity.ts'
import { AgentBrowserPanel, type AgentBrowserInjected } from './AgentBrowserPanel.tsx'
import { en, NS, zh, type BrowserEgoKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 当前右侧 Agent 浏览器面板的展示文案。 */
    'browser-ego': BrowserEgoKey
  }
}

/** 仅依赖外部标签所有者；不连接旧浏览器控制服务。 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions']

/**
 * 将面板作为工作台扩展项注册；父级槽位晚到时仍可安全接线。
 * @param ctx - Client 插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser-ego: dictionaries')
  const t = ctx.locale.bind(NS)
  const controllers = new Map<string, BrowserEgoController>()
  const controllerFor = (sessionId: string): BrowserEgoController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new BrowserEgoController(sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: WATCH_ID,
    kind: WATCH_KIND,
    keepMounted: true,
    title: () => t('title'),
    guide: [{ id: 'browser-ego-watch', order: 90, title: () => t('title'), icon: IconBrowseOutline16 }],
  }), 'ui-browser-ego: tab definition')
  ctx.slots.inject('sidebar.right.pane.tab', () => {
    const dispose = ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: WATCH_ID, locale: NS,
      inject: (sessionId: SessionId): AgentBrowserInjected => {
        const controller = controllerFor(sessionId)
        return {
          hooks: { browserEgo: controller.view },
          show: (visible) => { controller.show(visible) },
          refresh: () => controller.refresh(),
          select: (targetId) => { controller.select(targetId) },
          close: targetId => controller.close(targetId),
          send: (targetId, input) => controller.send(targetId, input),
        }
      },
    }, AgentBrowserPanel)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.show(false)
      controllers.clear()
    }
  })
  ctx.effect(() => watchActivity((rawId) => {
    const sessionId = rawId as SessionId
    if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) return
    ctx.sidebarRight.openTabForSession(sessionId, WATCH_KIND)
  }), 'ui-browser-ego: activity')
}
