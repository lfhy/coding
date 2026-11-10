/** 兼容图像接口的比例与分辨率表，沿用上游工作台的默认尺寸与档位顺序。 */

/** 未配置专用尺寸表时，使用原版 OpenAI 兼容渠道的保守档位。 */
export const DEFAULT_OUTPUT_SIZES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1:1': { '1K': '1024x1024' },
  '2:3': { '1K': '1024x1536' },
  '3:2': { '1K': '1536x1024' },
}

const RATIO_ORDER = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9', '1:3', '3:1']

/** 自定义表仅接受有界比例、档位和明确像素尺寸，避免无效设置落到上游请求。 */
export function validateOutputSizes(sizes: Record<string, Record<string, string>>): void {
  if (Object.keys(sizes).length > 13) throw new TypeError('图像比例最多可配置 13 项')
  for (const [ratio, tiers] of Object.entries(sizes)) {
    const rawTiers: unknown = tiers
    if (!RATIO_ORDER.includes(ratio) || rawTiers === null || typeof rawTiers !== 'object' || Array.isArray(rawTiers)
      || Object.keys(rawTiers).length < 1 || Object.keys(rawTiers).length > 4) {
      throw new TypeError('图像比例或分辨率档位无效')
    }
    for (const [tier, size] of Object.entries(rawTiers as Record<string, unknown>)) {
      const match = typeof size === 'string' ? /^(\d{2,4})x(\d{2,4})$/.exec(size) : null
      const width = Number(match?.[1]), height = Number(match?.[2])
      if (!/^(?:1K|2K|4K)$/.test(tier) || !match || width < 128 || height < 128
        || width > 4096 || height > 4096 || width * height > 16_777_216) {
        throw new TypeError('图像分辨率须为 1K、2K 或 4K 对应的有效像素尺寸')
      }
    }
  }
}

/** 返回原版预设或用户配置的表，次序固定，供选择器与请求校验共同使用。 */
export function outputSizes(configured: Record<string, Record<string, string>> = {}): Record<string, Record<string, string>> {
  const source = Object.keys(configured).length === 0 ? DEFAULT_OUTPUT_SIZES : configured
  return Object.fromEntries(RATIO_ORDER.flatMap((ratio) => {
    const tiers = source[ratio]
    if (tiers === undefined) return []
    return [[ratio, Object.fromEntries(Object.entries(tiers).sort(([a], [b]) => Number.parseInt(a) - Number.parseInt(b)))]]
  }))
}

/** 手动请求仅能使用当前尺寸表中的像素尺寸；模型工具未指定时交由上游选择默认值。 */
export function validateImageOutput(size?: string, quality?: string, sizes: Record<string, Record<string, string>> = {}): void {
  if (size !== undefined && !Object.values(outputSizes(sizes)).some(tiers => Object.values(tiers).includes(size))) {
    throw new TypeError('所选图像尺寸不属于当前比例与分辨率配置')
  }
  if (quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(quality)) {
    throw new TypeError('图像生成质量无效')
  }
}

/**
 * 把模型给的比例与分辨率档位解析成当前尺寸表里的像素尺寸。
 *
 * 只给比例时取该比例下最小的档位，避免默认就请求最大的图；两项都不给返回
 * `undefined`，交由上游选择默认值。比例或档位不在当前表里时抛错，并把可用
 * 组合写进消息，让调用方一次就能改对，而不是反复试。
 * @param sizes - 当前生效的比例到档位映射。
 * @param aspectRatio - 形如 `16:9` 的比例；省略表示不限制。
 * @param resolution - `1K`／`2K`／`4K` 档位；给出时必须同时给出比例。
 * @returns 对应的像素尺寸，或 `undefined`。
 */
export function resolveOutputSize(
  sizes: Record<string, Record<string, string>> = {},
  aspectRatio?: string,
  resolution?: string,
): string | undefined {
  const table = outputSizes(sizes)
  if (aspectRatio === undefined && resolution === undefined) return undefined
  const available = Object.entries(table)
    .map(([ratio, tiers]) => `${ratio}=${Object.keys(tiers).join('/')}`)
    .join(', ')
  if (aspectRatio === undefined) {
    throw new TypeError(`指定分辨率时必须同时给 aspectRatio；当前可用：${available}`)
  }
  const tiers = table[aspectRatio]
  if (tiers === undefined) throw new TypeError(`不支持的图像比例 ${aspectRatio}；当前可用：${available}`)
  const tierNames = Object.keys(tiers)
  const smallest = tierNames[0]
  if (resolution === undefined) {
    // 表由 validateOutputSizes 保证每个比例至少有一个档位。
    if (smallest === undefined) throw new TypeError(`比例 ${aspectRatio} 没有可用的分辨率档位`)
    return tiers[smallest]
  }
  const size = tiers[resolution]
  if (size === undefined) throw new TypeError(`比例 ${aspectRatio} 不支持分辨率 ${resolution}；当前可用：${tierNames.join('/')}`)
  return size
}
