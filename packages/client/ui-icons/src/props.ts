/** 原有图标和语义图标共用的尺寸与布局属性。 */
export interface IconProps {
  /** 正方形边长，默认采用图形自身尺寸。 */
  size?: number | undefined
  /** 布局类名；一般图标继承 currentColor，品牌图标保留固定颜色。 */
  className?: string | undefined
}
