/** 笔记页插件：外侧窄导航入口、独立主内容页与复用对话会话的 AI 助手轨。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import { createNotesConversation, createNotesNavigation } from './navigation.ts'
import { NotesNavigationEntry } from './NavigationEntry.tsx'
import { NotesPage } from './NotesPage.tsx'
import { createNotesUiStore } from './notes-ui-store.ts'
import { en, zh, type NotesLocaleKey } from './locales.ts'

const NS = 'notes'
const PAGE = 'notes'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 笔记页文案。 */
    'notes': NotesLocaleKey
  }
}

/** 笔记插件的注入声明。 */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'connection']

/**
 * 注册笔记导航入口与主内容页。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  const openNotes = createNotesNavigation(ctx)
  const startConversation = createNotesConversation(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notes: dictionaries')
  // 助手头部的「新对话」入口由笔记页提供：新会话仍以笔记目录为工作目录。
  ctx.effect(() => ctx.layout.attachPageConversation(startConversation), 'ui-notes: new assistant conversation')
  ctx.slots.inject('shell.navigation.entry', () => ctx.slots.register({
    name: 'shell.navigation.entry', id: 'notes', order: 15, locale: NS,
    inject: () => ({ hooks: { notesPage: ctx.layout.page }, openNotes }),
  }, NotesNavigationEntry))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: PAGE, locale: NS, store: createNotesUiStore,
  }, NotesPage))
}
