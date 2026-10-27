/** 将侧边栏壳层注册到布局持有的 slot。 */
import type { ClientContext } from 'coding-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-conversation/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandActionOwnerProps, SidebarFooterActionOwnerProps,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
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
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      // 壳层持有几何；ui-workspace 注册完整浏览区域（标题、搜索、会话列表、Workspace 对话框），
      // ui-settings 注册新对话行下方的设置入口和设置面板。
      children: {
        // 新对话行内的常驻动作：宽侧栏与收起 rail 都渲染，靠在新对话入口之后。
        'sidebar.brand.action': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )

}
