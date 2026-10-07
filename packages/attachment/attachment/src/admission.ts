/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type { EncodedImageAttachment, ImageAttachmentRef, SaveImageAttachment } from './types.ts'

/** 标记非规范数据在原始批次中的位置，供协议入口精准诊断。 */
class EncodedImageError extends AttachmentError {
  constructor(readonly imageIndex: number) {
    super('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
}

/** 返回 RFC 4648 字符值，非字母表字符返回 -1。 */
function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 97 + 26
  if (code >= 48 && code <= 57) return code - 48 + 52
  if (code === 43) return 62
  if (code === 47) return 63
  return -1
}

/** 在扫描字符前拒绝超过源字节限额的编码长度。 */
function encodedByteLength(data: string, index: number, maxBytes: number): number {
  if (typeof data !== 'string') throw new EncodedImageError(index)
  if (data.length === 0 || data.length % 4 !== 0) throw new EncodedImageError(index)
  if (data.length > Math.ceil(maxBytes / 3) * 4) {
    throw new AttachmentError('Image exceeds the configured source-byte limit.', 'IMAGE_TOO_LARGE')
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const bytes = data.length / 4 * 3 - padding
  if (bytes > maxBytes) {
    throw new AttachmentError('Image exceeds the configured source-byte limit.', 'IMAGE_TOO_LARGE')
  }
  return bytes
}

/** 逐字符校验字母表、末尾填充和填充位，不使用会对大输入耗尽栈的正则。 */
function assertCanonicalBase64(data: string, index: number): void {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const unpaddedLength = data.length - padding
  for (let offset = 0; offset < unpaddedLength; offset++) {
    if (base64Value(data.charCodeAt(offset)) < 0) throw new EncodedImageError(index)
  }
  const lastValue = base64Value(data.charCodeAt(unpaddedLength - 1))
  if ((padding === 2 && (lastValue & 15) !== 0) || (padding === 1 && (lastValue & 3) !== 0)) {
    throw new EncodedImageError(index)
  }
}

/** 将通过源限额检查的上传数据解码为存储输入。 */
function saveInput(image: EncodedImageAttachment, index: number): SaveImageAttachment {
  const decoded = Buffer.from(image.data, 'base64')
  if (decoded.toString('base64') !== image.data) {
    throw new EncodedImageError(index)
  }
  return {
    data: decoded,
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * 在分配解码字节前按部署限额预检整批源数据，再由附件存储归一化并有序提交。
 * @param attachments - 拥有源数据与最终字节策略的附件存储。
 * @param images - 按消息顺序排列的 base64 图片。
 * @returns 与输入顺序一致的持久引用。
 * @throws AttachmentError 图片格式、限额或存储准入失败时拒绝整个批次。
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  const limits = attachments.imageLimits
  if (images.length > limits.maxImagesPerMessage) {
    throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
  }
  let sourceBytes = 0
  const maxSourceImageBytes = limits.maxSourceImageBytes ?? limits.maxImageBytes
  for (const [index, image] of images.entries()) {
    if (!limits.mediaTypes.includes(image.mediaType)) {
      throw new AttachmentError(`Image type ${image.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
    }
    sourceBytes += encodedByteLength(image.data, index, maxSourceImageBytes)
    if (sourceBytes > (limits.maxSourceMessageImageBytes ?? limits.maxMessageImageBytes)) {
      throw new AttachmentError('Image batch exceeds the configured source-byte limit.', 'IMAGES_TOO_LARGE')
    }
  }
  for (const [index, image] of images.entries()) assertCanonicalBase64(image.data, index)
  return attachments.saveImages(images.map(saveInput))
}
