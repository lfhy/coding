/** Agent 浏览器标签中的用户文案。 */
export const NS = 'browser-ego'

export const zh = {
  title: 'Agent 浏览器',
  loading: '正在读取页面…',
  empty: '还没有打开的页面',
  unavailable: '暂时无法显示页面，请重试',
  refresh: '刷新页面列表',
  preview: '当前页面画面',
  noFrame: '页面画面暂不可用',
  page: '新标签页',
  tabs: '浏览器页面',
  typeLabel: '发送到页面的文字',
  typePlaceholder: '先点击页面，再输入文字',
  send: '插入文字',
  inputFailed: '操作未完成，请刷新页面列表后重试',
  relayOff: '画面暂不可用，请在设置中启用实时画面',
} as const

export type BrowserEgoKey = keyof typeof zh

export const en: Record<BrowserEgoKey, string> = {
  title: 'Agent Browser',
  loading: 'Loading pages…',
  empty: 'No pages are open yet',
  unavailable: 'Pages are unavailable. Please try again.',
  refresh: 'Refresh pages',
  preview: 'Current page view',
  noFrame: 'Page view is not available yet',
  page: 'New tab',
  tabs: 'Browser pages',
  typeLabel: 'Text to send to page',
  typePlaceholder: 'Click the page, then type',
  send: 'Insert text',
  inputFailed: 'That action did not finish. Refresh pages and try again.',
  relayOff: 'Live view is unavailable. Enable it in settings.',
}
