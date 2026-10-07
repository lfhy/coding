/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentError } from './error.ts'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId } from './brand.ts'
export { AttachmentError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedImages } from './admission.ts'
export type {
  AttachmentId as AttachmentIdType,
  EncodedImageAttachment,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * 为批次准备待提交字节；默认实现保持原始字节，允许提供方在提交前归一化。
   * @param input - 原始编码输入。
   * @param maxBytes - 可选的更严格编码字节预算。
   * @returns 通过校验且可用于计算最终字节总额的输入。
   */
  protected async prepareImage(input: SaveImageAttachment, _maxBytes?: number): Promise<SaveImageAttachment> {
    await this.validateImage(input)
    return input
  }

  /**
   * 提交已通过批次校验的字节；默认实现沿用单张保存方法。
   * @param input - 已准备的输入。
   * @returns 持久附件引用。
   */
  protected savePreparedImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return this.saveImage(input)
  }

  /**
   * 按顺序提交批次前，先校验并归一化所有成员。最终总额超限时，
   * 保留已合规的小图，并对其余成员按确定的均分预算重新处理。
   * 准入失败不会写入；存储失败不返回部分引用，但已经发布的不可变对象可能保留到后续回收。
   * @param inputs - 按消息顺序排列的原始编码图片。
   * @returns 与输入顺序一致的持久引用。
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    const {
      maxImagesPerMessage, maxMessageImageBytes, maxSourceMessageImageBytes,
      maxSourceImageBytes, maxImageBytes, mediaTypes,
    } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const sourceBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (sourceBytes > (maxSourceMessageImageBytes ?? maxMessageImageBytes)) {
      throw new AttachmentError('Image batch exceeds the configured source-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (input.data.byteLength > (maxSourceImageBytes ?? maxImageBytes)) {
        throw new AttachmentError('Image exceeds the configured source-byte limit.', 'IMAGE_TOO_LARGE')
      }
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
    const prepared: SaveImageAttachment[] = []
    for (const input of inputs) prepared.push(await this.prepareImage(input))
    let totalBytes = prepared.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      let remaining = maxMessageImageBytes
      const pending = new Set(prepared.map((_, index) => index))
      while (pending.size > 0) {
        const budget = Math.floor(remaining / pending.size)
        if (budget < 1) {
          throw new AttachmentError('Image batch cannot fit the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
        }
        let kept = false
        for (const [index, image] of prepared.entries()) {
          if (!pending.has(index)) continue
          const bytes = image.data.byteLength
          if (bytes > budget) continue
          remaining -= bytes
          pending.delete(index)
          kept = true
        }
        if (kept) continue
        for (const [index, input] of inputs.entries()) {
          if (pending.has(index)) prepared[index] = await this.prepareImage(input, budget)
        }
        break
      }
      totalBytes = prepared.reduce((sum, input) => sum + input.data.byteLength, 0)
    }
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }

    const refs: ImageAttachmentRef[] = []
    for (const input of prepared) refs.push(await this.savePreparedImage(input))
    return refs
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

export default AttachmentStore
