// Coding 品牌字标：文本绘制，随主题 currentColor 变色，宽 74x24。
// includeMark 保留在类型中兼容调用方；字标本身不含前置图形。

import type { IconProps } from '@deepseek-ai/dsh-client-ui-icons'

/** Coding 品牌字标的显示选项。 */
export interface BrandWordmarkProps extends IconProps {
  /** 保留该参数以兼容既有调用；当前字标始终不包含前置图标。 */
  includeMark?: boolean | undefined
}

/**
 * 渲染 Coding 品牌字标。
 * @param props.size - 高度，默认 24px；宽度随字标比例变化。
 * @param props.className - 供布局使用的附加类名。
 * @param props.includeMark - 兼容既有调用的保留参数，不影响当前字标渲染。
 * @returns 不参与无障碍名称计算的字标 SVG。
 */
export function BrandWordmark({ size = 24, className }: BrandWordmarkProps) {
  // 用文本绘制字标，使名称可随主题和语言环境保持可编辑。
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
