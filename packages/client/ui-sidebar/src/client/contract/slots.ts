/**
 * 侧边栏 slot 契约：布局持有的 `sidebar` slot 对注册者暴露的 props 组合，以及壳层声明的洞。
 * 壳层持有栏几何（折叠状态机、顶部避让行、新对话行）；其后的可选入口由
 * `sidebar.top.entry` 注册者持有，设置入口属于
 * `sidebar.settings` 注册者（ui-settings），它与工作区列表之间由壳层的分隔线隔开；
 * 标题与列表之间属于 `sidebar.workspaces` 注册者（ui-workspace），底部是
 * `sidebar.footer.action` 的可选页脚动作。
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from 'coding-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from 'coding-client-ui-layout/client'
import type { WorkspaceId } from 'coding-client-runtime/client'

declare module 'coding-client-ui-slots' {
  interface SlotMap {
    /**
     * 新对话与设置之间的可选整行入口。收起的 56px rail 中入口排在新对话图标与展开按钮
     * 之间。注册者按列表条目注册（每个条目自带 `id` 与可选 `order`），收到 `wide`：为
     * `false` 时须提供 36×36 纯图标呈现。无条目或条目返回空内容时不占位。
     */
    'sidebar.top.entry': { kind: 'list'; scope: 'root'; owner: SidebarTopEntryOwnerProps }
    /**
     * The workspace/session browsing region: section header, search, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * The settings seat directly under the New chat entry, above the divider
     * that closes the sidebar's top entry block. Declared by this package's
     * 'sidebar' entry; ui-settings registers its trigger row + modal panel.
     * The trigger shares the New chat row's geometry, and the sidebar passes
     * only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions pinned to the sidebar foot, below the browsing region.
     * Declared by this package's 'sidebar' entry; each action receives only
     * the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/**
 * 顶部可选整行入口的 owner share。占用者常驻可见（含收起 rail），因此每个动作都要在
 * `wide` 与 rail 两种形态下可用。
 */
export interface SidebarTopEntryOwnerProps {
  /** 侧边栏是否渲染宽内容（false = 56px rail）。 */
  wide: boolean
}

/**
 * 浏览区域的 owner share：壳层与区域之间唯一跨越边界的事实。业务数据与动作走区域
 * 自己的 inject。
 */
export interface SidebarSectionOwnerProps {
  /** 壳层折叠状态：true 渲染完整浏览器，false 渲染 56px rail 的图标列。 */
  wide: boolean
  /** rail 图标请求展开；浏览器跟随 wide 翻转处理焦点。 */
  expandSidebar: () => void
  /** 宽侧栏的标题行用它渲染收起按钮；已展开时才会真正收起。 */
  collapseSidebar: () => void
}

/**
 * 设置座位的 owner share：占用者的触发行要按它渲染（宽行 vs rail 图标）。
 */
export interface SidebarSettingsOwnerProps {
  /** 侧边栏是否渲染宽内容（false = 56px rail）。 */
  wide: boolean
}

/** 渲染在侧栏页脚设置旁的动作的 owner share。 */
export interface SidebarFooterActionOwnerProps {
  /** 侧边栏是否渲染宽内容（false = 56px rail）。 */
  wide: boolean
}

/**
 * 注册者私有的注入 share（来自 register 的 inject 工厂）。壳层只持有自己的控件：
 * 从新对话入口启动会话，以及折叠整列。
 */
export type SidebarRootInjected = {
  /**
   * 启动新会话：指定工作区时复用或创建它的空白会话并打开；未指定时先继承当前
   * Session 所属工作区，再退到最近工作区，都没有则清空为 New Session 空视图。
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * 完整组件 props：布局 owner 状态与动作、已声明洞的渲染 share、本包注入的回调，
 * 以及标准 locale 座位。这里不注册 store。
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.top.entry'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & SidebarRootInjected & PropsLocale<'sidebar'>
