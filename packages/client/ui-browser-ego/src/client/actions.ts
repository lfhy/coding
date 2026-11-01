/** 工具动作归类与相对时间：界面只出现动作类别，永不出现原始工具名。 */
import type { BrowserEgoKey } from './locales.ts'

/** 面板展示的动作类别；工具名只映射到这些类别，未知名称一律归入 other。 */
export type EgoActionKind =
  | 'navigate' | 'click' | 'type' | 'key' | 'element' | 'scroll'
  | 'tabs' | 'openTab' | 'closeTab' | 'read' | 'screenshot' | 'wait'
  | 'human' | 'dialog' | 'upload' | 'download' | 'network' | 'session'
  | 'script' | 'status' | 'verify' | 'settings' | 'other'

/** 面板最多保留并展示的最近动作条数。 */
export const MAX_ACTIONS = 8

/** 一条已归类的动作；Host 原始工具名在进入视图前即被丢弃。 */
export interface EgoAction {
  readonly kind: EgoActionKind
  readonly at: number
}

const KINDS: Readonly<Record<string, EgoActionKind>> = {
  navigate: 'navigate', open: 'navigate',
  click: 'click',
  fill: 'type', type: 'type', insert_text: 'type',
  key: 'key',
  hover: 'element', select: 'element', check: 'element', drag: 'element',
  scroll: 'scroll',
  tabs: 'tabs',
  space_open: 'openTab', new_tab: 'openTab',
  space_close: 'closeTab',
  snapshot: 'read', page_info: 'read', read_element: 'read',
  screenshot: 'screenshot',
  wait: 'wait', wait_for_selector: 'wait', wait_for_url: 'wait', wait_for_response: 'wait',
  wait_for_human: 'human',
  dialog: 'dialog',
  upload: 'upload', download: 'download',
  http: 'network', fetch: 'network',
  auth_flush: 'session', login_import: 'session',
  js: 'script', cdp: 'script', script: 'script', cli: 'script',
  status: 'status',
  captcha: 'verify',
  browser_settings: 'settings', doctor: 'settings', help: 'settings',
}

const LABELS: Readonly<Record<EgoActionKind, BrowserEgoKey>> = {
  navigate: 'actionNavigate', click: 'actionClick', type: 'actionType', key: 'actionKey',
  element: 'actionElement', scroll: 'actionScroll', tabs: 'actionTabs', openTab: 'actionOpenTab',
  closeTab: 'actionCloseTab', read: 'actionRead', screenshot: 'actionScreenshot', wait: 'actionWait',
  human: 'actionHuman', dialog: 'actionDialog', upload: 'actionUpload', download: 'actionDownload',
  network: 'actionNetwork', session: 'actionSession', script: 'actionScript', status: 'actionStatus',
  verify: 'actionVerify', settings: 'actionSettings', other: 'actionOther',
}

const PREFIX = /^(?:browser|ego)[_-]/u

/**
 * 工具名只用于归类，不进入界面数据；Host 曾用 ego_ 与 browser_ 两种前缀，均先剥离。
 * @param tool - Host 报告的工具名，可能为空、带前缀或未知。
 * @returns 封闭集合中的动作类别。
 */
export function actionKind(tool: unknown): EgoActionKind {
  if (typeof tool !== 'string') return 'other'
  return KINDS[tool.trim().toLowerCase().replace(PREFIX, '')] ?? 'other'
}

/** @returns 动作类别对应的词典键；组件只经此键取中文或英文文案。 */
export function actionLabelKey(kind: EgoActionKind): BrowserEgoKey {
  return LABELS[kind]
}

/** 相对时间文案：一分钟内按秒显示，超过一小时按小时显示。 */
export type ActionTime =
  | { readonly key: 'timeNow' }
  | { readonly key: 'timeSeconds' | 'timeMinutes' | 'timeHours'; readonly count: number }

/**
 * Host 时间与本地时钟可能有偏差；未来时间按“刚刚”处理，不显示负数。
 * @param at - 动作发生的毫秒时间戳。
 * @param now - 当前毫秒时间戳。
 * @returns 相对时间词典键与计数。
 */
export function relativeTime(at: number, now: number): ActionTime {
  const seconds = Math.floor(Math.max(0, now - at) / 1000)
  if (!Number.isFinite(seconds) || seconds < 5) return { key: 'timeNow' }
  if (seconds < 60) return { key: 'timeSeconds', count: seconds }
  if (seconds < 3600) return { key: 'timeMinutes', count: Math.floor(seconds / 60) }
  return { key: 'timeHours', count: Math.floor(seconds / 3600) }
}

/**
 * 历史接口与实时活动可能报告同一次调用；同一毫秒同一类别只保留一条。
 * @param actions - 已按时间排列的最近动作。
 * @param action - 新到达的动作。
 * @returns 不超过 MAX_ACTIONS 的新列表。
 */
export function appendAction(actions: readonly EgoAction[], action: EgoAction): readonly EgoAction[] {
  const last = actions[actions.length - 1]
  if (last !== undefined && last.at === action.at && last.kind === action.kind) return actions
  return [...actions, action].slice(-MAX_ACTIONS)
}

/** @returns 最新的在前，最多 MAX_ACTIONS 条。 */
export function recentActions(actions: readonly EgoAction[]): readonly EgoAction[] {
  return actions.slice(-MAX_ACTIONS).reverse()
}
