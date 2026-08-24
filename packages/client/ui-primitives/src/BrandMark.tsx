import type { IconProps } from './icons/props.ts'

/**
 * 渲染 Coding 的方形品牌图标。
 * @param props.size - 图标的宽高，默认 24px。
 * @param props.className - 宿主提供的布局类名。
 * @returns 不参与无障碍名称计算的品牌图标。
 */
export function BrandMark({ size = 24, className }: IconProps) {
  return <img src="/favicon.png" width={size} height={size} className={className} alt="" aria-hidden="true" draggable={false} />
}
