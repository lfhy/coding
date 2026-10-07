import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

/**
 * 客户端仅检查原始字节安全额度；尺寸、帧和输出字节由 Host 归一化。
 * @param limits - 宿主发布的图片接纳限制；旧提供方可以省略源字节额度。
 * @returns 单张和单消息的原始编码字节限额。
 */
export function imageSourceByteLimits(limits: ImageAttachmentLimits): { file: number; message: number } {
  return {
    file: limits.maxSourceImageBytes ?? limits.maxImageBytes,
    message: limits.maxSourceMessageImageBytes ?? limits.maxMessageImageBytes,
  }
}
