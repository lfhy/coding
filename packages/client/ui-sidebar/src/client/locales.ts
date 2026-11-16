/** `sidebar` 命名空间字典：壳层控件（新对话行、新建对话）。 */

/** 简体中文字典（键集的事实来源）。 */
export const zh = {
  'session.new': '新对话',
  'session.new.label': '新建对话',
} satisfies Record<string, string>

/** 侧边栏命名空间的键联合。 */
export type SidebarKey = keyof typeof zh

/** 英文字典，按中文键集校验完整性。 */
export const en = {
  'session.new': 'New chat',
  'session.new.label': 'New chat',
} satisfies Record<SidebarKey, string>
