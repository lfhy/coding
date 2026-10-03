/** 浏览器图片预处理：只缩小超出宿主像素限制的图片，不改变宿主的接纳规则。 */

import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

export class ImagePreparationError extends Error {
  constructor(readonly reason: 'decode' | 'encode' | 'gif') {
    super(reason)
    this.name = 'ImagePreparationError'
  }
}

function targetSize(width: number, height: number, limits: ImageAttachmentLimits): { width: number; height: number } {
  const ratio = Math.min(1, limits.maxImageDimension / Math.max(width, height),
    Math.sqrt(limits.maxImagePixels / (width * height)))
  let targetWidth = Math.max(1, Math.floor(width * ratio))
  let targetHeight = Math.max(1, Math.floor(height * ratio))
  while (targetWidth * targetHeight > limits.maxImagePixels || Math.max(targetWidth, targetHeight) > limits.maxImageDimension) {
    if (targetWidth >= targetHeight && targetWidth > 1) targetWidth--
    else targetHeight--
  }
  return { width: targetWidth, height: targetHeight }
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null || blob.type !== type) reject(new ImagePreparationError('encode'))
      else resolve(blob)
    }, type, quality)
  })
}

/**
 * 解码每张图片并按宿主的边长与总像素限制缩小；保留原文件格式及透明度。
 * GIF 不经 Canvas 重编码，以免静默丢失动画；超限 GIF 必须由用户另行缩小。
 * @param file - 用户粘贴或拖入的原始文件。
 * @param limits - 宿主投影的接纳限制。
 * @returns 原文件或同名同类型的缩小文件；字节限额仍由调用方检查。
 */
export async function prepareImage(file: File, limits: ImageAttachmentLimits): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
    if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height)
      || bitmap.width < 1 || bitmap.height < 1) throw new Error('invalid dimensions')
  } catch {
    throw new ImagePreparationError('decode')
  }
  try {
    const size = targetSize(bitmap.width, bitmap.height, limits)
    const resize = size.width !== bitmap.width || size.height !== bitmap.height
    if (file.type === 'image/gif') {
      if (resize) throw new ImagePreparationError('gif')
      return file
    }
    if (!resize) return file
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (context === null) throw new ImagePreparationError('encode')
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    const first = await encode(canvas, file.type, file.type === 'image/png' ? undefined : 0.85)
    let best = first
    if (first.size > limits.maxImageBytes && file.type !== 'image/png') {
      for (const quality of [0.7, 0.5]) {
        const candidate = await encode(canvas, file.type, quality)
        if (candidate.size < best.size) best = candidate
        if (candidate.size <= limits.maxImageBytes) break
      }
    }
    return new File([best], file.name, { type: file.type, lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
