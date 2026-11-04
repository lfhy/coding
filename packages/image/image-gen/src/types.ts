/** 图像图库与画布的会话日志载荷；不包含图片二进制与提供方地址。@module coding-image-gen/types */
import type { ImageAttachmentRef } from 'coding-attachment/types'

/** 图库项的持久标识为会话日志 seq，同一会话内不可重复。 */
export interface GalleryItem extends ImageAttachmentRef {
  id: string
  prompt: string
  model: string
  createdAt: number
  sourceImageId?: string
}

/** 960×640 画布中的一条绘制笔画。 */
export interface CanvasStroke {
  id: string
  type: 'stroke'
  points: { x: number; y: number }[]
  width: number
  color: string
  erase?: boolean
}

/** 画布中引用同会话图库图片的节点。 */
export interface CanvasImage {
  id: string
  type: 'image'
  imageId: string
  x: number
  y: number
  width: number
  height: number
}

/** 每次写入完整画布快照；revision 对应会话日志中的单调修订。 */
export interface CanvasState { version: 1; nodes: (CanvasStroke | CanvasImage)[] }

export interface CanvasSnapshot { revision: number; state: CanvasState }

declare module 'coding-session/types' {
  interface SessionEventMap {
    /** 图片必须先由附件服务提交，再追加元数据；该事件不进入模型历史。 */
    'image-gen/created': { item: GalleryItem }
    /** CAS 校验后一次追加完整快照；该事件不进入模型历史。 */
    'image-gen/canvas': CanvasSnapshot
  }
}
