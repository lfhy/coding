/** 来自 Host 的页面目录、画面和活动事件在浏览器边界统一校验。 */

export interface EgoPage {
  readonly targetId: string
  readonly title: string
  readonly url: string
  readonly active: boolean
  readonly viewportW: number | null
  readonly viewportH: number | null
}

export interface EgoFrame {
  readonly targetId: string
  readonly src: string
  readonly width: number
  readonly height: number
  readonly ts: number
}

export interface EgoActivity {
  readonly sessionId: string
  readonly count: number
}

const ID = /^[a-zA-Z0-9._~-]{1,128}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

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
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value === 'about:blank') return true
  try {
    const url = new URL(value)
    return (['http:', 'https:', 'file:', 'chrome:'].includes(url.protocol))
      && url.username === '' && url.password === ''
  } catch { return false }
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
      || /[\u0000-\u001f\u007f]/u.test(page.title) || !safeAddress(page.url)
      || typeof page.active !== 'boolean'
      || (page.viewportW != null && !viewport(page.viewportW))
      || (page.viewportH != null && !viewport(page.viewportH))) throw new Error('invalid page')
    seen.add(page.targetId)
    return { targetId: page.targetId, title: page.title, url: page.url, active: page.active,
      viewportW: page.viewportW ?? null, viewportH: page.viewportH ?? null }
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
 * 全局活动流只能提供调用次数与会话身份，其他字段一律拒绝。
 * @param value - SSE tool-call 的 JSON 值。
 * @returns 校验后的活动；不完整数据为 null。
 */
export function parseActivity(value: unknown): EgoActivity | null {
  const event = record(value)
  if (!event || Object.keys(event).length !== 2 || !validId(event.sessionId)
    || typeof event.count !== 'number' || !Number.isSafeInteger(event.count) || event.count < 0) return null
  return { sessionId: event.sessionId, count: event.count }
}
