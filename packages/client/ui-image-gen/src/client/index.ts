/** 将图像设置、画廊面板及画布独立贡献到现有 slot，不复制上游的持久化或界面。 */
import type { ClientContext, SessionId } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import type {} from 'coding-client-ui-open-in-app/client'
import type {} from 'coding-client-ui-conversation/client'
import type {} from 'coding-client-ui-sidebar/client'
import { CanvasController } from './canvas.ts'
import { CanvasPanel } from './CanvasPanel.tsx'
import { EntryButton, type EntryFace } from './EntryButton.tsx'
import { GalleryController } from './gallery.ts'
import { GalleryView } from './GalleryView.tsx'
import { en, NS, zh, type ImageKey } from './locales.ts'
import { createGalleryNavigation } from './navigation.ts'
import { SettingsSection } from './SettingsSection.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { decodeImageSettings, ImageSettingsController, SETTINGS_NAMESPACE } from './settings.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 图像生成设置、画廊与画布的界面文案。 */
    'image-generation': ImageKey
  }
}

/** 画廊与画布是右侧工作台的两个内置标签。 */
const GALLERY_TAB = 'image-gallery'
const CANVAS_TAB = 'image-canvas'
/** 工作台标签挂载前的重试节奏；约 6 秒后放弃，面板可由入口再次打开。 */
const RETRY_MS = 300
const RETRY_LIMIT = 20

/** 插件只依赖已有界面、会话和 RPC 服务。 */
export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'settingsScope', 'connection',
  'sidebarRight', 'sidebarRightTabs',
]

/**
 * 注册图像界面的槽位与会话级控制器；所有注册随插件卸载撤销。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-image-gen: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = (ctx.get('connection') as ConnectionHandle).api
  const settings = new ImageSettingsController(
    ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE, decode: decodeImageSettings }), api,
  )
  const galleries = new Map<SessionId, GalleryController>()
  const canvases = new Map<SessionId, CanvasController>()
  const galleryFor = (id: SessionId): GalleryController => {
    let gallery = galleries.get(id)
    if (gallery === undefined) { gallery = new GalleryController(id); galleries.set(id, gallery) }
    return gallery
  }
  const canvasFor = (id: SessionId): CanvasController => {
    let canvas = canvases.get(id)
    if (canvas === undefined) {
      canvas = new CanvasController(id, imageId => galleryFor(id).url(imageId))
      canvases.set(id, canvas)
    }
    return canvas
  }
  ctx.effect(() => () => {
    settings.dispose()
    for (const gallery of galleries.values()) gallery.dispose()
    for (const canvas of canvases.values()) canvas.dispose()
    galleries.clear()
    canvases.clear()
  }, 'ui-image-gen: session controllers')
  const openTab = (sessionId: SessionId, kind: string): boolean => {
    try {
      ctx.sidebarRight.openTabForSession(sessionId, kind)
      return true
    } catch { return false }
  }
  const openGallery = createGalleryNavigation(
    ctx.sessions, ctx.workspaces, api, sessionId => openTab(sessionId, GALLERY_TAB),
  )

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'image-generation', order: 13, label: () => t('nav'), locale: NS,
    inject: () => settings.inject(),
  }, SettingsSection))
  ctx.slots.inject('sidebar.brand.action', () => ctx.slots.register({
    name: 'sidebar.brand.action', id: 'image-generation', order: 20, locale: NS,
    inject: () => ({ hooks: { imageEntrySettings: settings.view }, openGallery }),
  }, SidebarEntry))
  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions', id: 'image-generation', order: 15, locale: NS,
    inject: (): EntryFace => ({ hooks: { imageEntrySettings: settings.view }, seat: 'welcome', openGallery }),
  }, EntryButton))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'image-generation', order: 15, locale: NS,
    inject: (): EntryFace => ({ hooks: { imageEntrySettings: settings.view }, seat: 'session', openGallery }),
  }, EntryButton))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: GALLERY_TAB, kind: GALLERY_TAB, keepMounted: true, priority: 'builtin', title: () => t('gallery'),
  }), 'ui-image-gen: gallery tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: GALLERY_TAB, locale: NS,
    inject: (sessionId: SessionId) => {
      const gallery = galleryFor(sessionId)
      return {
        hooks: { gallery: gallery.view },
        show: (shown: boolean) => { gallery.show(shown) },
        refresh: () => { void gallery.refresh() },
        openCanvas: () => openTab(sessionId, CANVAS_TAB),
        generate: (prompt: string, imageId?: string) => gallery.generate(prompt, imageId),
        place: async (id: string) => {
          const item = gallery.view.getSnapshot().items.find(entry => entry.id === id)
          if (item === undefined) return false
          const saved = await canvasFor(sessionId).addImage(id, item.width, item.height)
          if (saved) openTab(sessionId, CANVAS_TAB)
          return saved
        },
        url: (id: string) => gallery.url(id),
      }
    },
  }, GalleryView))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CANVAS_TAB, kind: CANVAS_TAB, keepMounted: true, priority: 'builtin', title: () => t('canvas'),
  }), 'ui-image-gen: canvas tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CANVAS_TAB, locale: NS,
    inject: (sessionId: SessionId) => {
      const canvas = canvasFor(sessionId)
      return {
        hooks: { imageCanvas: canvas.view }, show: (shown: boolean) => { canvas.show(shown) },
        refresh: () => { void canvas.refresh() }, add: (node: Parameters<typeof canvas.add>[0]) => canvas.add(node),
        select: (id: string | null) => { canvas.select(id) },
        move: (id: string, x: number, y: number) => canvas.move(id, x, y),
        remove: () => canvas.remove(), clear: () => canvas.clear(), url: (id: string) => canvas.url(id),
      }
    },
  }, CanvasPanel))

  // 每个画图会话只在开始对话后自动打开画廊面板一次；手动关闭后不因再次选择会话而抢占。
  const opened = new Set<SessionId>()
  const pending = new Map<SessionId, ReturnType<typeof setTimeout>>()
  const follow = () => {
    const state = ctx.sessions.list.getSnapshot()
    const id = state.current
    if (window.innerWidth < 1024 || id === undefined || opened.has(id) || pending.has(id)) return
    let attempts = 0
    const attempt = () => {
      pending.delete(id)
      const snapshot = ctx.sessions.list.getSnapshot()
      const summary = snapshot.byId[id]
      if (window.innerWidth < 1024 || opened.has(id) || snapshot.current !== id
        || summary?.agentPreset !== 'image' || summary.blank) return
      if (openTab(id, GALLERY_TAB)) { opened.add(id); return }
      if (++attempts < RETRY_LIMIT) pending.set(id, setTimeout(attempt, RETRY_MS))
    }
    attempt()
  }
  ctx.effect(() => ctx.sessions.list.subscribe(follow), 'ui-image-gen: follow image sessions')
  ctx.effect(() => {
    window.addEventListener('resize', follow)
    return () => { window.removeEventListener('resize', follow) }
  }, 'ui-image-gen: follow viewport changes')
  ctx.effect(() => () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear() }, 'ui-image-gen: stop follow')
  follow()
}
