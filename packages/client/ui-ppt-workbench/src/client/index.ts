/**
 * 右侧工作台的「PPT 工作台」标签：把 `coding-ppt-workbench` 的浏览器半挂进外部标签槽位，
 * 仅让已开始对话的 PPT 创作会话自动打开所属工作台标签。
 *
 * 面板只经 `/api/ppt/*` 与宿主往返（同一份工程服务也供模型工具使用），轮询承担
 * 「宿主 → 浏览器」的推送：模型打开别的工程、或在别处改了同一份工程，面板下一次
 * 轮询就能看到。可见时才轮询，隐藏即停。
 * @module coding-ppt-workbench/client
 */

import type { ClientContext } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import type { ConnectionHandle } from 'coding-client-connection/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-open-in-app/client'
import type {} from 'coding-client-ui-conversation/client'
import type {} from 'coding-client-ui-layout/client'
import { PptPanelController } from './controller.ts'
import { PptWorkbench, type PptWorkbenchInjected } from './PptWorkbench.tsx'
import { TemplateCatalogController } from './template-catalog.ts'
import { TemplateSettingsSection, type TemplateCatalogInjected } from './TemplateCatalog.tsx'
import { createTemplateNavigation } from './template-navigation.ts'
import { en, NS, zh, type PptWorkbenchKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 右侧 PPT 工作台的展示文案。 */
    'ppt-workbench': PptWorkbenchKey
  }
}

/** 标签类型 id（内容座位按它分派）与去重用的 kind。 */
export const TAB_ID = 'ppt-workbench'
export const TAB_KIND = 'ppt'
/** 需要自动打开 PPT 工作台的 agent preset id。 */
const PRESET_ID = 'ppt'
/** 工作台尚未挂载时的重试节奏；约 6 秒后放弃，页面刷新后可重试。 */
const RETRY_MS = 300
const RETRY_LIMIT = 20

/** 依赖右侧工作台所有者、会话列表与文案服务。 */
export const inject = [
  'slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'workspaces', 'connection',
  'conversation', 'layout',
]

/**
 * 注册标签类型、内容座位与模式联动。
 * @param ctx - Client 插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ppt: dictionaries')
  const t = ctx.locale.bind(NS)
  const controllers = new Map<string, PptPanelController>()
  const opened = new Set<string>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const catalog = new TemplateCatalogController()
  const navigation = createTemplateNavigation(
    ctx.sessions, ctx.workspaces, (ctx.get('connection') as ConnectionHandle).api,
    ctx.conversation, ctx.layout,
  )
  ctx.effect(() => () => { catalog.dispose(); navigation.dispose() }, 'ui-ppt: template navigation')

  const catalogActions: Omit<TemplateCatalogInjected, 'hooks'> = {
    loadTemplates: () => catalog.load(),
    loadBuiltins: () => catalog.loadBuiltins(),
    detailTemplate: id => catalog.detail(id),
    templateMediaUrl: (id, path) => catalog.mediaUrl(id, path),
    handoffPrompt: (text, id) => navigation.handoffPrompt(text, id),
    cancelHandoff: (id) => { navigation.cancelHandoff(id) },
    focusPrompt: (id) => { navigation.focusPrompt(id) },
  }

  const controllerFor = (sessionId: string): PptPanelController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new PptPanelController(sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  ctx.effect(() => () => {
    for (const timer of retries.values()) clearTimeout(timer)
    retries.clear()
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
  }, 'ui-ppt: controllers')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    keepMounted: true,
    priority: 'builtin',
    title: () => t('title'),
  }), 'ui-ppt: tab definition')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'ppt-templates', order: 18, label: () => t('catalogTitle'), locale: NS,
    inject: () => ({ hooks: { templateCatalog: catalog.view }, ...catalogActions }),
  }, TemplateSettingsSection))

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
    inject: (sessionId: SessionId): PptWorkbenchInjected => {
      const controller = controllerFor(sessionId)
      return {
        hooks: { ppt: controller.view, templateCatalog: catalog.view },
        catalogActions,
        show: (visible) => { controller.show(visible) },
        refresh: () => { void controller.refresh() },
        open: dir => controller.open(dir),
        create: title => controller.create(title),
        undo: () => controller.undo(),
        redo: () => controller.redo(),
        exportDeck: () => controller.exportDeck(),
        selectPage: (index) => { controller.selectPage(index) },
        selectElement: (id) => { controller.selectElement(id) },
        setEditing: (id) => { controller.setEditing(id) },
        addPage: template => controller.addPage(template),
        removePage: pageId => controller.removePage(pageId),
        movePage: (pageId, to) => controller.movePage(pageId, to),
        addElement: kind => controller.addElement(kind),
        removeElement: id => controller.removeElement(id),
        updateElement: (id, patch) => controller.updateElement(id, patch),
        updatePage: patch => controller.updatePage(patch),
        updateDeck: patch => controller.updateDeck(patch),
        duplicateElement: id => controller.duplicateElement(id),
        reorderElement: (id, to) => controller.reorderElement(id, to),
        insertImage: file => controller.insertImage(file),
        checkDeck: () => controller.checkDeck(),
        preview: pages => controller.preview(pages),
        mediaUrl: (dir, source) => {
          const query = new URLSearchParams({ sessionId, path: source })
          if (dir !== undefined) query.set('dir', dir)
          return `/api/ppt/media?${query.toString()}`
        },
      }
    },
  }, PptWorkbench))

  /**
   * 打开 PPT 标签；工作台还没挂载时按固定节奏重试。
   *
   * 自动打开只在已开始对话的 PPT 会话里发生一次：手动关闭后不再弹开。
   * @param sessionId - 需要显示工作台的会话。
   */
  const ensureOpen = (sessionId: SessionId): void => {
    if (opened.has(sessionId) || retries.has(sessionId)) return
    let attempts = 0
    const attempt = (): void => {
      retries.delete(sessionId)
      if (opened.has(sessionId)) return
      const snapshot = ctx.sessions.list.getSnapshot()
      const summary = snapshot.byId[sessionId]
      if (snapshot.current !== sessionId || summary?.agentPreset !== PRESET_ID || summary.blank) return
      try {
        ctx.sidebarRight.openTabForSession(sessionId, TAB_KIND)
        opened.add(sessionId)
      } catch {
        attempts += 1
        if (attempts >= RETRY_LIMIT) return
        retries.set(sessionId, setTimeout(attempt, RETRY_MS))
      }
    }
    attempt()
  }

  const syncMode = (): void => {
    const state = ctx.sessions.list.getSnapshot()
    const current = state.current
    if (current === undefined) return
    const summary = state.byId[current]
    if (summary?.agentPreset !== PRESET_ID || summary.blank) return
    ensureOpen(current)
  }

  ctx.effect(() => ctx.sessions.list.subscribe(syncMode), 'ui-ppt: follow ppt mode')
  syncMode()
}
