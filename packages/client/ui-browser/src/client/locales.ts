/** 浏览器画面区词典。 */
export const NS = 'browser-mirror'

export const zh = {
  'label': '浏览器画面',
  'empty': '此会话尚未打开浏览器',
  'loading': '正在读取浏览器状态…',
  'error': '无法读取浏览器画面',
  'retry': '重试',
  'close': '返回文件视图',
  'frame': '浏览器页面截图',
  'noFrame': '页面画面尚不可用',
  'snapshot': '页面文本快照',
  'click': '点击',
  'fill': '填写',
  'scroll': '滚动',
  'ready': '页面已更新',
} as const

export type BrowserMirrorKey = keyof typeof zh

export const en: Record<BrowserMirrorKey, string> = {
  'label': 'Browser view',
  'empty': 'No browser is open for this session',
  'loading': 'Loading browser state…',
  'error': 'Browser view is unavailable',
  'retry': 'Retry',
  'close': 'Return to files',
  'frame': 'Browser page screenshot',
  'noFrame': 'Page image is not available yet',
  'snapshot': 'Page text snapshot',
  'click': 'Click',
  'fill': 'Fill',
  'scroll': 'Scroll',
  'ready': 'Page updated',
}
