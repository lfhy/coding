/**
 * 右侧工作台会话级 Agent 浏览器标签与 `ego-browser` 设置卡；Host 负责会话、
 * 目标与设置命名空间校验。设置卡由设置页的插件槽位按命名空间派发，因此本包
 * 不依赖设置页实现，只在命名空间被 Host 服务时出现。
 */
import type { ClientContext } from 'coding-client-runtime/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import type {} from 'coding-client-ui-open-in-app/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import { IconBrowseOutline16 } from 'coding-client-ui-icons'
import { BrowserEgoController } from './controller.ts'
import { watchActivity, WATCH_ID, WATCH_KIND } from './activity.ts'
import { validId, type EgoPage } from './wire.ts'
import { AgentBrowserPanel, type AgentBrowserInjected } from './AgentBrowserPanel.tsx'
import { EgoBrowserCard } from './settings-card.tsx'
import { EgoBrowserCardController } from './settings-card-controller.ts'
import { EGO_SETTINGS_NS, captureOf, type EgoBrowserCapture, type EgoBrowserSettings } from './settings.ts'
import { en, NS, zh, type BrowserEgoKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 当前右侧 Agent 浏览器面板与设置卡的展示文案。 */
    'browser-ego': BrowserEgoKey
  }
}

/** 依赖外部标签所有者与设置作用域；不连接旧浏览器控制服务。 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'settingsScope']

/** 对话链接只接受无凭据的绝对 HTTP(S) 地址，拒绝把网页协议或登录信息交给 Host。 */
function linkAddress(value: string): boolean {
  if (value.length === 0 || value.length > 4096 || /[\s\\\u0000-\u0008\u000e-\u001f\u007f]/u.test(value)) return false
  try {
    const url = new URL(value)
    const authority = value.match(/^https?:\/\/([^/?#\\\s]+)(?:[/?#]|$)/iu)?.[1]
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      && url.username === '' && url.password === '' && !!authority && !authority.includes('@')
  } catch { return false }
}

/**
 * 将面板作为工作台扩展项注册，并为 `ego-browser` 命名空间提供设置卡；
 * 父级槽位或设置页晚到时仍可安全接线。
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
  // 设置命名空间与面板共用同一绑定：卡片写用户层，面板只读采集后端投影。
  const settings = ctx.settingsScope.bind<EgoBrowserSettings>({ namespace: EGO_SETTINGS_NS })
  const capture = createSnapshotStore<EgoBrowserCapture>(captureOf(settings.getSnapshot().value))
  ctx.effect(() => settings.subscribe(() => {
    capture.set(captureOf(settings.getSnapshot().value))
  }), 'ui-browser-ego: capture settings')
  const card = new EgoBrowserCardController(settings)
  const synced = new Map<string, () => void>()
  const addressFor = (targetId: string): string =>
    `sidebar://${encodeURIComponent(WATCH_KIND)}/${encodeURIComponent(targetId)}`
  const fallback = `sidebar://${encodeURIComponent(WATCH_KIND)}`
  // 显式点击可重开被关闭的视图，但 Host 页面必须先导航成功才选中相应标签。
  const links = {
    async open(sessionId: SessionId, url: string): Promise<void> {
      if (!linkAddress(url)) throw new Error(t('linkInvalid'))
      const session = ctx.sessions.list.getSnapshot().byId[sessionId]
      if (session === undefined) throw new Error(t('linkSessionUnavailable'))
      try {
        const response = await fetch('/api/ego/pages', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
        if (!response.ok) throw new Error(t('linkFailed'))
        const payload: unknown = await response.json()
        if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true
          || !('targetId' in payload) || !validId(payload.targetId)) throw new Error(t('linkFailed'))
        const targetId = payload.targetId
        if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) throw new Error(t('linkSessionUnavailable'))
        const navigation = await fetch('/api/ego/navigation', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, targetId, action: 'navigate', url }) })
        if (!navigation.ok) throw new Error(t('linkFailed'))
        const result: unknown = await navigation.json()
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
          throw new Error(t('linkFailed'))
        }
        if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) throw new Error(t('linkSessionUnavailable'))
        ctx.sidebarRight.openResourceForSession(sessionId, addressFor(targetId),
          { kind: WATCH_KIND, reuseAddress: true, params: { targetId } })
      } catch {
        if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) throw new Error(t('linkSessionUnavailable'))
        throw new Error(t('linkFailed'))
      }
    },
  }
  ctx.provide('chatBrowserLinks', links)
  const pageTitle = (page: EgoPage): string => {
    if (page.title && page.title !== 'about:blank') return page.title
    try {
      const url = new URL(page.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname
    } catch { /* 未知或本地页面使用通用标题，避免将内部地址放在标签上。 */ }
    return t('page')
  }
  const onPages = (sessionId: SessionId, controller: BrowserEgoController): void => {
    const view = controller.view.getSnapshot()
    if (view.phase !== 'ready') return
    const firstPage = view.pages.find(page => page.active) ?? view.pages[0]
    ctx.sidebarRight.syncTabsForSession(sessionId, {
      kind: WATCH_KIND,
      fallback: { address: fallback, name: t('title') },
      pages: view.pages.map(page => ({
        address: addressFor(page.targetId),
        name: pageTitle(page), params: { targetId: page.targetId },
      })),
      ...(firstPage ? { firstSeen: addressFor(firstPage.targetId) } : {}),
    })
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: WATCH_ID,
    kind: WATCH_KIND,
    keepMounted: true,
    multiple: true,
    reuseAddress: true,
    title: () => t('title'),
    guide: [{ id: 'browser-ego-watch', order: 90, title: () => t('title'), icon: IconBrowseOutline16,
      create: async (sessionId) => {
        const response = await fetch('/api/ego/pages', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
        if (!response.ok) throw new Error('page creation failed')
        const payload: unknown = await response.json()
        if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true
          || !('targetId' in payload) || typeof payload.targetId !== 'string'
          || !/^[a-zA-Z0-9._~-]{1,128}$/u.test(payload.targetId)) throw new Error('invalid page')
        return { address: addressFor(payload.targetId), params: { targetId: payload.targetId } }
      } }],
  }), 'ui-browser-ego: tab definition')
  ctx.slots.inject('sidebar.right.pane.tab', () => {
    const dispose = ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: WATCH_ID, locale: NS,
      inject: (sessionId: SessionId): AgentBrowserInjected => {
        const controller = controllerFor(sessionId)
        if (!synced.has(sessionId)) {
          synced.set(sessionId, controller.view.subscribe(() => { onPages(sessionId, controller) }))
        }
        return {
          hooks: { browserEgo: controller.view, browserEgoSettings: capture },
          show: (visible, targetId) => { controller.show(visible, targetId) },
          refresh: () => controller.refresh(),
          navigate: (targetId, action, url) => controller.navigate(targetId, action, url),
          raiseWindow: () => controller.raiseWindow(),
          send: (targetId, input) => controller.send(targetId, input),
          hover: (targetId, x, y) => controller.hover(targetId, x, y),
          resize: (targetId, width, height) => controller.resize(targetId, width, height),
        }
      },
    }, AgentBrowserPanel)
    return () => {
      dispose()
      for (const stop of synced.values()) stop()
      synced.clear()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    }
  })
  // 设置页在组合后才声明该槽位；卡片按命名空间成为其中一项，读取的是同一绑定。
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', key: EGO_SETTINGS_NS, locale: NS,
    inject: () => card.inject(),
  }, EgoBrowserCard))
  ctx.effect(() => watchActivity((rawId) => {
    const sessionId = rawId as SessionId
    if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) {
      throw new Error('browser session is not loaded yet')
    }
    const controller = controllerFor(sessionId)
    const page = controller.view.getSnapshot().pages.find(item => item.active)
      ?? controller.view.getSnapshot().pages[0]
    ctx.sidebarRight.openResourceForSession(sessionId, page ? addressFor(page.targetId) : fallback,
      { kind: WATCH_KIND, reuseAddress: true, ...(page ? { params: { targetId: page.targetId } } : {}) })
  }), 'ui-browser-ego: activity')
}
