/** 不依赖图片编解码器的尺寸与编码字节预算策略。 */

/** 编码图片的逻辑画布尺寸。 */
export interface ImageDimensions {
  width: number
  height: number
}

/** 图片归一化后的尺寸与字节上限。 */
export interface ImageFitLimits {
  maxBytes: number
  maxPixels?: number
  maxDimension?: number
}

/** 图片提供方持有格式、动画与透明度语义，仅向策略暴露编码能力。 */
export interface ImageFitEncoder {
  /** 有损格式允许按质量梯度重新编码；无损格式仅缩小尺寸。 */
  lossy: boolean
  /**
   * 生成目标逻辑画布和质量的原格式编码字节。
   * @param target - 目标宽高与编码质量。
   * @returns 待检查字节上限的编码图片。
   */
  encode(target: ImageDimensions & { quality: number }): Promise<Uint8Array>
}

/** 超出可达到的编码字节预算，或传入无效尺寸、限额时抛出。 */
export class ImageFitError extends Error {
  /** 稳定的预算失败码，供各编解码提供方映射。 */
  readonly code = 'IMAGE_TOO_LARGE' as const

  /** @param message - 无效限额或无法压缩到目标字节数的诊断。 */
  constructor(message: string) {
    super(message)
    this.name = 'ImageFitError'
  }
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

/**
 * 返回满足限额的图片字节；原字节合规时不调用编码器且保持对象恒等。
 * 编码器负责验证输出尺寸及原格式、动画、透明度等格式语义。
 * @param input - 完整源图片字节。
 * @param dimensions - 源图片按显示方向计算的逻辑画布尺寸。
 * @param limits - 最终对象的编码字节和可选尺寸限额。
 * @param encoder - 按目标画布与质量输出图片的编解码器适配器。
 * @returns 已满足字节预算的源对象或重新编码字节。
 * @throws ImageFitError 当尺寸或限额无效，或有限次重编码后仍无法满足字节上限。
 */
export async function fitImage(
  input: Uint8Array,
  dimensions: ImageDimensions,
  limits: ImageFitLimits,
  encoder: ImageFitEncoder,
): Promise<Uint8Array> {
  const { width, height } = dimensions
  if (!validPositiveInteger(width) || !validPositiveInteger(height) || !Number.isSafeInteger(width * height)
    || !validPositiveInteger(limits.maxBytes)
    || (limits.maxPixels !== undefined && !validPositiveInteger(limits.maxPixels))
    || (limits.maxDimension !== undefined && !validPositiveInteger(limits.maxDimension))) {
    throw new ImageFitError('Image dimensions or output limits are invalid.')
  }
  const maxSide = Math.max(width, height)
  if (input.byteLength <= limits.maxBytes
    && (limits.maxDimension === undefined || maxSide <= limits.maxDimension)
    && (limits.maxPixels === undefined || width * height <= limits.maxPixels)) return input

  const scale = Math.min(
    1,
    limits.maxDimension === undefined ? 1 : limits.maxDimension / maxSide,
    limits.maxPixels === undefined ? 1 : Math.sqrt(limits.maxPixels / (width * height)),
  )
  let targetWidth = Math.max(1, Math.floor(width * scale))
  let targetHeight = Math.max(1, Math.floor(height * scale))
  const qualityLevels = encoder.lossy ? 5 : 1
  for (let attempt = 0; attempt < 40; attempt++) {
    const quality = encoder.lossy ? Math.max(25, 85 - Math.min(attempt, 4) * 15) : 100
    const encoded = await encoder.encode({ width: targetWidth, height: targetHeight, quality })
    if (encoded.byteLength <= limits.maxBytes) return encoded
    if (attempt < qualityLevels - 1) continue
    if (targetWidth === 1 && targetHeight === 1) break
    const factor = attempt < 12 ? 0.8 : 0.5
    targetWidth = Math.max(1, Math.floor(targetWidth * factor))
    targetHeight = Math.max(1, Math.floor(targetHeight * factor))
  }
  throw new ImageFitError('Image cannot fit the configured encoded-byte limit.')
}
