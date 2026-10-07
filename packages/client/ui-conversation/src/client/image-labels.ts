/** 对话输入负责将附件拒绝原因映射为可操作的提示。 */

import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/**
 * 将字节数格式化为面向用户的 MB 数值（`10MB`、`2.5MB`）。
 * @param bytes - 字节数。
 * @returns 四舍五入后的 MB 文本。
 */
export function imageSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}

/**
 * 将 Host 的 `attachment-error` 原因映射为用户提示。源文件与归一化结果复用
 * 字节超限原因码，因此该两项不展示可能错误的具体限额；未知原因保留原因码。
 * @param t - 对话命名空间翻译器。
 * @param reason - wire `details.reason` 原因码。
 * @param limits - 已投影的数量和尺寸限制；缺席时回退为带原因码的提示。
 * @returns 可显示的错误提示。
 */
export function attachmentErrorText(
  t: Translate<ConversationKey>,
  reason: string,
  limits?: ImageAttachmentLimits,
): string {
  switch (reason) {
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES': return t('image.modelUnsupported')
    case 'SUBAGENT_IMAGE_UNSUPPORTED': return t('image.subagentUnsupported')
    case 'IMAGE_TOO_MANY_PIXELS': return t('image.tooManyPixels')
    case 'IMAGE_DIMENSION_TOO_LARGE':
      if (limits !== undefined) return t('image.dimensionTooLarge', { size: limits.maxImageDimension })
      break
    // 解码失败提示重新导出；声明类型与实际格式不符则提示格式要求。
    case 'INVALID_IMAGE':
      return t('image.decodeFailed')
    case 'IMAGE_TYPE_MISMATCH':
      return t('image.unsupportedType')
    case 'TOO_MANY_IMAGES':
      if (limits !== undefined) return t('image.tooMany', { count: limits.maxImagesPerMessage })
      break
    case 'IMAGE_TOO_LARGE': return t('image.hostImageTooLarge')
    case 'IMAGES_TOO_LARGE': return t('image.hostImagesTooLarge')
    default: break
  }
  return t('image.sendFailed', { reason })
}
