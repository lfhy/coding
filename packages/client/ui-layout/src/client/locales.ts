/** 布局壳持有的悬浮对话控件文案。 */
export const zh = {
  'floating.open': '继续对话',
  'floating.open.label': '打开悬浮对话',
  'floating.dialog.label': '悬浮对话',
  'floating.minimize.label': '收起悬浮对话',
} satisfies Record<string, string>

/** 布局命名空间的键集。 */
export type LayoutKey = keyof typeof zh

/** 英文字典保持相同键集。 */
export const en = {
  'floating.open': 'Continue conversation',
  'floating.open.label': 'Open floating conversation',
  'floating.dialog.label': 'Floating conversation',
  'floating.minimize.label': 'Minimize floating conversation',
} satisfies Record<LayoutKey, string>
