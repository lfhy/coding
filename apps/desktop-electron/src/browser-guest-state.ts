/** Electron guest 的会话状态、输入约束与标签页摘要；仅供桌面壳内部模块共享。 */

import type { WebContentsView } from 'electron'
import type { BrowserCapture, BrowserTabId, BrowserTabSummary, BrowserUseErrorCode } from 'coding-browser'

/** 新建 guest 会话使用的默认视口。 */
export const INITIAL_VIEWPORT = { width: 1280, height: 720 }
/** 单个 Electron guest 管理器允许同时持有的会话数。 */
export const MAX_SESSIONS = 8
/** 单个会话允许创建的标签页数。 */
export const MAX_TABS = 8
/** 单帧 PNG 在进入浏览器工具附件链路前允许的最大字节数。 */
export const FRAME_LIMIT = 2 * 1024 * 1024
/** 浏览器地址在状态和观测中的最大长度。 */
export const MAX_URL_LENGTH = 4096
/** 页面地址过长时对外展示的固定摘要地址。 */
export const OVERLONG_URL = 'about:blank#browser-url-exceeds-limit'

/** 引用复核失败原因到模型可读诊断片段的映射。 */
export const STALE_TARGET_REASONS: Record<string, string> = {
  element_left_document: 'left the document',
  element_form_changed: 'changed its form',
  ancestors_changed: 'changed its ancestor chain',
  element_changed: 'changed since the snapshot',
  element_not_editable: 'is not editable',
  element_hidden: 'is hidden',
  element_disabled: 'is disabled or inert',
  element_offscreen: 'is outside the visible viewport',
  element_covered: 'is covered by another element',
}

/** 一个 guest 标签页及其最近一次观测的主进程状态。 */
export interface Tab {
  id: BrowserTabId
  generation: string
  view: WebContentsView
  revision: number
  capture?: BrowserCapture
  summary: BrowserTabSummary
  navigation: number
  worldContextId?: number
  syntheticInput: boolean
  domRevision?: number
  everPresented: boolean
}

/** 一个浏览器工具会话的标签页、视口、租约和版本状态。 */
export interface Owner {
  generation: string
  tabs: Map<BrowserTabId, Tab>
  active: BrowserTabId
  revision: number
  targetRevision: number
  viewport: { width: number; height: number }
  lease: boolean
  partition: string
}

/** 浏览器 guest 内部错误；code 由调用方映射为浏览器工具协议错误。 */
export class GuestError extends Error {
  /**
   * 创建带有浏览器工具错误码的内部错误。
   * @param message - 面向调用方的失败诊断。
   * @param code - 浏览器工具协议错误码。
   */
  constructor(message: string, readonly code: BrowserUseErrorCode) {
    super(message)
    this.name = 'BrowserUseError'
  }
}

/**
 * 抛出带协议错误码的 guest 错误。
 * @param message - 面向调用方的失败诊断。
 * @param code - 浏览器工具协议错误码。
 * @returns 此函数不会正常返回。
 */
export function fail(message: string, code: BrowserUseErrorCode): never {
  throw new GuestError(message, code)
}

/**
 * 校验并规范化可访问的浏览器地址；只允许无凭据的 HTTP(S) 与无 authority 的本地绝对文件 URL。
 * @param raw - 外部传入的原始地址。
 * @returns URL 构造器规范化后的地址。
 */
export function allowedUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) {
    fail('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
  }
  let url: URL
  try { url = new URL(raw) }
  catch { return fail('invalid browser URL', 'BROWSER_INVALID_URL') }
  if (url.protocol === 'file:') {
    // URL 会规范化 localhost、反斜杠与编码分隔符；文件准入必须先检查原始写法。
    if (!/^file:\/\/\/(?!\/)/i.test(raw) || url.hostname || url.username || url.password ||
      /\\|%(?:2f|5c|00)/i.test(raw)) fail('browser URL denied', 'BROWSER_DENIED')
    return url.href
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !/^https?:\/\/[^/?#\\\s]+(?:[/?#]|$)/i.test(raw) ||
    /^https?:\/\/[^/?#\\\s]*@/i.test(raw)) {
    fail('browser URL denied', 'BROWSER_DENIED')
  }
  return url.href
}

/**
 * 校验 guest 视口是否处于浏览器工具允许的尺寸和面积范围。
 * @param width - 视口宽度，单位为像素。
 * @param height - 视口高度，单位为像素。
 * @returns 输入有效时无返回值；无效输入直接抛出协议错误。
 */
export function validateViewport(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || width > 1920 ||
    height < 240 || height > 1400 || width * height > 1_800_000) {
    fail('browser viewport must be 200..1920 by 240..1400 pixels with area at most 1800000', 'BROWSER_FAILED')
  }
}

/**
 * 取得会话当前活动标签页。
 * @param owner - 要读取的浏览器会话。
 * @returns 当前活动标签页。
 */
export function active(owner: Owner): Tab {
  const tab = owner.tabs.get(owner.active)
  if (!tab) fail('active browser tab is closed', 'BROWSER_CLOSED')
  return tab
}

/**
 * 让当前标签页的观测、CDP 世界和审批目标全部失效。
 * @param owner - 所属浏览器会话。
 * @param tab - 需要撤销观测的标签页。
 * @returns 无返回值。
 */
export function invalidate(owner: Owner, tab: Tab): void {
  delete tab.capture
  delete tab.worldContextId
  delete tab.domRevision
  tab.navigation++
  owner.revision++
  owner.targetRevision++
}

/**
 * 从 Electron 当前页面刷新标签摘要，并限制标题与地址的可见长度。
 * @param tab - 要更新摘要的 guest 标签页。
 * @param title - 可选的新标题；省略时保留现有标题。
 * @returns 无返回值。
 */
export function refreshSummary(tab: Tab, title = tab.summary.title): void {
  const wc = tab.view.webContents
  const url = wc.getURL() || 'about:blank'
  tab.summary = { id: tab.id, generation: tab.generation, url: url.length <= MAX_URL_LENGTH ? url : OVERLONG_URL, title,
    canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading() }
}
