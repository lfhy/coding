/** 尺寸选择器使用的比例轮廓；auto 用虚线方形表示不指定尺寸。 */
import type { IconProps } from './props.ts'

/** 比例轮廓参数。 */
export interface AspectRatioGlyphProps extends IconProps {
  /** `width:height` 形式的比例；无法解析时按方形绘制。 */
  ratio: string
  /** 是否为未指定尺寸的自动选项。 */
  auto?: boolean
}

/**
 * 在统一画布内按宽高比绘制轮廓，供尺寸菜单的选项与触发器复用。
 * @param props - 比例、自动状态、尺寸和布局类名。
 * @returns 继承 currentColor 的装饰性 SVG。
 */
export function AspectRatioGlyph({ ratio, auto = false, size = 16, className }: AspectRatioGlyphProps) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(ratio)
  let width = 12
  let height = 12
  if (!auto && match !== null) {
    const left = Number(match[1])
    const right = Number(match[2])
    if (left >= right) height = Math.max(6, 12 * right / left)
    else width = Math.max(6, 12 * left / right)
  }
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x={(16 - width) / 2} y={(16 - height) / 2} width={width} height={height} rx="3"
      stroke="currentColor" strokeWidth="1.4" strokeDasharray={auto ? '2 2' : undefined} />
  </svg>
}
