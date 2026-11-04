/** 将图像设置、画廊及画布独立贡献到现有 slot，不复制上游的持久化或界面。 */
import type { ClientContext, SessionId } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import type {} from 'coding-client-ui-open-in-app/client'
import type {} from 'coding-client-ui-conversation/client'
import { CanvasController } from './canvas.ts'
import { CanvasPanel } from './CanvasPanel.tsx'
import { EntryButton } from './EntryButton.tsx'
import { GalleryController } from './gallery.ts'
import { GalleryView } from './GalleryView.tsx'
import { en, NS, zh, type ImageKey } from './locales.ts'
import { createGalleryNavigation } from './navigation.ts'
import { SettingsSection } from './SettingsSection.tsx'
import { decodeImageSettings, ImageSettingsController, SETTINGS_NAMESPACE } from './settings.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 图像生成设置、画廊与画布的界面文案。 */
    'image-generation': ImageKey
  }
}

/** 插件只依赖已有界面、会话和 RPC 服务。 */
export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'settingsScope', 'connection',
  'conversation', 'sidebarRight', 'sidebarRightTabs',
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
  const openGallery = createGalleryNavigation(ctx.sessions, ctx.workspaces, api, ctx.conversation)
  // 每个会话最多自动打开一次；手动关闭后不因再次选择会话而抢占。
  const opened = new Set<SessionId>()
  const pending = new Map<SessionId, ReturnType<typeof setTimeout>>()
  const openCanvasFor = (sessionId: SessionId): boolean => {
    try {
      ctx.sidebarRight.openTabForSession(sessionId, 'image-canvas')
      opened.add(sessionId)
      return true
    } catch { return false }
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'image-generation', order: 13, label: () => t('nav'), locale: NS,
    inject: () => settings.inject(),
  }, SettingsSection))
  ctx.slots.inject('conversation.hero.actions', () => ctx.slots.register({
    name: 'conversation.hero.actions', id: 'image-generation', order: 15, locale: NS,
    inject: () => ({ hooks: { imageEntrySettings: settings.view }, openGallery }),
  }, EntryButton))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'image-generation', order: 15, locale: NS,
    inject: () => ({ hooks: { imageEntrySettings: settings.view }, openGallery }),
  }, EntryButton))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'image-gallery', order: 20, label: () => t('gallery'), locale: NS,
    inject: (sessionId: SessionId) => {
      const gallery = galleryFor(sessionId)
      return {
        hooks: { gallery: gallery.view },
        show: (shown: boolean) => { gallery.show(shown) },
        refresh: () => { void gallery.refresh() },
        openCanvas: () => openCanvasFor(sessionId),
        generate: (prompt: string, imageId?: string) => gallery.generate(prompt, imageId),
        place: async (id: string) => {
          const item = gallery.view.getSnapshot().items.find(entry => entry.id === id)
          if (item === undefined) return false
          const saved = await canvasFor(sessionId).addImage(id, item.width, item.height)
          if (saved) openCanvasFor(sessionId)
          return saved
        },
        url: (id: string) => gallery.url(id),
      }
    },
  }, GalleryView))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'image-canvas', kind: 'image-canvas', keepMounted: true, priority: 'builtin', title: () => t('canvas'),
  }), 'ui-image-gen: canvas tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'image-canvas', locale: NS,
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

  const follow = () => {
    const state = ctx.sessions.list.getSnapshot()
    const id = state.current
    if (window.innerWidth < 1024 || id === undefined || opened.has(id) || pending.has(id)
      || state.byId[id]?.agentPreset !== 'image') return
    let attempts = 0
    const attempt = () => {
      pending.delete(id)
      if (window.innerWidth < 1024 || opened.has(id) || ctx.sessions.list.getSnapshot().current !== id) return
      if (!openCanvasFor(id) && ++attempts < 20) pending.set(id, setTimeout(attempt, 300))
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
