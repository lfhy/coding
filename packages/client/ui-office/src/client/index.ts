/** 把办公编辑器挂到笔记页所声明的正文座位。 */
import type {} from 'coding-client-locale/client'
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-ui-notes/client'
import { createOfficeDraftStore } from './drafts.ts'
import { en, NS, zh, type OfficeLocaleKey } from './locales.ts'
import { OfficeEditor } from './OfficeEditor.tsx'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 保存、冲突和办公文档编辑文案。 */
    office: OfficeLocaleKey
  }
}

/** 只使用插槽和翻译服务。 */
export const inject = ['slots', 'locale']

/**
 * 安装词典并等待笔记正文的实际声明；声明撤销时释放贡献。
 * @param ctx - 浏览器侧插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-office: dictionaries')
  ctx.slots.inject('notes.document.office', () => ctx.slots.register({
    name: 'notes.document.office', locale: NS, store: createOfficeDraftStore,
  }, OfficeEditor))
}
