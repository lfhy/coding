/** PPT 工作台品牌标；原始图形与许可来源见包内 NOTICE。 */
import { useId } from 'react'
import type { IconProps } from './props.ts'

/**
 * 绘制上游的双色叠放幻灯片，渐变 id 在同页多实例间保持唯一。
 * @param props - 像素尺寸和布局类名。
 * @returns 隐藏于无障碍树的品牌 SVG。
 */
export function PptMark({ size = 16, className }: IconProps) {
  const id = useId()
  const backId = `ppt-mark-back-${id}`
  const frontId = `ppt-mark-front-${id}`
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={backId} x1="13" y1="8" x2="28" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF9E66" />
          <stop offset="1" stopColor="#FA541C" />
        </linearGradient>
        <linearGradient id={frontId} x1="7" y1="13" x2="25" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#69B9FF" />
          <stop offset="1" stopColor="#324DE2" />
        </linearGradient>
      </defs>
      <g transform="translate(18 18) scale(1.3) translate(-18 -18)">
        <rect x="13.5" y="8" width="14" height="11" rx="2.5" fill={`url(#${backId})`} />
        <rect x="8" y="13.5" width="17" height="13" rx="2.5" fill={`url(#${frontId})`} />
        <rect x="11.5" y="17" width="10" height="2" rx="1" fill="#FFFFFF" />
        <rect x="11.5" y="21" width="6.5" height="2" rx="1" fill="#FFFFFF" fillOpacity="0.85" />
      </g>
    </svg>
  )
}
