/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { prepareImageFile, readImageFile, saveImageFile, savePreparedImageFile, validateImageFile } from './store.ts'

export { readImageFile, saveImageFile, validateImageFile } from './store.ts'
export { normalizeImage } from './image.ts'
export type { DecodedImageLimits, NormalizedImage, SourceImageLimits } from './image.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
/** 单张源图片的最大编码字节数。 */
export const DEFAULT_MAX_SOURCE_IMAGE_BYTES = 100 * 1024 * 1024
/** 单次上传的源图片编码字节总额。 */
export const DEFAULT_MAX_SOURCE_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** 单张源图片所有帧的最大解码像素总额。 */
export const DEFAULT_MAX_SOURCE_IMAGE_PIXELS = 80_000_000
/** 单张源动画允许的最大帧数。 */
export const DEFAULT_MAX_SOURCE_IMAGE_FRAMES = 100
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** 单张图片归一化后的最大像素数。 */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/**
 * 图片归一化后的默认单边上限。图片会随历史重复发送，因此持久对象必须符合
 * 已部署模型路由对多图请求的 2000px 限制。
 */
export const DEFAULT_MAX_IMAGE_DIMENSION = 2000

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** 单张归一化图片允许的最大编码字节数。 */
  maxImageBytes?: number
  /** 单张原始输入的编码字节上限。 */
  maxSourceImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** 一条消息中归一化图片的编码字节总额上限。 */
  maxMessageImageBytes?: number
  /** 单条消息的原始输入编码字节总额上限。 */
  maxSourceMessageImageBytes?: number
  /** 单张归一化图片的最大宽高像素乘积。 */
  maxImagePixels?: number
  /** 单张原始图片全部帧的解码像素总额上限。 */
  maxSourceImagePixels?: number
  /** 单张原始动画的帧数上限。 */
  maxSourceImageFrames?: number
  /** 单张归一化图片的最大宽度与高度。 */
  maxImageDimension?: number
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxSourceImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxSourceMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxSourceImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_IMAGE_PIXELS),
    maxSourceImageFrames: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_IMAGE_FRAMES),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxSourceImageBytes: config.maxSourceImageBytes ?? DEFAULT_MAX_SOURCE_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxSourceMessageImageBytes: config.maxSourceMessageImageBytes ?? DEFAULT_MAX_SOURCE_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxSourceImagePixels: config.maxSourceImagePixels ?? DEFAULT_MAX_SOURCE_IMAGE_PIXELS,
      maxSourceImageFrames: config.maxSourceImageFrames ?? DEFAULT_MAX_SOURCE_IMAGE_FRAMES,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits)
  }

  protected override prepareImage(input: SaveImageAttachment, maxBytes?: number): Promise<SaveImageAttachment> {
    return prepareImageFile(input, this.imageLimits, maxBytes)
  }

  protected override savePreparedImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return savePreparedImageFile(this.root, input, this.imageLimits)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }
}

export default LocalAttachmentStore
