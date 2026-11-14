/** 将侧边栏壳层注册到布局持有的 slot。 */
import type { ClientContext } from 'coding-client-runtime/client'
// 仅类型导入：合并 locale 插件的 ctx.locale 声明。
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-conversation/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarTopEntryOwnerProps, SidebarFooterActionOwnerProps,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 侧边栏壳层控件文案。 */
    sidebar: SidebarKey
  }
}

/** 本插件持有的字典命名空间（壳层控件文案）。 */
const NS = 'sidebar'

/** 侧边栏插件所需的服务。 */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale']

/** 注册侧边栏壳层及其服务回调。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')

  const injectProps = (): SidebarRootInjected => ({
    // 壳层的新对话入口复用运行时共享操作：先当前 Session 的 Workspace，后最近 Workspace。
    startSession: (workspaceId) => {
      ctx.layout.beginNewConversation()
      ctx.workspaces.startSession(workspaceId)
    },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    showConversation: () => { ctx.layout.closePage() },
    hooks: { page: ctx.layout.page },
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      // 壳层持有几何；ui-workspace 注册完整浏览区域（标题、搜索、会话列表、Workspace 对话框）。
      children: {
        // 新对话下方的可选整行入口；折叠 rail 中也保持相同的顺序。
        'sidebar.top.entry': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )

}
