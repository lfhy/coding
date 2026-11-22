/** 将导图编辑器贡献到笔记页声明的正文插槽。 */
import type {} from 'coding-client-locale/client'
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-ui-notes/client'
import { en, NS, zh, type MindmapLocaleKey } from './locales.ts'
import { MindmapEditor } from './MindmapEditor.tsx'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 思维导图编辑与恢复文案。 */
    mindmap: MindmapLocaleKey
  }
}

/** 编辑器只依赖插槽注册和翻译服务。 */
export const inject = ['slots', 'locale']

/**
 * 安装文案并等待笔记页声明内容插槽；声明失效后同步卸载贡献。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mindmap: dictionaries')
  ctx.slots.inject('notes.document.mindmap', () => ctx.slots.register({
    name: 'notes.document.mindmap',
    locale: NS,
  }, MindmapEditor))
}
