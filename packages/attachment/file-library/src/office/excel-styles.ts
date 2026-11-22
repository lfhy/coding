/** 在 SpreadsheetML 的索引式样表与笔记的基础单元格样式间转换。 */
import type { ExcelStyle } from '../types.ts'
import { decodeExcelString, escapeExcelString, excelNamespace, excelUnsigned } from './excel-xml.ts'
import type { OfficePackage } from './package.ts'
import { EXCEL_NS, xmlAttr, xmlChild, xmlChildren, type XmlElement } from './xml.ts'

// 内建格式使用非本地化表示；General（ID 0）是没有格式覆盖的默认值。
const BUILTIN_FORMATS: ReadonlyMap<number, string> = new Map([
  [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'],
  [5, '"$"#,##0_);("$"#,##0)'], [6, '"$"#,##0_);[Red]("$"#,##0)'],
  [7, '"$"#,##0.00_);("$"#,##0.00)'], [8, '"$"#,##0.00_);[Red]("$"#,##0.00)'],
  [9, '0%'], [10, '0.00%'], [11, '0.00E+00'], [12, '# ?/?'], [13, '# ??/??'],
  [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy h:mm'],
  [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'],
  [39, '#,##0.00;(#,##0.00)'], [40, '#,##0.00;[Red](#,##0.00)'],
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'],
  [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'], [49, '@'],
])
const BUILTIN_FORMAT_IDS = new Map(Array.from(BUILTIN_FORMATS, ([id, code]) => [code, id]))
const FIRST_CUSTOM_FORMAT = 164

const INDEXED_COLORS = [
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF',
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF',
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080',
  '9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF',
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF',
  '00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99',
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696',
  '003366 339966 003300 333300 993300 993366 333399 333333',
].join(' ').split(' ')

function rgb(value: string | undefined): string | undefined {
  return value !== undefined && /^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})$/u.test(value)
    ? `#${value.slice(-6).toUpperCase()}` : undefined
}

function readColor(node: XmlElement | undefined, indexed: readonly (string | undefined)[]): string | undefined {
  const direct = rgb(xmlAttr(node, 'rgb'))
  if (direct !== undefined) return direct
  const value = xmlAttr(node, 'indexed')
  if (value === undefined) return undefined
  const index = excelUnsigned(value, '样式颜色索引')
  // 64、65 与自动或主题颜色一样依赖使用方环境，不能作为固定 RGB 保存。
  if (index >= INDEXED_COLORS.length) return undefined
  return indexed[index] ?? rgb(INDEXED_COLORS[index])
}

function falseValue(value: string | undefined): boolean {
  return value === '0' || value === 'false'
}

const EMPHASIS = [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['strike', 'strike']] as const

function readFont(node: XmlElement, uri: string, indexed: readonly (string | undefined)[]): ExcelStyle {
  const style: ExcelStyle = {}
  for (const [tag, key] of EMPHASIS) {
    const flag = xmlChild(node, tag, uri)
    if (!flag) continue
    const value = xmlAttr(flag, 'val')
    style[key] = !falseValue(value) && (tag !== 'u' || value !== 'none')
  }
  const color = readColor(xmlChild(node, 'color', uri), indexed)
  if (color !== undefined) style.color = color
  return style
}

function readFill(node: XmlElement, uri: string, indexed: readonly (string | undefined)[]): string | undefined {
  const pattern = xmlChild(node, 'patternFill', uri)
  if (xmlAttr(pattern, 'patternType') !== 'solid') return undefined
  return readColor(xmlChild(pattern, 'fgColor', uri), indexed)
}

function formatTable(root: XmlElement | undefined, container: string, entry: string, uri: string): XmlElement[] {
  return xmlChildren(xmlChild(root, container, uri), entry, uri)
}

function indexedElement(nodes: readonly XmlElement[], index: number, subject: string): XmlElement | undefined {
  const node = nodes[index]
  if (!node && (index !== 0 || nodes.length !== 0)) throw new TypeError(`Excel ${subject}索引超出范围`)
  return node
}

function projectIndex<T>(nodes: readonly XmlElement[], subject: string, read: (node: XmlElement) => T): (index: number) => T | undefined {
  const cache = new Map<number, T | undefined>()
  return (index) => {
    if (cache.has(index)) return cache.get(index)
    const node = indexedElement(nodes, index, subject)
    const result = node && read(node)
    cache.set(index, result)
    return result
  }
}

function effectiveIndex(xf: XmlElement, base: XmlElement | undefined, attr: string, apply: string): number {
  const override = falseValue(xmlAttr(xf, apply)) ? undefined : xmlAttr(xf, attr)
  const value = override ?? xmlAttr(base, attr)
  return value === undefined ? 0 : excelUnsigned(value, attr)
}

/**
 * 读取样式部件，仅在单元格引用时投影字体、实色填充和数字格式。
 * @param packageFile 已完成关系预检的 Excel 包。
 * @returns 按 `c@s` 查找基础样式的函数；没有可表示的覆盖时返回 undefined，非法索引抛出 TypeError。
 */
export function readExcelStyles(packageFile: OfficePackage): (styleId: string | undefined) => ExcelStyle | undefined {
  const path = packageFile.related(packageFile.main, 'styles')
  const root = path === undefined ? undefined : packageFile.xml(path)
  const uri = root ? excelNamespace(root, 'styleSheet') : EXCEL_NS
  const colors = xmlChild(xmlChild(root, 'colors', uri), 'indexedColors', uri)
  const indexed = xmlChildren(colors, 'rgbColor', uri).map(node => rgb(xmlAttr(node, 'rgb')))
  const font = projectIndex(formatTable(root, 'fonts', 'font', uri), '字体', node => readFont(node, uri, indexed))
  const fill = projectIndex(formatTable(root, 'fills', 'fill', uri), '填充', node => readFill(node, uri, indexed))
  const bases = formatTable(root, 'cellStyleXfs', 'xf', uri)
  const numbers = new Map<number, string>()
  for (const entry of formatTable(root, 'numFmts', 'numFmt', uri)) {
    const id = xmlAttr(entry, 'numFmtId')
    const code = xmlAttr(entry, 'formatCode')
    if (id !== undefined && code !== undefined) numbers.set(excelUnsigned(id, '数字格式索引'), decodeExcelString(code))
  }
  const cellStyle = projectIndex(formatTable(root, 'cellXfs', 'xf', uri), '单元格样式', (xf) => {
    const rawBase = xmlAttr(xf, 'xfId')
    const base = rawBase === undefined ? undefined : indexedElement(bases, excelUnsigned(rawBase, '基础样式索引'), '基础样式')
    const style = { ...font(effectiveIndex(xf, base, 'fontId', 'applyFont')) }
    const background = fill(effectiveIndex(xf, base, 'fillId', 'applyFill'))
    const numberId = effectiveIndex(xf, base, 'numFmtId', 'applyNumberFormat')
    const numberFormat = numbers.get(numberId) ?? BUILTIN_FORMATS.get(numberId)
    if (background !== undefined) style.background = background
    if (numberFormat !== undefined) style.numberFormat = numberFormat
    return Object.keys(style).length === 0 ? undefined : style
  })
  return raw => cellStyle(raw === undefined ? 0 : excelUnsigned(raw, '单元格样式索引'))
}

const DEFAULT_FONT = '<sz val="11"/><name val="Calibri"/><family val="2"/>'
const DEFAULT_XF = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"'

function opaqueRgb(color: string): string {
  return `FF${color.slice(1).toUpperCase()}`
}

function fontOverrides(style: ExcelStyle): string {
  let overrides = ''
  for (const [tag, key] of EMPHASIS) {
    const value = style[key]
    if (value !== undefined) overrides += value ? `<${tag}/>` : `<${tag} val="${tag === 'u' ? 'none' : '0'}"/>`
  }
  if (style.color !== undefined) overrides += `<color rgb="${opaqueRgb(style.color)}"/>`
  return overrides
}

function tableEntry(parts: string[], index: Map<string, number>, xml: string): number {
  const stored = index.get(xml)
  if (stored !== undefined) return stored
  const id = parts.length
  index.set(xml, id)
  parts.push(xml)
  return id
}

/** 每次导出独占的样式索引；表项按单元格首次引用去重。 */
export class ExcelStyleWriter {
  private readonly fonts = [`<font>${DEFAULT_FONT}</font>`]
  private readonly fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  private readonly xfs = [`${DEFAULT_XF} xfId="0"/>`]
  private readonly fontIds = new Map<string, number>()
  private readonly fillIds = new Map<string, number>()
  private readonly xfIds = new Map<string, number>()
  private readonly numberIds = new Map<string, number>()

  /**
   * 登记一个已校验的域样式，允许多张工作表共用同一索引。
   * @param style 单元格显式覆盖；缺省时使用工作簿默认样式。
   * @returns 写入单元格 `s` 属性的索引；零可省略。
   */
  id(style: ExcelStyle | undefined): number {
    if (!style) return 0
    const font = fontOverrides(style)
    const fontId = font ? tableEntry(this.fonts, this.fontIds, `<font>${DEFAULT_FONT}${font}</font>`) : 0
    const fillId = style.background === undefined ? 0 : tableEntry(this.fills, this.fillIds,
      `<fill><patternFill patternType="solid"><fgColor rgb="${opaqueRgb(style.background)}"/><bgColor indexed="64"/></patternFill></fill>`)
    const numberId = this.numberId(style.numberFormat)
    if (fontId === 0 && fillId === 0 && numberId === 0) return 0
    const apply = `${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${numberId ? ' applyNumberFormat="1"' : ''}`
    return tableEntry(this.xfs, this.xfIds, `<xf numFmtId="${numberId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${apply}/>`)
  }

  /** @returns 已登记的样式表 XML；调用者在序列化完所有工作表后写入 ZIP。 */
  xml(): string {
    const numberFormats = Array.from(this.numberIds, ([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeExcelString(code)}"/>`)
    return `<styleSheet xmlns="${EXCEL_NS}">`
      + (numberFormats.length ? `<numFmts count="${numberFormats.length}">${numberFormats.join('')}</numFmts>` : '')
      + `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>`
      + `<fills count="${this.fills.length}">${this.fills.join('')}</fills>`
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + `<cellStyleXfs count="1">${DEFAULT_XF}/></cellStyleXfs>`
      + `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  }

  private numberId(format: string | undefined): number {
    if (format === undefined) return 0
    const existing = BUILTIN_FORMAT_IDS.get(format) ?? this.numberIds.get(format)
    if (existing !== undefined) return existing
    const id = FIRST_CUSTOM_FORMAT + this.numberIds.size
    this.numberIds.set(format, id)
    return id
  }
}
