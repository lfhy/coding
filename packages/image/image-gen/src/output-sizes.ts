/**
 * 兼容图像接口的比例与分辨率表。
 *
 * 默认组合取自 OpenAI 官方图像生成指南的 popular sizes，档位名沿用界面与模型
 * 共用的 1K／2K／4K 分组。官方只列出这些比例与尺寸，其它比例需在 `sizes` 里补上
 * 符合官方尺寸约束的像素值；官方尺寸见
 * https://developers.openai.com/api/docs/guides/image-generation 。
 */
export const DEFAULT_OUTPUT_SIZES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048' },
  '2:3': { '1K': '1024x1536' },
  '3:2': { '1K': '1536x1024' },
  '16:9': { '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '4K': '2160x3840' },
}

/** 官方尺寸约束：最长边 3840，宽高为 16 的倍数，长宽比不超过 3:1，总像素 655360 至 8294400。 */
const MAX_EDGE = 3840
const MAX_ASPECT = 3
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400

const RATIO_ORDER = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9', '1:3', '3:1']

/** 自定义表仅接受有界比例、档位和明确像素尺寸，避免无效设置落到上游请求。 */
export function validateOutputSizes(sizes: Record<string, Record<string, string>>): void {
  if (Object.keys(sizes).length > 13) throw new TypeError('图像比例最多可配置 13 项')
  for (const [ratio, tiers] of Object.entries(sizes)) {
    const rawTiers: unknown = tiers
    if (!RATIO_ORDER.includes(ratio) || rawTiers === null || typeof rawTiers !== 'object' || Array.isArray(rawTiers)
      || Object.keys(rawTiers).length < 1 || Object.keys(rawTiers).length > 3) {
      throw new TypeError('图像比例或分辨率档位无效')
    }
    for (const [tier, size] of Object.entries(rawTiers as Record<string, unknown>)) {
      const match = typeof size === 'string' ? /^(\d{2,4})x(\d{2,4})$/.exec(size) : null
      const width = Number(match?.[1]), height = Number(match?.[2])
      const longEdge = Math.max(width, height), shortEdge = Math.min(width, height)
      // 与官方图像接口一致：档位名只是分组，真正的限制在像素尺寸本身。
      if (!/^(?:1K|2K|4K)$/.test(tier) || !match
        || width % 16 !== 0 || height % 16 !== 0
        || longEdge > MAX_EDGE || longEdge > shortEdge * MAX_ASPECT
        || width * height < MIN_PIXELS || width * height > MAX_PIXELS) {
        throw new TypeError('图像分辨率须为 1K、2K 或 4K 档位对应的合法像素尺寸：宽高为 16 的倍数，最长边不超过 3840，长宽比不超过 3:1，总像素介于 655360 与 8294400 之间')
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
