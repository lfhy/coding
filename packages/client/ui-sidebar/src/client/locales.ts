/** `sidebar` 命名空间字典：壳层控件（新对话行、新建对话、折叠开关）。 */

/** 简体中文字典（键集的事实来源）。 */
export const zh = {
  'session.new': '新对话',
  'session.new.label': '新建对话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
} satisfies Record<string, string>

/** 侧边栏命名空间的键联合。 */
export type SidebarKey = keyof typeof zh

/** 英文字典，按中文键集校验完整性。 */
export const en = {
  'session.new': 'New chat',
  'session.new.label': 'New chat',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
} satisfies Record<SidebarKey, string>
