/** 会话级图像请求与画布文档；跨 HTTP 边界仅接收明确字段。 */

/** 一张已保存图片的只读目录项，图片字节经同会话地址获取。 */
export interface GalleryItem {
  id: string
  attachmentId: string
  prompt: string
  model: string
  createdAt: number
  mediaType: string
  width: number
  height: number
  sourceImageId?: string
  size?: string
  quality?: string
}

/** 顺序叠加的画笔或橡皮轨迹。 */
export interface StrokeNode {
  id: string
  type: 'stroke'
  points: { x: number; y: number }[]
  width: number
  color: 'ink'
  erase?: boolean
}

/** 相对于固定画布尺寸的同会话图库图片。 */
export interface ImageNode {
  id: string
  type: 'image'
  imageId: string
  x: number
  y: number
  width: number
  height: number
}

/** 画布节点按数组顺序绘制；图片 ID 不是外部地址。 */
export type CanvasNode = StrokeNode | ImageNode
/** 持久画布仅保存可重放节点，不保存原图字节或浏览器数据地址。 */
export interface CanvasDocument { version: 1; nodes: CanvasNode[] }
/** 修订号由 Host 持有；写入必须带上读取时的修订号。 */
export interface CanvasSnapshot { revision: number; state: CanvasDocument }
/** 能力可见性由 Host 综合开关与当前配置投影。 */
export interface ImageState {
  enabled: boolean
  available: boolean
  model: string
  sizes?: Record<string, Record<string, string>>
  maxEditReferences?: number
}
/** 工作台选择器仅发送上游识别的 size 与可选 quality，不发送显示用的档位标签。 */
export interface ImageOutput { size?: string; quality?: string }

const BASE = '/api/image-gen'
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 所有请求都只使用同源相对地址；错误只作为程序状态，不回显给最终用户。
 * @param path - 能力路由。
 * @param init - 请求设置；读取可由组件卸载中止。
 * @returns JSON 对象；非 2xx 或无效 JSON 会拒绝。
 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, init)
  if (!response.ok) throw new Error(`image request failed: ${response.status}`)
  return response.json() as Promise<unknown>
}

/**
 * 查询当前会话的生成能力；Host 不就绪时由调用方提供可重试反馈。
 * @param sessionId - 当前会话。
 * @param signal - 取消本次读取。
 * @returns Host 的开关与可用性投影。
 */
export async function readState(sessionId: string, signal?: AbortSignal): Promise<ImageState> {
  const value = await request(`/state?${new URLSearchParams({ sessionId })}`, { signal: signal ?? null })
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean'
    || typeof value.model !== 'string') throw new Error('invalid image state')
  const sizes = value.sizes
  if (value.maxEditReferences !== undefined && (!Number.isSafeInteger(value.maxEditReferences)
    || (value.maxEditReferences as number) < 1 || (value.maxEditReferences as number) > 5)) throw new Error('invalid reference limit')
  if (sizes !== undefined && (!record(sizes) || Object.keys(sizes).length > 13
    || !Object.entries(sizes).every(([ratio, tiers]) => /^\d{1,2}:\d{1,2}$/u.test(ratio)
      && record(tiers) && Object.keys(tiers).length <= 4 && Object.values(tiers).every(size => typeof size === 'string')))) {
    throw new Error('invalid image sizes')
  }
  return { enabled: value.enabled, available: value.available, model: value.model,
    ...(sizes === undefined ? {} : { sizes: sizes as Record<string, Record<string, string>> }),
    ...(value.maxEditReferences === undefined ? {} : { maxEditReferences: value.maxEditReferences as number }) }
}

/**
 * 按会话读取图库目录；不从其他会话的页面缓存复用图片。
 * @param sessionId - 当前会话。
 * @param signal - 取消旧会话或已卸载视图的读取。
 * @returns 已校验的目录项与可用开关。
 */
export async function readGallery(sessionId: string, signal?: AbortSignal): Promise<{ enabled: boolean; items: GalleryItem[] }> {
  const value = await request(`/gallery?${new URLSearchParams({ sessionId })}`, { signal: signal ?? null })
  if (!record(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.items)) throw new Error('invalid gallery')
  const items: GalleryItem[] = value.items.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.attachmentId !== 'string'
      || typeof item.prompt !== 'string' || typeof item.model !== 'string'
      || typeof item.mediaType !== 'string' || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
      || typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width < 1
      || typeof item.height !== 'number' || !Number.isFinite(item.height) || item.height < 1
      || (item.sourceImageId !== undefined && typeof item.sourceImageId !== 'string')
      || (item.size !== undefined && typeof item.size !== 'string')
      || (item.quality !== undefined && typeof item.quality !== 'string')) throw new Error('invalid image item')
    return {
      id: item.id, attachmentId: item.attachmentId, prompt: item.prompt, model: item.model,
      createdAt: item.createdAt, mediaType: item.mediaType, width: item.width, height: item.height,
      ...(typeof item.sourceImageId === 'string' ? { sourceImageId: item.sourceImageId } : {}),
      ...(typeof item.size === 'string' ? { size: item.size } : {}),
      ...(typeof item.quality === 'string' ? { quality: item.quality } : {}),
    }
  })
  return { enabled: value.enabled, items }
}

/**
 * 图片地址仅接受 Host 生成的 id 和当前会话；浏览器不自行拼附件路径。
 * @param sessionId - 画廊所属会话。
 * @param id - 画廊项 id。
 * @returns 同源原图地址。
 */
export function imageUrl(sessionId: string, id: string): string {
  return `${BASE}/image?${new URLSearchParams({ sessionId, id })}`
}

/**
 * 从描述生成一张图片；服务端才拥有图像解码与持久化。
 * @param sessionId - 当前会话。
 * @param prompt - 用户描述。
 * @param imageId - 可选的同会话原图 id。
 * @returns 新图片目录项，随后可刷新画廊。
 */
export async function generateImage(sessionId: string, prompt: string, imageId?: string | readonly string[],
  output: ImageOutput = {}): Promise<GalleryItem> {
  const value = await request(imageId === undefined ? '/generate' : '/edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, prompt, ...(imageId === undefined ? {} : Array.isArray(imageId)
      ? { imageIds: imageId } : { imageId }), ...output }),
  })
  if (!record(value) || !record(value.item) || typeof value.item.id !== 'string') throw new Error('invalid generated item')
  return value.item as unknown as GalleryItem
}

/**
 * 从本机选择的文件导入同会话图库，交由 Host 附件服务做媒体类型和像素准入。
 * @param sessionId - 当前会话。
 * @param file - 浏览器保留的原始 File；明文不进入会话设置或模型请求。
 * @returns 持久引用对应的图库项。
 */
export async function importReference(sessionId: string, file: File): Promise<GalleryItem> {
  const response = await fetch(`${BASE}/import?${new URLSearchParams({ sessionId })}`, {
    method: 'POST', headers: { 'content-type': file.type }, body: file,
  })
  if (!response.ok) throw new Error(`reference import failed: ${response.status}`)
  const value: unknown = await response.json()
  const item = record(value) ? value.item : undefined
  if (!record(item) || typeof item.id !== 'string' || typeof item.attachmentId !== 'string'
    || typeof item.mediaType !== 'string' || typeof item.width !== 'number' || typeof item.height !== 'number') {
    throw new Error('invalid imported image')
  }
  return item as unknown as GalleryItem
}

/**
 * 读取会话画布；不允许非法节点进入渲染或写回。
 * @param sessionId - 画布所属会话。
 * @param signal - 取消过期请求。
 * @returns 带修订号的节点文档。
 */
export async function readCanvas(sessionId: string, signal?: AbortSignal): Promise<CanvasSnapshot> {
  const value = await request(`/canvas?${new URLSearchParams({ sessionId })}`, { signal: signal ?? null })
  if (!isCanvasSnapshot(value)) throw new Error('invalid canvas')
  return value
}

/**
 * 提交会话画布并比较修订号；409 由调用方以冲突状态处理，不作自动覆盖。
 * @param sessionId - 画布所属会话。
 * @param snapshot - 本次变更的基础修订号和节点。
 * @returns 服务端接受的修订号与文档。
 */
export async function writeCanvas(sessionId: string, snapshot: CanvasSnapshot): Promise<CanvasSnapshot> {
  const value = await request(`/canvas?${new URLSearchParams({ sessionId })}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
  })
  if (!isCanvasSnapshot(value)) throw new Error('invalid canvas')
  return value
}

/** 仅持有当前画布渲染所需的、受限且有限的结构。 */
function isCanvasSnapshot(value: unknown): value is CanvasSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !record(value.state)
    || value.state.version !== 1 || !Array.isArray(value.state.nodes) || value.state.nodes.length > 128) return false
  return value.state.nodes.every((node: unknown) => {
    if (!record(node) || typeof node.id !== 'string') return false
    if (node.type === 'image') {
      const { x, y, width, height } = node
      return typeof node.imageId === 'string'
        && typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
        && typeof width === 'number' && Number.isFinite(width)
        && typeof height === 'number' && Number.isFinite(height)
        && x >= 0 && y >= 0 && width > 0 && height > 0
        && x + width <= 960 && y + height <= 640
    }
    return node.type === 'stroke' && node.color === 'ink' && (node.erase === undefined || typeof node.erase === 'boolean')
      && typeof node.width === 'number' && Number.isFinite(node.width) && Array.isArray(node.points)
      && node.points.length <= 2000 && node.points.every((point: unknown) => record(point)
        && typeof point.x === 'number' && Number.isFinite(point.x)
        && typeof point.y === 'number' && Number.isFinite(point.y))
  })
}
