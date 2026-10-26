/**
 * 侧边栏 slot 契约：布局持有的 `sidebar` slot 对注册者暴露的 props 组合，以及壳层声明的洞。
 * 壳层持有栏几何（折叠状态机、顶部避让行、新建对话行）；标题与列表底部之间属于
 * `sidebar.workspaces` 注册者（ui-workspace），底部属于 `sidebar.settings` 注册者
 * （ui-settings），其后是 `sidebar.footer.action` 的可选页脚动作。
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from 'coding-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from 'coding-client-ui-layout/client'
import type { WorkspaceId } from 'coding-client-runtime/client'

declare module 'coding-client-ui-slots' {
  interface SlotMap {
    /**
     * 新建对话行内的可选常驻动作，渲染在新对话入口之后。宽侧栏中它们与入口同排，是一个
     * 横向图标行；收起的 56px rail 中则纵向排列，排在新建对话图标与展开按钮之间。注册者按
     * 列表条目注册（每个条目自带 `id` 与可选 `order`），进入 `sidebar.brand.action` 的条目在
     * 所有侧边栏宽度下都可见，因此工作台关闭时也能作为入口。组件收到 `wide`：为 `false` 时
     * 必须提供适合 36×36 控件盒的纯图标呈现。没有注册者时该洞渲染为空，不占位。
     */
    'sidebar.brand.action': { kind: 'list'; scope: 'root'; owner: SidebarBrandActionOwnerProps }
    /**
     * The workspace/session browsing region: section header, search, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * The settings seat at the sidebar foot. Declared by this package's
     * 'sidebar' entry; ui-settings registers its trigger row + modal panel.
     * The sidebar passes only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions beside Settings at the sidebar foot. Declared by this
     * package's 'sidebar' entry; each action receives only the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/**
 * 新建对话行常驻动作的 owner share。占用者常驻可见（含收起 rail），因此每个动作都要在
 * `wide` 与 rail 两种形态下可用。
 */
export interface SidebarBrandActionOwnerProps {
  /** 侧边栏是否渲染宽内容（false = 56px rail）。 */
  wide: boolean
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * boundary. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/**
 * Owner share of the sidebar settings seat: the column display state the
 * occupant's trigger row must render against (wide row vs rail icon).
 */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The shell keeps only its own controls: starting a Session from
 * the New Session button and toggling the column.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.action'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & SidebarRootInjected & PropsLocale<'sidebar'>
