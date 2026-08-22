// Coding 品牌字标：文本绘制，随主题 currentColor 变色，宽 74x24。
// includeMark 保留在类型中兼容调用方；字标本身不含前置图形。

import type { IconProps } from './icons/props.ts'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading whale mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading whale mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: BrandWordmarkProps) {
  // Coding wordmark: text-based so the name stays editable across locales and themes.
  const width = 74
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={`0 0 ${width} 24`}
      fill="none"
      aria-hidden="true"
    >
      <text
        x="0"
        y={size - 6}
        fill="currentColor"
        fontSize="17"
        fontWeight="600"
        fontFamily="inherit"
      >
        Coding
      </text>
    </svg>
  )
}
