/** Host 管理的文件记录；绝对路径不会进入浏览器响应。 */
export interface ManagedFileRecord {
  id: string
  kind: 'upload' | 'generated-image'
  name: string
  relativePath: string
  mediaType: string
  bytes: number
  createdAt: string
  sessionId?: string
  galleryId?: string
  attachmentId?: string
}

/** 分页响应。 */
export interface ManagedFilesPage {
  items: ManagedFileRecord[]
  total: number
  nextOffset?: number
}

/** 对每页响应在网络边界验证，拒绝绝对路径和不完整字段。
 * @param value - Host 返回的未可信 JSON。
 * @returns 可供设置页展示的分页记录。
 */
export function parseManagedFilesPage(value: unknown): ManagedFilesPage {
  if (!isObject(value) || !Array.isArray(value.items) || !nonnegativeInteger(value.total)
    || (value.nextOffset !== undefined && !nonnegativeInteger(value.nextOffset))) {
    throw new Error('Invalid managed files page')
  }
  const items = value.items.map((item): ManagedFileRecord => {
    if (!isObject(item) || !nonempty(item.id) || (item.kind !== 'upload' && item.kind !== 'generated-image')
      || !nonempty(item.name) || !nonempty(item.relativePath) || /^[\\/]|^[a-zA-Z]:/.test(item.relativePath)
      || item.relativePath.split(/[\\/]/).includes('..') || !nonempty(item.mediaType)
      || !nonnegativeInteger(item.bytes) || !nonempty(item.createdAt) || !Number.isFinite(Date.parse(item.createdAt))
      || !optionalString(item.sessionId) || !optionalString(item.galleryId) || !optionalString(item.attachmentId)) {
      throw new Error('Invalid managed file record')
    }
    return item as unknown as ManagedFileRecord
  })
  return { items, total: value.total, ...(value.nextOffset === undefined ? {} : { nextOffset: value.nextOffset }) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }

/** 读取 Host 管理的全局文件记录；AbortSignal 归当前挂载的分区持有。
 * @param offset - 当前页在 Host 记录快照中的偏移。
 * @param limit - 请求的最大页长。
 * @param signal - 分区卸载时取消本次读取的信号。
 * @returns 经网络边界校验的分页记录；HTTP 或格式错误会拒绝。
 */
export async function listManagedFiles(offset: number, limit: number, signal: AbortSignal): Promise<ManagedFilesPage> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  const response = await fetch(`/api/files/list?${query}`, { method: 'GET', signal })
  if (!response.ok) throw new Error(`File list request failed: ${response.status}`)
  return parseManagedFilesPage(await response.json())
}
