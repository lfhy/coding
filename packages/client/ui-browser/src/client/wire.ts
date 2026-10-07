/** Host 状态跨网络边界的严格校验。 */
import type { BrowserOperationOnlyState, BrowserSessionState, BrowserTabId } from '@deepseek-ai/dsh-browser/types'
export type BrowserState = BrowserSessionState
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器观测格式无效')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
/** Provider 的页面文本包含换行与表格制表符；其他控制字符不进入观测。 */
function snapshotText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 12000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function pageUrl(value: string): boolean {
  if (value === 'about:blank') return true
  if (/\s/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      && url.username === '' && url.password === ''
  } catch { return false }
}
function tabId(value: unknown): value is BrowserTabId {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
/**
 * 检验状态及活跃标签的画面关联。
 * @param value - 未信任的 Host JSON。
 * @returns 校验后的状态。
 */
export function parseBrowserState(value: unknown): BrowserState {
  const data = object(value)
  const browserViewport = object(data.viewport)
  if (!text(data.browserGeneration, 128) || !/^[a-zA-Z0-9._~-]+$/.test(data.browserGeneration)
    || typeof data.operationActive !== 'boolean'
    || !integer(data.stateRevision, 0) || !Array.isArray(data.tabs) || data.tabs.length > 100
    || !integer(browserViewport.width, 200, 1920) || !integer(browserViewport.height, 240, 1400)
    || browserViewport.width * browserViewport.height > 1_800_000
    || !(data.activeTabId === null || tabId(data.activeTabId)) || typeof data.hasFrame !== 'boolean') {
    throw new Error('浏览器状态字段无效')
  }
  const ids = new Set<string>()
  const tabs = data.tabs.map((value) => {
    const tab = object(value)
    if (!tabId(tab.id) || ids.has(tab.id) || !text(tab.generation, 128)
      || !/^[a-zA-Z0-9._~-]+$/.test(tab.generation) || !text(tab.url, 4096) || !pageUrl(tab.url)
      || !text(tab.title, 4096) || typeof tab.canGoBack !== 'boolean' || typeof tab.canGoForward !== 'boolean'
      || (tab.loading !== undefined && typeof tab.loading !== 'boolean')) {
      throw new Error('浏览器标签字段无效')
    }
    ids.add(tab.id)
    return { id: tab.id, generation: tab.generation, url: tab.url, title: tab.title,
      canGoBack: tab.canGoBack, canGoForward: tab.canGoForward,
      ...(tab.loading === undefined ? {} : { loading: tab.loading }) }
  })
  if ((tabs.length === 0) !== (data.activeTabId === null) || (data.activeTabId !== null && !ids.has(data.activeTabId))) {
    throw new Error('浏览器活动标签无效')
  }
  let observation: BrowserState['observation'] = null
  if (data.observation !== null) {
    const row = object(data.observation)
    const viewport = object(row.viewport)
    if (!tabId(row.tabId) || row.tabId !== data.activeTabId
      || tabs.find(tab => tab.id === row.tabId)?.generation !== row.generation
      || !text(row.generation, 128) || !/^[a-zA-Z0-9._~-]+$/.test(row.generation)
      || !integer(row.revision, 0) || !text(row.url, 4096) || !pageUrl(row.url)
      || !text(row.title, 4096) || !snapshotText(row.snapshot)
      || !integer(viewport.width, 1, 8192) || !integer(viewport.height, 1, 8192)) {
      throw new Error('浏览器观测字段无效')
    }
    let cursor: NonNullable<BrowserState['observation']>['cursor'] = null
    if (row.cursor !== null) {
      const pointer = object(row.cursor)
      if (!integer(pointer.x, 0, viewport.width) || !integer(pointer.y, 0, viewport.height)
        || (pointer.kind !== 'click' && pointer.kind !== 'fill' && pointer.kind !== 'scroll')
        || !integer(pointer.at, 0)) throw new Error('浏览器指针坐标无效')
      cursor = { x: pointer.x, y: pointer.y, kind: pointer.kind, at: pointer.at }
    }
    observation = {
      tabId: row.tabId, generation: row.generation, revision: row.revision,
      url: row.url, title: row.title, snapshot: row.snapshot,
      viewport: { width: viewport.width, height: viewport.height }, cursor,
    }
  }
  if (data.hasFrame && observation === null) throw new Error('浏览器画面缺少观测')
  return { browserGeneration: data.browserGeneration, stateRevision: data.stateRevision,
    viewport: { width: browserViewport.width, height: browserViewport.height },
    tabs, activeTabId: data.activeTabId, observation, hasFrame: data.hasFrame,
    operationActive: data.operationActive }
}
/** 无浏览器资源时仅接受 Host 明确公布的审批锁，不把畸形状态当作空白页。 */
export function parseBrowserStateOrLock(value: unknown): BrowserState | BrowserOperationOnlyState {
  const data = object(value)
  if (!('browserGeneration' in data)) {
    if (Object.keys(data).length === 1 && data.operationActive === true) return { operationActive: true }
    throw new Error('浏览器操作状态无效')
  }
  return parseBrowserState(data)
}
/**
 * 地址栏支持带协议网址和域名，拒绝凭据与非 HTTP(S) 输入。
 * @param draft - 输入草稿。
 * @returns 标准化绝对 URL。
 */
export function normalizeBrowserUrl(draft: string): string {
  if (/[\u0000-\u001f\u007f]/.test(draft)) throw new Error('请输入有效的 HTTP(S) 网址')
  const value = draft.trim()
  if (!value || value.length > 2048 || /\s/.test(value)) throw new Error('请输入有效的 HTTP(S) 网址')
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`
  try {
    const url = new URL(candidate)
    if (!pageUrl(url.href) || (!url.hostname.includes('.') && url.hostname !== 'localhost')) throw new Error('invalid')
    return url.href
  } catch { throw new Error('请输入有效的 HTTP(S) 网址') }
}
