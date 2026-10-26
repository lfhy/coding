/**
 * 主题目录共用的颜色工具：解析、混色、对比度与色相。
 *
 * 这里只做「把上游调色板换算本项目令牌」和「页面预览取色」需要的算术，不解析
 * 任意 CSS：输入是上游主题数据里的 hex / rgb() / rgba() / transparent，
 * 无法识别的值返回 undefined，由调用方跳过该令牌——宁可少覆盖一条，也不要
 * 把一个解析不出色的字符串写进 body 的内联样式。
 */

/** 解析后的颜色；`a` 为 0–1 的透明度。 */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const HEX = /^#([0-9a-f]{3,8})$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i

/** 解析 hex / rgb() 颜色；不支持的颜色名或渐变返回 undefined。 */
export function parseColor(value: string | undefined): Rgba | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === '' || text === 'transparent' || text === 'none') return undefined
  const hex = HEX.exec(text)
  if (hex !== null) {
    let digits = hex[1] ?? ''
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.split('').map(c => c + c).join('')
    }
    if (digits.length !== 6 && digits.length !== 8) return undefined
    const n = Number.parseInt(digits.slice(0, 6), 16)
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: alpha }
  }
  const rgb = RGB.exec(text)
  if (rgb === null) return undefined
  const channel = (raw: string | undefined): number => Math.max(0, Math.min(255, Number(raw ?? '')))
  const alphaRaw = rgb[4]
  const alpha = alphaRaw === undefined
    ? 1
    : (alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw))
  return { r: channel(rgb[1]), g: channel(rgb[2]), b: channel(rgb[3]), a: Math.max(0, Math.min(1, alpha)) }
}

/** 把 0–255 通道写成两位十六进制。 */
function hex2(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/** 输出 `#rrggbb`（丢弃透明度）。 */
export function toHex(color: Rgba): string {
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`
}

/**
 * 输出带透明度的 `rgba()`；已经是半透明的输入按其原透明度相乘。
 * @param value - 目标颜色。
 * @param alpha - 目标透明度（0–1）。
 * @returns rgba() 字面量；输入不可解析时返回 undefined。
 */
export function withAlpha(value: string | undefined, alpha: number): string | undefined {
  const color = parseColor(value)
  if (color === undefined) return undefined
  const a = Math.max(0, Math.min(1, color.a * alpha))
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(a.toFixed(3))})`
}

/**
 * 按色板明暗方向调整亮度：深色方案向白混，浅色方案向黑混。
 * @param value - 目标颜色。
 * @param amount - 混入比例（0–1）。
 * @param dark - 是否为深色方案（决定混合目标）。
 * @returns 混色后的 hex；输入不可解析时返回 undefined。
 */
export function shade(value: string | undefined, amount: number, dark: boolean): string | undefined {
  const color = parseColor(value)
  if (color === undefined) return undefined
  const target = dark ? 255 : 0
  const mix = (channel: number): number => channel + (target - channel) * amount
  return toHex({ r: mix(color.r), g: mix(color.g), b: mix(color.b), a: 1 })
}

/** WCAG 相对亮度（0–1）。 */
export function luminance(value: string | undefined): number {
  const color = parseColor(value)
  if (color === undefined) return 0
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/**
 * 在给定底色上选一个可读的文字色：亮底配深字，暗底配浅字。
 * @param value - 底色。
 * @returns 文字色；底色不可解析时按浅底处理。
 */
export function readableOn(value: string | undefined): string {
  const color = parseColor(value)
  if (color === undefined) return '#141414'
  return luminance(toHex(color)) > 0.55 ? '#141414' : '#f4f4f5'
}

/**
 * 色相角（度）；中性色返回 -2，无值返回 -1，与上游分组口径一致。
 * @param value - 目标颜色。
 */
export function hueOf(value: string | undefined): number {
  const color = parseColor(value)
  if (color === undefined) return -1
  const { r, g, b } = color
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return -2
  if (max === 0 || delta / max < 0.18) return -2
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  let hue = max === rr
    ? ((gg - bb) / delta) % 6
    : (max === gg ? (bb - rr) / delta + 2 : (rr - gg) / delta + 4)
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/**
 * 把半透明颜色合成到不透明底色上。
 * @param value - 前景色（可带透明度）。
 * @param base - 底色（应不透明）。
 * @returns 合成后的 hex；任一输入不可解析时原样返回前景。
 */
export function blendOnto(value: string | undefined, base: string | undefined): string | undefined {
  const fg = parseColor(value)
  const bg = parseColor(base)
  if (fg === undefined) return value
  if (bg === undefined) return toHex(fg)
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a)
  return toHex({ r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 })
}
