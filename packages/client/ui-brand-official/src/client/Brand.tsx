import { BrandMark, BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * 按宿主表面提供的尺寸渲染 Coding 品牌图标。
 * @param props - 宿主提供的品牌图标呈现参数。
 * @returns Coding 品牌图标。
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <BrandMark size={size} className={className} />
}

/**
 * 渲染不含独立 slot 图标的 Coding 字标。
 * @returns Coding 字标。
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
