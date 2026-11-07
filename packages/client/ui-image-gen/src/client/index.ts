/** 将图像设置、主内容画廊与画布贡献到现有 slot。 */
import type { ClientContext, SessionId } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import type {} from 'coding-client-ui-layout/client'
import type {} from 'coding-client-ui-conversation/client'
import type {} from 'coding-client-ui-sidebar/client'
import type {} from 'coding-client-ui-tool/client'
import { CanvasController } from './canvas.ts'
import { EntryButton, type EntryFace } from './EntryButton.tsx'
import { GalleryController } from './gallery.ts'
import { GalleryView } from './GalleryView.tsx'
import { ImageToolRow } from './ImageToolRow.tsx'
import { createGalleryUiStore } from './gallery-ui-store.ts'
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

/** 画廊与画布共用主内容工作台。 */
const GALLERY_PAGE = 'image-gallery'

/** 插件只依赖已有界面、会话和 RPC 服务。 */
export const inject = [
  'slots', 'locale', 'sessions', 'workspaces', 'settingsScope', 'connection', 'remote',
  'layout',
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
  ctx.effect(() => ctx.remote.$on('credentials/updated', (ref) => {
    if (ref === settings.view.getSnapshot().section.value?.apiKeyRef) void settings.refreshCredential()
  }), 'ui-image-gen: credential invalidations')
  ctx.effect(() => ctx.on('connection/reset', () => { void settings.refreshCredential() }),
    'ui-image-gen: credential reconnect')
  const galleries = new Map<SessionId, GalleryController>()
  const galleryUi = createGalleryUiStore()
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
  const openGallery = createGalleryNavigation(ctx.sessions, ctx.workspaces, api, (sessionId) => {
    try { ctx.layout.togglePage(GALLERY_PAGE, sessionId); return true } catch { return false }
  })

  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['generate_image', 'generate_images', 'edit_image', 'image_gen']) {
      yield ctx.slots.register({
        name: 'tool.call.toolview', key, locale: NS,
        inject: (sessionId: SessionId) => ({
          openInStudio: () => { ctx.sessions.open(sessionId); ctx.layout.openPage(GALLERY_PAGE, sessionId) },
        }),
      }, ImageToolRow)
    }
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'image-generation', order: 13, label: () => t('nav'), locale: NS,
    inject: () => settings.inject(),
  }, SettingsSection))
  ctx.slots.inject('sidebar.top.entry', () => ctx.slots.register({
    name: 'sidebar.top.entry', id: 'image-generation', order: 20, locale: NS,
    inject: () => ({ hooks: { imageEntrySettings: settings.view, galleryPage: ctx.layout.page }, openGallery }),
  }, SidebarEntry))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'image-generation', order: 15, locale: NS,
    inject: (): EntryFace => ({ hooks: { imageEntrySettings: settings.view }, openGallery }),
  }, EntryButton))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: GALLERY_PAGE, locale: NS, store: galleryUi,
    inject: (sessionId: SessionId) => {
      const gallery = galleryFor(sessionId)
      const canvas = canvasFor(sessionId)
      return {
        hooks: { gallery: gallery.view },
        show: (shown: boolean) => { gallery.show(shown) },
        refresh: () => { void gallery.refresh() },
        generate: (prompt: string, imageId?: string | readonly string[], output?: import('./wire.ts').ImageOutput) =>
          gallery.generate(prompt, imageId, output),
        importReference: (file: File) => gallery.importReference(file),
        place: async (id: string) => {
          const item = gallery.view.getSnapshot().items.find(entry => entry.id === id)
          if (item === undefined) return false
          return canvas.addImage(id, item.width, item.height)
        },
        url: (id: string) => gallery.url(id),
      }
    },
  }, GalleryView))
}
