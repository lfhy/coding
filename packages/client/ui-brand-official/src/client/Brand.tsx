import { BrandMark } from 'coding-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from 'coding-client-ui-conversation/client'

/**
 * 按宿主表面提供的尺寸渲染 Coding 品牌图标。
 * @param props - 宿主提供的品牌图标呈现参数。
 * @returns Coding 品牌图标。
 */
export function OfficialBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <BrandMark size={size} className={className} />
}
