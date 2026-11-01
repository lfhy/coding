/** 来自 Host 的页面目录、画面、状态、历史与活动事件在浏览器边界统一校验。 */
import { actionKind, type EgoAction, type EgoActionKind } from './actions.ts'

export interface EgoPage {
  readonly targetId: string
  readonly title: string
  readonly url: string
  readonly active: boolean
  readonly viewportW: number | null
  readonly viewportH: number | null
  /** 页面是否要求人工完成验证；Host 的检测细节不进入视图。 */
  readonly humanCheck: boolean
}

export interface EgoFrame {
  readonly targetId: string
  readonly src: string
  readonly width: number
  readonly height: number
  readonly ts: number
}

export interface EgoStatus {
  readonly running: boolean
  readonly browserConnected: boolean
}

/** 视频后端的可用性与 fMP4 类型；不可用时面板回退单帧画面。 */
export interface EgoVideo {
  readonly available: boolean
  readonly mime: string | null
}

export interface EgoActivity {
  readonly sessionId: string
  readonly count: number
  readonly kind: EgoActionKind
  readonly at: number | null
}

const ID = /^[a-zA-Z0-9._~-]{1,128}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const ACTIVITY_KEYS = new Set(['count', 'sessionId', 'tool', 'at'])
const CONTROL = /[\u0000-\u001f\u007f]/u
const VIDEO_MIME = /^video\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9-]+=(?:"[^"]{0,120}"|[a-z0-9.+-]+))*$/iu

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** @returns 只允许在同源路由中使用的非空会话或页面身份。 */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function viewport(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8192
}

function safeAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || CONTROL.test(value)) return false
  if (value === 'about:blank') return true
  try {
    const url = new URL(value)
    return (['http:', 'https:', 'file:', 'chrome:'].includes(url.protocol))
      && url.username === '' && url.password === ''
  } catch { return false }
}

/**
 * 人机验证只保留布尔事实：Host 可能发送 null、布尔或带检测细节的对象。
 * @param value - spaces 项的 humanCheck 字段。
 * @returns 是否需要人工验证；形状无法解释时为 null。
 */
function humanCheck(value: unknown): boolean | null {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  const detail = record(value)
  if (detail === null) return null
  if (detail.detected === undefined) return true
  return typeof detail.detected === 'boolean' ? detail.detected : null
}

/**
 * Host 已按 Session 筛选，此处再拒绝形状异常和重复页面，防止错误帧被呈现。
 * @param value - 未信任的 JSON 数组。
 * @returns 校验后的页面列表；非法响应抛错，调用者显示可重试状态。
 */
export function parseSpaces(value: unknown): readonly EgoPage[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid page list')
  const seen = new Set<string>()
  return value.map((item) => {
    const page = record(item)
    if (!page || !validId(page.targetId) || seen.has(page.targetId)
      || typeof page.title !== 'string' || page.title.length > 4096
      || CONTROL.test(page.title) || !safeAddress(page.url)
      || typeof page.active !== 'boolean'
      || (page.viewportW != null && !viewport(page.viewportW))
      || (page.viewportH != null && !viewport(page.viewportH))) throw new Error('invalid page')
    const human = humanCheck(page.humanCheck)
    if (human === null) throw new Error('invalid page')
    seen.add(page.targetId)
    return { targetId: page.targetId, title: page.title, url: page.url, active: page.active,
      viewportW: page.viewportW ?? null, viewportH: page.viewportH ?? null, humanCheck: human }
  })
}

/**
 * 只接受受限 JPEG base64 与有效视口；既不把事件 data 解释为 URL，也不拼接 HTML。
 * @param value - SSE frame 的 JSON 值。
 * @returns 可用于 img src 的受控图像，格式错误时为 null。
 */
export function parseFrame(value: unknown): EgoFrame | null {
  const frame = record(value)
  if (!frame || !validId(frame.targetId) || typeof frame.data !== 'string'
    || frame.data.length === 0 || frame.data.length > 2_800_000 || !BASE64.test(frame.data)
    || !viewport(frame.vw) || !viewport(frame.vh)
    || typeof frame.ts !== 'number' || !Number.isSafeInteger(frame.ts) || frame.ts < 0) return null
  return { targetId: frame.targetId, src: `data:image/jpeg;base64,${frame.data}`,
    width: frame.vw, height: frame.vh, ts: frame.ts }
}

/**
 * 面板状态只取运行与连接两个布尔值；其余字段（路径、进程信息）一律忽略。
 * @param value - status 路由的 JSON 值。
 * @returns 可用于展示的状态，形状不符时为 null。
 */
export function parseStatus(value: unknown): EgoStatus | null {
  const status = record(value)
  if (!status || status.ok !== true || typeof status.running !== 'boolean'
    || typeof status.browserConnected !== 'boolean') return null
  return { running: status.running, browserConnected: status.browserConnected }
}

/**
 * 历史只接受有序的动作列表；工具名在此归入展示类别，原值不进入视图。
 * @param value - history 路由的 JSON 值。
 * @returns 已归类的动作；形状异常时抛错，由调用方保留上一份状态。
 */
export function parseActions(value: unknown): readonly EgoAction[] {
  const payload = record(value)
  if (!payload || payload.ok !== true || !Array.isArray(payload.actions)
    || payload.actions.length > 64) throw new Error('invalid browser history')
  return payload.actions.map((item) => {
    const action = record(item)
    if (!action || typeof action.tool !== 'string' || action.tool.length > 128 || CONTROL.test(action.tool)
      || typeof action.at !== 'number' || !Number.isSafeInteger(action.at) || action.at < 0) {
      throw new Error('invalid browser action')
    }
    return { kind: actionKind(action.tool), at: action.at }
  })
}

/**
 * 全局活动流只提供调用次数、工具类别与会话身份；页面、画面和其他字段一律拒绝。
 * @param value - SSE tool-call 的 JSON 值。
 * @returns 校验后的活动；不完整数据为 null。
 */
export function parseActivity(value: unknown): EgoActivity | null {
  const event = record(value)
  if (!event || Object.keys(event).some(key => !ACTIVITY_KEYS.has(key))
    || !validId(event.sessionId)
    || typeof event.count !== 'number' || !Number.isSafeInteger(event.count) || event.count < 0) return null
  if ('tool' in event && (typeof event.tool !== 'string' || event.tool.length > 128 || CONTROL.test(event.tool))) {
    return null
  }
  if ('at' in event && (typeof event.at !== 'number' || !Number.isSafeInteger(event.at) || event.at < 0)) return null
  return { sessionId: event.sessionId, count: event.count, kind: actionKind(event.tool),
    at: typeof event.at === 'number' ? event.at : null }
}

/**
 * 视频状态只取“是否可用”与可播放类型：Host 的进程、代次与编码器诊断一律不进入视图。
 * @param value - video/status 路由的 JSON 值。
 * @returns 可用于建立 MSE 的投影；形状不符或未就绪时为不可用。
 */
export function parseVideoStatus(value: unknown): EgoVideo {
  const payload = record(value)
  if (payload === null || payload.ok === false) return { available: false, mime: null }
  const capture = record(payload.capture)
  const candidate = typeof payload.mime === 'string'
    ? payload.mime
    : capture !== null && typeof capture.mime === 'string' ? capture.mime : null
  if (candidate === null) return { available: false, mime: null }
  const mime = candidate.trim()
  if (mime.length === 0 || mime.length > 200 || !VIDEO_MIME.test(mime)) return { available: false, mime: null }
  return { available: true, mime }
}
