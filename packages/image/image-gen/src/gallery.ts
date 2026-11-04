/** 从会话日志投影图库和画布；不缓存浏览器侧状态，也不信任传入的附件引用。@module coding-image-gen/gallery */
import type { SessionEvent } from 'coding-session'
import type { CanvasImage, CanvasSnapshot, CanvasState, CanvasStroke, GalleryItem } from './types.ts'

export const CANVAS_WIDTH = 960
export const CANVAS_HEIGHT = 640
const MAX_NODES = 128
const MAX_POINTS = 10_000
const MAX_NODE_POINTS = 2_000
const COLORS = new Set(['ink'])
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/

/** 只有持久会话图像创建事件可以成为画布图片的所有权依据。 */
export function galleryItems(events: readonly SessionEvent[]): GalleryItem[] {
  return events.flatMap(event => event.type === 'image-gen/created' ? [event.data.item] : [])
}

/** 从当前会话的完整事件列表重建最后一次画布快照。 */
export function canvasSnapshot(events: readonly SessionEvent[]): CanvasSnapshot {
  const last = events.findLast(event => event.type === 'image-gen/canvas')
  return last?.type === 'image-gen/canvas'
    ? last.data
    : { revision: 0, state: { version: 1, nodes: [] } }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function keys(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
function coordinate(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}
function size(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
}

/** 拒绝无主图片、越界坐标、非白名单颜色及过大的笔画快照。 */
export function parseCanvasState(value: unknown, items: readonly GalleryItem[]): CanvasState {
  const state = record(value)
  if (state === null || !keys(state, ['version', 'nodes'], ['version', 'nodes'])
    || state.version !== 1 || !Array.isArray(state.nodes) || state.nodes.length > MAX_NODES) {
    throw new TypeError('画布状态格式无效或节点过多')
  }
  const ids = new Set<string>()
  const gallery = new Set(items.map(item => item.id))
  const nodes: (CanvasStroke | CanvasImage)[] = []
  let pointsTotal = 0
  for (const raw of state.nodes) {
    const node = record(raw)
    if (node === null || typeof node.id !== 'string' || !ID_PATTERN.test(node.id) || ids.has(node.id)) {
      throw new TypeError('画布节点标识无效或重复')
    }
    ids.add(node.id)
    if (node.type === 'image') {
      if (!keys(node, ['id', 'type', 'imageId', 'x', 'y', 'width', 'height'],
        ['id', 'type', 'imageId', 'x', 'y', 'width', 'height'])
        || typeof node.imageId !== 'string' || !gallery.has(node.imageId)
        || !coordinate(node.x, CANVAS_WIDTH) || !coordinate(node.y, CANVAS_HEIGHT)
        || !size(node.width, CANVAS_WIDTH) || !size(node.height, CANVAS_HEIGHT)
        || node.x + node.width > CANVAS_WIDTH || node.y + node.height > CANVAS_HEIGHT) {
        throw new TypeError('画布图片必须引用同会话图库且位于画布内')
      }
      nodes.push(node as unknown as CanvasImage)
      continue
    }
    if (node.type === 'stroke') {
      if (!keys(node, ['id', 'type', 'points', 'width', 'color', 'erase'], ['id', 'type', 'points', 'width', 'color'])
        || !Array.isArray(node.points) || node.points.length < 1 || node.points.length > MAX_NODE_POINTS
        || !size(node.width, 64) || typeof node.color !== 'string' || !COLORS.has(node.color)
        || (node.erase !== undefined && typeof node.erase !== 'boolean')
        || !node.points.every((point) => {
          const entry = record(point)
          return entry !== null && keys(entry, ['x', 'y'], ['x', 'y'])
            && coordinate(entry.x, CANVAS_WIDTH) && coordinate(entry.y, CANVAS_HEIGHT)
        })) throw new TypeError('画布笔画格式无效或超出范围')
      pointsTotal += node.points.length
      if (pointsTotal > MAX_POINTS) throw new TypeError('画布总笔画点数过多')
      nodes.push(node as unknown as CanvasStroke)
      continue
    }
    throw new TypeError('画布节点类型无效')
  }
  return { version: 1, nodes }
}

/** 客户端持有的旧 revision 不允许覆盖新状态。 */
export class CanvasConflictError extends Error {}
