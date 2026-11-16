/** 只读全局文件管理设置分区。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import type {} from 'coding-client-ui-settings/client'
import { FilesSection } from './FilesSection.tsx'
import { FilesNavigationEntry } from './FilesNavigationEntry.tsx'
import { FilesPage } from './FilesPage.tsx'
import { en, zh, type FilesLocaleKey } from './locales.ts'
import { listManagedFiles } from './wire.ts'

const NS = 'settings.files'
const PAGE = 'managed-files'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 文件管理分区文案。 */
    'settings.files': FilesLocaleKey
  }
}

/** 设置槽与 locale。 */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces']

/**
 * 注册懒挂载的文件管理设置分区。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-files: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'files', order: 14, label: () => t('nav'), locale: NS,
    inject: () => ({ list: listManagedFiles }),
  }, FilesSection))
  ctx.slots.inject('shell.navigation.entry', () => ctx.slots.register({
    name: 'shell.navigation.entry', id: 'files', order: 10, locale: NS,
    inject: () => ({ hooks: { filesPage: ctx.layout.page }, openFiles: openFilesFor(ctx) }),
  }, FilesNavigationEntry))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: PAGE, locale: NS,
    inject: (_sessionId: SessionId) => ({
      list: (offset: number, limit: number, signal: AbortSignal, options?: { kind?: import('./wire.ts').ManagedFileKind; category?: import('./wire.ts').ManagedFileCategory }) =>
        listManagedFiles(offset, limit, signal, { unscoped: true, ...options }),
    }),
  }, FilesPage))
}

function openFilesFor(ctx: ClientContext): () => Promise<void> {
  let opening: Promise<void> | undefined
  return () => {
    opening ??= (async() => {
      const current = ctx.sessions.list.getSnapshot().current
      // 从画图等独立页切入时沿用先前对话的来处，不把文件页所属会话当成归途。
      const origin = ctx.layout.page.getSnapshot()?.returnSessionId ?? current
      const target = current ?? await ctx.workspaces.connectHome()
      ctx.sessions.open(target)
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          ctx.layout.togglePage(PAGE, target, origin)
          return
        } catch {
          await new Promise<void>((resolve) => { window.setTimeout(resolve, 32) })
        }
      }
      throw new Error('files page unavailable')
    })().finally(() => { opening = undefined })
    return opening
  }
}
