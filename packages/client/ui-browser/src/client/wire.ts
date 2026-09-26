/** 只读 Host 观测；解析入口拒绝错误尺寸、截断文本与不安全页面地址。 */

export interface BrowserState {
  readonly generation: string
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly snapshot: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly cursor: {
    readonly x: number
    readonly y: number
    readonly kind: 'click' | 'fill' | 'scroll'
    readonly at: number
  } | null
  readonly hasFrame: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器观测格式无效')
  return value as Record<string, unknown>
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function safePageUrl(value: string): boolean {
  if (value === 'about:blank') return true
  if (/[\u0000-\u0020\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
  } catch { return false }
}

/**
 * 校验跨 Host JSON 边界的完整观测，保留供展示的纯数据。
 * @param value - 未信任的 JSON 响应。
 * @returns 已校验的状态；失败时抛出明确协议错误。
 */
export function parseBrowserState(value: unknown): BrowserState {
  const data = object(value)
  const viewport = object(data.viewport)
  if (!boundedText(data.generation, 128) || data.generation.length === 0 || !/^[a-zA-Z0-9._~-]+$/.test(data.generation)
    || !boundedInteger(data.revision, 0, Number.MAX_SAFE_INTEGER)
    || !boundedText(data.url, 4096) || !safePageUrl(data.url)
    || !boundedText(data.title, 4096) || !boundedText(data.snapshot, 12_000)
    || !boundedInteger(viewport.width, 1, 8192) || !boundedInteger(viewport.height, 1, 8192)
    || typeof data.hasFrame !== 'boolean') throw new Error('浏览器观测字段无效')

  let cursor: BrowserState['cursor'] = null
  if (data.cursor !== null) {
    const row = object(data.cursor)
    if (!boundedInteger(row.x, 0, viewport.width) || !boundedInteger(row.y, 0, viewport.height)
      || (row.kind !== 'click' && row.kind !== 'fill' && row.kind !== 'scroll')
      || !boundedInteger(row.at, 0, Number.MAX_SAFE_INTEGER)) throw new Error('浏览器指针坐标无效')
    cursor = { x: row.x, y: row.y, kind: row.kind, at: row.at }
  }
  return {
    generation: data.generation, revision: data.revision, url: data.url,
    title: data.title, snapshot: data.snapshot,
    viewport: { width: viewport.width, height: viewport.height }, cursor, hasFrame: data.hasFrame,
  }
}
