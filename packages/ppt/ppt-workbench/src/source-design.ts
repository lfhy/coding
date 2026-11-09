/** 从经过导入准入的 OOXML 设计部件读取主题色；未知映射交给导入方保守回退。 */

/** 只接受可转换为编辑模型颜色的 RGB 或现有主题色，不执行源文档内的任何内容。 */
export interface SourceDesign {
  readonly background: string | undefined
  readonly font: string | undefined
  readonly color: (xml: string) => string | undefined
}

function tag(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`<${escaped}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'u').exec(xml)?.[1] ?? ''
}

function rgb(xml: string): string | undefined {
  const value = /<a:srgbClr\b[^>]*\bval="([0-9a-fA-F]{6})"/u.exec(xml)?.[1]
  return value === undefined ? undefined : `#${value.toLowerCase()}`
}

/**
 * 解析源页关联的 layout/master/theme 颜色与字体；映射不完整时只用明确的 RGB。
 * @param parts - 经导入器验证关系后取得的设计部件。
 * @returns 供元素提取使用的解析器，不负责推断未知的母版几何。
 */
export function sourceDesign(parts: readonly { kind: 'layout' | 'master' | 'theme'; xml: string }[]): SourceDesign {
  const theme = parts.find(part => part.kind === 'theme')?.xml ?? ''
  const master = parts.find(part => part.kind === 'master')?.xml ?? ''
  const scheme = tag(theme, 'a:clrScheme')
  const colors = new Map<string, string>()
  for (const name of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3',
    'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const value = rgb(tag(scheme, `a:${name}`))
    if (value !== undefined) colors.set(name, value)
  }
  const clrMap = /<p:clrMap\b[^>]*>/u.exec(master)?.[0] ?? ''
  const mapped = new Map<string, string>()
  for (const item of clrMap.matchAll(/([a-zA-Z][\w]*)="([a-zA-Z][\w]*)"/gu)) {
    mapped.set(item[1] ?? '', item[2] ?? '')
  }
  const color = (xml: string): string | undefined => {
    const explicit = rgb(xml)
    if (explicit !== undefined) return explicit
    const schemeName = /<a:schemeClr\b[^>]*\bval="([a-zA-Z][\w]*)"/u.exec(xml)?.[1]
    if (schemeName === undefined) return undefined
    // 带颜色变换的色值不能精确投影为单色；不把不确定的值伪装成原样式。
    if (/<a:(?:alpha|tint|shade|satMod|lumMod|lumOff)\b/u.test(xml)) return undefined
    return colors.get(mapped.get(schemeName) ?? schemeName)
  }
  const fontScheme = tag(theme, 'a:fontScheme')
  const font = /<a:latin\b[^>]*\btypeface="([^"]{1,100})"/u.exec(tag(fontScheme, 'a:minorFont'))?.[1]
    ?? /<a:latin\b[^>]*\btypeface="([^"]{1,100})"/u.exec(tag(fontScheme, 'a:majorFont'))?.[1]
  return { color, background: colors.get(mapped.get('bg1') ?? 'lt1'), font }
}
