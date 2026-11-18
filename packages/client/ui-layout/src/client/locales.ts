/** 窗口导航与布局壳持有的悬浮对话控件文案。 */
export const zh = {
  'shell.navigation': '主导航',
  'shell.conversation': '回到对话',
  'shell.sidebar.collapse': '收起侧边栏',
  'shell.sidebar.expand': '展开侧边栏',
  'shell.theme.light': '切换浅色主题',
  'shell.theme.dark': '切换深色主题',
  'assistant.title': 'AI 助手',
  'assistant.close': '收起 AI 助手',
  'assistant.new': '新对话',
  'floating.open': '继续对话',
  'floating.open.label': '打开悬浮对话',
  'floating.dialog.label': '悬浮对话',
  'floating.minimize.label': '收起悬浮对话',
  'floating.drag.label': '拖拽对话窗口',
  'floating.drag.hint': '当前位置：{position}。拖动后自动吸附；左右方向键切换位置，Home 或 End 移至两端。',
  'floating.dock.left': '左下角',
  'floating.dock.center': '底部居中',
  'floating.dock.right': '右下角',
} satisfies Record<string, string>

/** 布局命名空间的键集。 */
export type LayoutKey = keyof typeof zh

/** 英文字典保持相同键集。 */
export const en = {
  'shell.navigation': 'Main navigation',
  'shell.conversation': 'Back to conversation',
  'shell.sidebar.collapse': 'Collapse sidebar',
  'shell.sidebar.expand': 'Expand sidebar',
  'shell.theme.light': 'Switch to light theme',
  'shell.theme.dark': 'Switch to dark theme',
  'assistant.title': 'AI assistant',
  'assistant.close': 'Hide AI assistant',
  'assistant.new': 'New conversation',
  'floating.open': 'Continue conversation',
  'floating.open.label': 'Open floating conversation',
  'floating.dialog.label': 'Floating conversation',
  'floating.minimize.label': 'Minimize floating conversation',
  'floating.drag.label': 'Drag conversation window',
  'floating.drag.hint': 'Current position: {position}. Drag to snap, use Left or Right to switch positions, or Home and End for the corners.',
  'floating.dock.left': 'Bottom left',
  'floating.dock.center': 'Bottom center',
  'floating.dock.right': 'Bottom right',
} satisfies Record<LayoutKey, string>
