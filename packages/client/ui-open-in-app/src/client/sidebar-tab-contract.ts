/** 右侧工作台第三方标签的 UI 插槽契约。 */

import type { WorkbenchExternalTab } from './store.ts'

/** 内容与标题座位共享的当前标签信息；不携带 React 节点或服务对象。 */
export interface SidebarRightTabOwnerProps {
  tab: WorkbenchExternalTab
  shown: boolean
  tabDomId: string
  panelDomId: string
  selectTab: () => void
  closeTab: () => void
}

/** 每个分派位置绑定的上下文 Hook 由 UI renderer 生成。 */
export interface SidebarRightTabSlotInject {
  hooks: {
    tabInfo: (_standard: object, context: SidebarRightTabOwnerProps) => () => SidebarRightTabOwnerProps
  }
}

/** 不订阅额外状态；当前 owner 由该分派位置保持。 */
export const tabInfoInject: SidebarRightTabSlotInject = {
  hooks: { tabInfo: (_standard, context) => () => context },
}
