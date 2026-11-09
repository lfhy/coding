/** 只读全局文件管理设置分区。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import { FilesSection } from './FilesSection.tsx'
import { en, zh, type FilesLocaleKey } from './locales.ts'
import { listManagedFiles } from './wire.ts'

const NS = 'settings.files'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 文件管理分区文案。 */
    'settings.files': FilesLocaleKey
  }
}

/** 设置槽与 locale。 */
export const inject = ['slots', 'locale']

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
}
