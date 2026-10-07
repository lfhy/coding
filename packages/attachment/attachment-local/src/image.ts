/** 图片写入时完整解码与归一化，已校验对象读取时仅探测头部。 */

import sharp, { type Metadata, type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { fitImage, ImageFitError } from '@deepseek-ai/dsh-attachment/image-processing'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** 已识别图片的逻辑画布尺寸与格式。 */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

/** 待持久化的编码数据和与其一致的元数据。 */
export interface NormalizedImage {
  data: Uint8Array
  metadata: DetectedImage
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  return { mediaType, width: metadata.width, height: metadata.pageHeight ?? metadata.height }
}

/** 解码输入时使用的上限，与可提交对象的输出上限分开设置。 */
export interface SourceImageLimits {
  maxSourceBytes: number
  maxSourcePixels: number
  maxSourceFrames: number
}

function sourceByteLimit(data: Uint8Array, limits: SourceImageLimits): void {
  if (data.byteLength > limits.maxSourceBytes) {
    throw new AttachmentError('Image exceeds the source byte safety limit.', 'IMAGE_TOO_LARGE')
  }
}

function sourceLimits(metadata: Metadata, limits: SourceImageLimits): void {
  const pages = metadata.pages ?? 1
  const height = metadata.pageHeight ?? metadata.height
  if (pages > limits.maxSourceFrames) {
    throw new AttachmentError('Image exceeds the source animation-frame safety limit.', 'IMAGE_TOO_MANY_PIXELS')
  }
  if (metadata.width * height * pages > limits.maxSourcePixels) {
    throw new AttachmentError('Image exceeds the source decoded-pixel safety limit.', 'IMAGE_TOO_MANY_PIXELS')
  }
}

function completeContainer(data: Uint8Array, mediaType: ImageMediaType): void {
  if (mediaType === 'image/gif' && data[data.byteLength - 1] !== 0x3b) {
    throw new AttachmentError('GIF image is missing its end marker.', 'INVALID_IMAGE')
  }
}

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  try {
    return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false }))
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/** 用于解码图片和最终逻辑画布的限制。 */
export interface DecodedImageLimits {
  /** 最终画布宽高像素乘积上限。 */
  maxPixels?: number
  /** 最终画布的宽度和高度各自的上限。 */
  maxDimension?: number
  /** 输入的编码字节和解码帧安全限额。 */
  source?: SourceImageLimits
}

/**
 * 完整解码支持的图片并返回逻辑画布元数据。
 * @param data - 完整编码图片。
 * @param limits - 可选的画布与输入安全限额。
 * @returns 经校验的格式与尺寸。
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  try {
    if (limits?.source !== undefined) sourceByteLimit(data, limits.source)
    const image = sharp(data, { animated: true, failOn: 'error', limitInputPixels: false })
    if (limits?.source !== undefined) sourceLimits(await image.metadata(), limits.source)
    const detected = await imageMetadata(image)
    completeContainer(data, detected.mediaType)
    if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    await image.raw().toBuffer()
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/**
 * 完整解码输入，并在超出输出限额时按原格式缩放或重编码。
 * 未超限时返回原始字节；动图保留各帧及其播放时长。
 * @param data - 完整编码图片。
 * @param limits - 模型可见对象的最终字节、像素及单边限额。
 * @returns 可写入的字节及其逻辑画布尺寸。
 */
export async function normalizeImage(
  data: Uint8Array,
  limits: DecodedImageLimits & SourceImageLimits & { maxBytes: number },
): Promise<NormalizedImage> {
  try {
    sourceByteLimit(data, limits)
    const source = sharp(data, { animated: true, failOn: 'error', limitInputPixels: false })
    const metadata = await source.metadata()
    const detected = await imageMetadata(source)
    completeContainer(data, detected.mediaType)
    sourceLimits(metadata, limits)
    await source.raw().toBuffer()
    const { width, height, mediaType } = detected
    const orientationSwapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
    const encoded = await fitImage(data, {
      width: orientationSwapsAxes ? height : width,
      height: orientationSwapsAxes ? width : height,
    }, limits, {
      lossy: mediaType === 'image/jpeg' || mediaType === 'image/webp',
      async encode({ width: targetWidth, height: targetHeight, quality }) {
        const pipeline = sharp(data, { animated: true, failOn: 'error', limitInputPixels: false })
          .autoOrient()
          .resize(targetWidth, targetHeight, { fit: 'fill', withoutEnlargement: true })
        switch (mediaType) {
          case 'image/png': return pipeline.png({ compressionLevel: 9 }).toBuffer()
          case 'image/jpeg': return pipeline.jpeg({ quality }).toBuffer()
          case 'image/webp': return pipeline.webp({ quality, effort: 6, loop: metadata.loop, delay: metadata.delay }).toBuffer()
          case 'image/gif': return pipeline.gif({
            effort: 7, loop: metadata.loop, delay: metadata.delay, keepDuplicateFrames: true,
          }).toBuffer()
        }
      },
    })
    if (encoded === data) return { data, metadata: detected }
    const output = await detectImage(encoded, {
      ...(limits.maxPixels === undefined ? {} : { maxPixels: limits.maxPixels }),
      ...(limits.maxDimension === undefined ? {} : { maxDimension: limits.maxDimension }),
      source: { ...limits, maxSourceBytes: limits.maxBytes },
    })
    const outputMetadata = await sharp(encoded, { animated: true }).metadata()
    const outputFrames = outputMetadata.pages ?? 1
    if (output.mediaType !== mediaType || outputFrames !== (metadata.pages ?? 1)) {
      throw new AttachmentError('Normalized image lost its format or animation frames.', 'INVALID_IMAGE')
    }
    if ((metadata.delay !== undefined && outputMetadata.delay?.some((delay, index) => delay !== metadata.delay?.[index]))
      || (metadata.loop !== undefined && outputMetadata.loop !== metadata.loop)) {
      throw new AttachmentError('Normalized image lost its animation timing.', 'INVALID_IMAGE')
    }
    return { data: new Uint8Array(encoded), metadata: output }
  } catch (error) {
    if (error instanceof ImageFitError) throw new AttachmentError(error.message, 'IMAGE_TOO_LARGE', { cause: error })
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
