/**
 * 把一份工程导出成 .pptx：每页对应一张 slide，元素转成 DrawingML 的文本框、预设形状、
 * 连接线、图片与表格，页面转场写成 `<p:transition>`。
 *
 * 这里生成的是 PowerPoint / Keynote / WPS 都能打开的最小 OPC 包：只写模型拥有的东西——
 * 页面几何、文本、形状、图片、表格、图表、转场与动画。文本字体按元素字体写入 `a:latin`
 * 与 `a:ea`，空字体落到主题默认黑体；可嵌入的字体清单由调用方给出。图片字节由调用方经
 * `media` 读取器提供，导出本身不碰文件系统，测试与其它载体可以喂自己的实现。
 * @module coding-ppt-workbench/export/pptx
 */

import {
  DEFAULT_FONT_FAMILY, PPT_THEMES, SLIDE_SIZES,
  type PptChartElement, type PptDeck, type PptElement, type PptImageElement, type PptPage,
  type PptTableElement,
} from 'coding-ppt-model'
import { zip, type ZipEntry } from './zip.ts'

/** 1 个基准像素对应的 EMU（96 DPI）。 */
const EMU_PER_PX = 9525

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_DOCUMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const MASTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster'
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const THEME_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const CONTENT_TYPES = 'application/vnd.openxmlformats-officedocument'

/** 支持的图片扩展名与对应 OPC 默认内容类型。 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** 一个要写进 `ppt/fonts/` 的嵌入字体。 */
export interface PptxFont {
  readonly family: string
  /** `ppt/fonts/fontN.fntdata`。 */
  readonly part: string
  readonly bytes: Uint8Array
  /** 只读嵌入（Preview & Print）：目标机只能看不能改。 */
  readonly readonly?: boolean
  /** 该族是否自带中文字形；false 时中文走主题默认黑体。缺省表示未知。 */
  readonly cjk?: boolean
}

/** 导出时可选的媒体读取器。 */
export interface PptxOptions {
  /**
   * 读取图片字节。
   * @param source - 工程内 `media/<file>` 相对路径。
   * @returns 图片字节；缺失时该元素退化成主题色占位框。
   */
  readonly media?: (source: string) => Uint8Array | undefined
  /** 要嵌入的字体（由 `collectFonts` 按 fsType 许可筛过）。 */
  readonly fonts?: readonly PptxFont[]
}

/** 一个要写进 `ppt/media/` 的图片部件。 */
interface MediaRef {
  readonly source: string
  /** `ppt/media/imageN.<ext>`。 */
  readonly part: string
  readonly ext: string
  readonly bytes: Uint8Array
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function srgb(hex: string): string {
  return hex.replace('#', '').toUpperCase()
}

/**
 * 一个 run 的字体属性取值：元素写了字体就用它，空字体交给主题默认字体。
 * `a:latin` 与 `a:ea` 分开取值，中日韩字符才不会退回 PowerPoint 自己的西文字体。
 * @param font - 元素上的字体族名；空串表示跟随主题。
 * @param fallback - 主题占位值，例如 `+mn-lt`。
 * @returns 可直接写进 XML 属性的 typeface。
 */
function typefaceOf(font: string, fallback: string): string {
  return font === '' ? fallback : escapeXml(font)
}

/** 元素字体 → 是否含中文的查询表；缺省（未收集到字体）表示未知。 */
type CjkLookup = ReadonlyMap<string, boolean | undefined>

/**
 * 一个 run 的东亚字体槽。
 *
 * 空字体走主题（`+mn-ea`，也就是默认黑体）；明确不含中文的族只用于西文，
 * 中文同样回落到主题黑体——否则查看端只能拿一个没有汉字的族名逐字替换，
 * 中文会变成宋体混排甚至缺字框。
 * @param font - 元素字体族名。
 * @param cjkOf - 族名 → 是否含中文。
 * @returns `a:ea` 的 typeface 取值。
 */
function eastAsianOf(font: string, cjkOf: CjkLookup): string {
  if (font === '') return '+mn-ea'
  return cjkOf.get(font) === false ? '+mn-ea' : escapeXml(font)
}

function emu(px: number): number {
  return Math.round(px * EMU_PER_PX)
}

function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
}

function rels(items: readonly string[]): string {
  return `${XML_DECL}\n<Relationships xmlns="${REL_NS}">${items.join('')}</Relationships>`
}

function emptyTree(): string {
  return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'
}

function xfrm(element: PptElement): string {
  return `<a:xfrm><a:off x="${emu(element.x)}" y="${emu(element.y)}"/>`
    + `<a:ext cx="${emu(element.w)}" cy="${emu(element.h)}"/></a:xfrm>`
}

function extensionOf(source: string): string {
  const ext = source.split('.').pop()?.toLowerCase() ?? 'png'
  return ext in MEDIA_TYPES ? ext : 'png'
}

function textBody(element: Extract<PptElement, { kind: 'text' }>, cjkOf: CjkLookup): string {
  const { text } = element
  const anchor = text.valign === 'middle' ? 'ctr' : text.valign === 'bottom' ? 'b' : 't'
  const align = text.align === 'center' ? 'ctr' : text.align === 'right' ? 'r' : 'l'
  const paragraphs = text.content.split('\n').map((line) => {
    const paragraphProps = `<a:pPr algn="${align}"/>`
    if (line === '') return `<a:p>${paragraphProps}</a:p>`
    const runProps = `<a:rPr lang="zh-CN" altLang="en-US" sz="${Math.round(text.size * 75)}"`
      + `${text.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${srgb(text.color)}"/>`
      + `</a:solidFill><a:latin typeface="${typefaceOf(text.font, '+mn-lt')}"/>`
      + `<a:ea typeface="${eastAsianOf(text.font, cjkOf)}"/></a:rPr>`
    return `<a:p>${paragraphProps}<a:r>${runProps}<a:t>${escapeXml(line)}</a:t></a:r></a:p>`
  })
  return '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"'
    + ` anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs.join('')}</p:txBody>`
}

type BoxElement = Extract<PptElement, { kind: 'text' | 'rect' | 'ellipse' }>

function shape(element: BoxElement, index: number, cjkOf: CjkLookup): string {
  const name = `Shape ${index + 2}`
  if (element.kind === 'text') {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="${escapeXml(name)}"/>`
      + '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
      + `<p:spPr>${xfrm(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      + '<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>'
      + `${textBody(element, cjkOf)}</p:sp>`
  }
  const preset = element.kind === 'ellipse' ? 'ellipse' : 'rect'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="${escapeXml(name)}"/>`
    + '<p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + `<p:spPr>${xfrm(element)}<a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="${srgb(element.fill)}"/></a:solidFill>`
    + '<a:ln><a:noFill/></a:ln></p:spPr>'
    + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>'
}

function line(element: Extract<PptElement, { kind: 'line' }>, index: number): string {
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${index + 2}" name="Line ${index + 2}"/>`
    + '<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
    + `<p:spPr>${xfrm(element)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
    + `<a:ln w="${emu(element.width)}"><a:solidFill><a:srgbClr val="${srgb(element.color)}"/>`
    + '</a:solidFill></a:ln></p:spPr></p:cxnSp>'
}

function picture(element: PptImageElement, index: number, relId: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${index + 2}" name="Picture ${index + 2}"/>`
    + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

function tableCell(content: string, style: PptTableElement['text'], fill: string, cjkOf: CjkLookup): string {
  const align = style.align === 'center' ? 'ctr' : style.align === 'right' ? 'r' : 'l'
  const paragraph = content === ''
    ? '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'
    : `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(style.size * 75)}"`
      + `${style.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${srgb(style.color)}"/>`
      + `</a:solidFill><a:latin typeface="${typefaceOf(style.font, '+mn-lt')}"/>`
      + `<a:ea typeface="${eastAsianOf(style.font, cjkOf)}"/></a:rPr>`
      + `<a:t>${escapeXml(content)}</a:t></a:r></a:p>`
  return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>'
    + `${paragraph}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">`
    + `<a:solidFill><a:srgbClr val="${srgb(fill)}"/></a:solidFill></a:tcPr></a:tc>`
}

function table(element: PptTableElement, index: number, pageBackground: string, cjkOf: CjkLookup): string {
  const total = element.columnWeights.reduce((sum, weight) => sum + weight, 0)
  const columns = element.columnWeights.map(weight => Math.max(1, Math.round(element.w * weight / total)))
  const rowHeight = Math.max(1, Math.round(element.h / element.rows))
  const grid = columns.map(width => `<a:gridCol w="${emu(width)}"/>`).join('')
  const rows = element.cells.map((row, rowIndex) => {
    const fill = element.header && rowIndex === 0 ? element.headerFill : pageBackground
    const cells = row.map(cell => tableCell(cell.content, element.text, fill, cjkOf)).join('')
    return `<a:tr h="${emu(rowHeight)}">${cells}</a:tr>`
  }).join('')
  const border = `<a:lnL w="9525"><a:solidFill><a:srgbClr val="${srgb(element.borderColor)}"/></a:solidFill></a:lnL>`
    + `<a:lnR w="9525"><a:solidFill><a:srgbClr val="${srgb(element.borderColor)}"/></a:solidFill></a:lnR>`
    + `<a:lnT w="9525"><a:solidFill><a:srgbClr val="${srgb(element.borderColor)}"/></a:solidFill></a:lnT>`
    + `<a:lnB w="9525"><a:solidFill><a:srgbClr val="${srgb(element.borderColor)}"/></a:solidFill></a:lnB>`
  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${index + 2}" name="Table ${index + 2}"/><p:cNvGraphicFramePr/><p:nvPr/>`
    + '</p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${emu(element.x)}" y="${emu(element.y)}"/>`
    + `<a:ext cx="${emu(element.w)}" cy="${emu(element.h)}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + `<a:tbl><a:tblPr firstRow="1" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>`
    + `${border}</a:graphicData></a:graphic></p:graphicFrame>`
}

const CHART_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function strCache(values: readonly string[]): string {
  const points = values.map((value, index) => `<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`).join('')
  return `<c:strCache><c:ptCount val="${values.length}"/>${points}</c:strCache>`
}

function numCache(values: readonly number[]): string {
  const points = values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}`
}

function chartSeriesXml(element: PptChartElement, seriesKind?: 'bar' | 'line'): string {
  return element.series
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => seriesKind === undefined || (series.as ?? element.chart) === seriesKind)
    .map(({ series, index }) => {
      const cats = `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${element.categories.length + 1}</c:f>`
      + `${strCache(element.categories)}</c:strRef></c:cat>`
      const values = `<c:val><c:numRef><c:f>Sheet1!$${String.fromCharCode(66 + index)}$2:`
      + `$${String.fromCharCode(66 + index)}$${series.values.length + 1}</c:f>`
      + `<c:numCache>${numCache(series.values)}</c:numCache></c:numRef></c:val>`
      const name = `<c:tx><c:strRef><c:f>Sheet1!$${String.fromCharCode(66 + index)}$1</c:f>`
      + `${strCache([series.name])}</c:strRef></c:tx>`
      const shapeProps = `<c:spPr><a:solidFill><a:srgbClr val="${srgb(series.color)}"/></a:solidFill></c:spPr>`
      const labels = element.showValues
        ? '<c:dLbls><c:showVal val="1"/></c:dLbls>'
        : ''
      return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${name}${shapeProps}`
      + `${element.chart === 'pie' ? '' : cats}${values}${labels}</c:ser>`
    })
    .join('')
}

/**
 * 生成图表部件（bar / line / pie）。
 * @param element - 图表元素。
 * @returns `ppt/charts/chartN.xml` 的内容。
 */
function chartXml(element: PptChartElement): string {
  const series = chartSeriesXml(element)
  const textProps = '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200">'
    + `<a:solidFill><a:srgbClr val="${srgb(element.textColor)}"/></a:solidFill></a:defRPr></a:pPr>`
    + '<a:endParaRPr lang="zh-CN"/></a:p></c:txPr>'
  if (element.chart === 'pie') {
    return `${XML_DECL}\n<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>`
      + `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart></c:plotArea>${textProps}</c:chart>`
      + '</c:chartSpace>'
  }
  const hasSecondary = element.series.some(series => series.axis === 'secondary')
  const mixed = element.series.some(series => series.as !== undefined && series.as !== element.chart)
  const axes = '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
    + '<c:delete val="0"/><c:axPos val="b"/></c:catAx>'
    + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
    + '<c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>'
    + (hasSecondary
      ? '<c:valAx><c:axId val="3"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        + '<c:delete val="0"/><c:axPos val="r"/><c:crosses val="max"/><c:crossAx val="1"/></c:valAx>'
      : '')
  if (mixed) {
    // 组合图：柱与线分开成两个图表类型，共享分类轴；次坐标轴由图上的第二条数值轴承接。
    const barSeries = chartSeriesXml(element, 'bar')
    const lineSeries = chartSeriesXml(element, 'line')
    const lineAxis = hasSecondary ? '3' : '2'
    return `${XML_DECL}\n<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>`
      + (barSeries === '' ? '' : `<c:barChart><c:barDir val="col"/><c:grouping val="${element.stacked ? 'stacked' : 'clustered'}"/>`
        + `<c:varyColors val="0"/><c:overlap val="${element.stacked ? 100 : 0}"/>${barSeries}`
        + '<c:axId val="1"/><c:axId val="2"/></c:barChart>')
      + (lineSeries === '' ? '' : '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>'
        + `${lineSeries}<c:marker val="1"/><c:axId val="1"/><c:axId val="${lineAxis}"/></c:lineChart>`)
      + `${axes}</c:plotArea>${textProps}</c:chart></c:chartSpace>`
  }
  if (element.chart === 'line') {
    return `${XML_DECL}\n<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>`
      + `<c:lineChart><c:grouping val="${element.stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>${series}`
      + '<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
      + '<c:delete val="0"/><c:axPos val="b"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
      + '<c:delete val="0"/><c:axPos val="l"/></c:valAx>'
      + `</c:plotArea>${textProps}</c:chart></c:chartSpace>`
  }
  return `${XML_DECL}\n<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>`
    + `<c:barChart><c:barDir val="col"/><c:grouping val="${element.stacked ? 'stacked' : 'clustered'}"/>`
    + `<c:varyColors val="0"/><c:overlap val="${element.stacked ? 100 : 0}"/>${series}`
    + '<c:axId val="1"/><c:axId val="2"/></c:barChart>'
    + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
    + '<c:delete val="0"/><c:axPos val="b"/></c:catAx>'
    + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
    + '<c:delete val="0"/><c:axPos val="l"/></c:valAx>'
    + `</c:plotArea>${textProps}</c:chart></c:chartSpace>`
}

function chartFrame(element: PptChartElement, index: number, relId: string): string {
  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${index + 2}" name="Chart ${index + 2}"/><p:cNvGraphicFramePr/><p:nvPr/>`
    + '</p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${emu(element.x)}" y="${emu(element.y)}"/>`
    + `<a:ext cx="${emu(element.w)}" cy="${emu(element.h)}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${relId}"/>`
    + '</a:graphicData></a:graphic></p:graphicFrame>'
}

const EXPLICIT_PRESETS: Readonly<Record<string, {
  effect: string
  presetId: string
  presetClass: string
}>> = {
  pulse: {
    effect: '<p:animEffect transition="none" filter="pulse"><p:cBhvr><p:cTn id="{id}" dur="1000" repeatCount="2"/>'
      + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>',
    presetId: '30',
    presetClass: 'emph',
  },
  grow: {
    effect: '<p:animScale><p:cBhvr><p:cTn id="{id}" dur="500" autoRev="1"/><p:tgtEl><p:spTgt spid="{spid}"/>'
      + '</p:tgtEl></p:cBhvr><p:from x="100000" y="100000"/><p:to x="115000" y="115000"/></p:animScale>',
    presetId: '31',
    presetClass: 'emph',
  },
  'exit-fade': {
    effect: '<p:animEffect transition="out" filter="fade"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
      + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>',
    presetId: '10',
    presetClass: 'exit',
  },
  'exit-fly': {
    effect: '<p:animEffect transition="out" filter="slide(toRight)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
      + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>',
    presetId: '2',
    presetClass: 'exit',
  },
  'exit-zoom': {
    effect: '<p:animEffect transition="out" filter="zoom(out)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
      + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>',
    presetId: '23',
    presetClass: 'exit',
  },
  'exit-wipe': {
    effect: '<p:animEffect transition="out" filter="wipe(right)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
      + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>',
    presetId: '22',
    presetClass: 'exit',
  },
}

const PATHS: Readonly<Record<string, string>> = {
  right: 'M 0 0 L 0.25 0 E',
  left: 'M 0 0 L -0.25 0 E',
  up: 'M 0 0 L 0 -0.25 E',
  down: 'M 0 0 L 0 0.25 E',
}

const ANIMATION_PRESETS: Readonly<Record<string, { effect: string; presetId: string; subtype?: string }>> = {
  fade: { effect: '<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
    + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>', presetId: '10' },
  fly: { effect: '<p:animEffect transition="in" filter="slide(fromLeft)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
    + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>', presetId: '2' },
  zoom: { effect: '<p:animEffect transition="in" filter="zoom(in)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
    + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>', presetId: '23' },
  wipe: { effect: '<p:animEffect transition="in" filter="wipe(left)"><p:cBhvr><p:cTn id="{id}" dur="500"/>'
    + '<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>', presetId: '22' },
}

/**
 * 生成元素入场动画的 `<p:timing>`；没有动画时返回空串。
 * @param page - 页面。
 * @returns timing 段落。
 */
function timingXml(page: PptPage): string {
  const animated = page.elements
    .map((element, index) => ({ element, spid: index + 2 }))
    .filter((item): item is { element: PptElement; spid: number } => (
      (item.element.animation !== undefined && item.element.animation !== 'none')
      || (item.element.emphasis !== undefined && item.element.emphasis !== 'none')
      || (item.element.exitAnimation !== undefined && item.element.exitAnimation !== 'none')
      || (item.element.pathAnimation !== undefined && item.element.pathAnimation !== 'none')
    ))
  if (animated.length === 0) return ''
  let id = 1
  const effect = (body: string, presetId: string, presetClass: string): string => {
    const effectId = id
    id += 1
    const filled = body.replaceAll('{id}', String(effectId))
    return '<p:par><p:cTn id="' + String(id) + '" presetID="' + presetId + '" presetClass="' + presetClass + '"'
      + ' fill="hold" nodeType="withEffect">' + filled + '</p:cTn></p:par>'
  }
  const effects = animated.map(({ element, spid }) => {
    const parts: string[] = []
    const entrance = ANIMATION_PRESETS[element.animation ?? 'fade'] ?? ANIMATION_PRESETS['fade']
    if (entrance !== undefined) {
      parts.push(effect(entrance.effect.replaceAll('{spid}', String(spid)), entrance.presetId, 'entr'))
    }
    const path = element.pathAnimation === undefined ? undefined : PATHS[element.pathAnimation]
    if (path !== undefined) {
      const motion = '<p:animMotion path="' + path + '" pathEditMode="relative" origin="layout">'
        + '<p:cBhvr><p:cTn id="{id}" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>'
        + '</p:cBhvr></p:animMotion>'
      parts.push(effect(motion.replaceAll('{spid}', String(spid)), '0', 'path'))
    }
    const emphasis = element.emphasis === undefined ? undefined : EXPLICIT_PRESETS[element.emphasis]
    if (emphasis !== undefined) {
      parts.push(effect(emphasis.effect.replaceAll('{spid}', String(spid)), emphasis.presetId, emphasis.presetClass))
    }
    const exit = element.exitAnimation === undefined || element.exitAnimation === 'none'
      ? undefined
      : EXPLICIT_PRESETS[`exit-${element.exitAnimation}`]
    if (exit !== undefined) {
      parts.push(effect(exit.effect.replaceAll('{spid}', String(spid)), exit.presetId, exit.presetClass))
    }
    return parts.join('')
  })
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
    + '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
    + effects.join('')
    + '</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
}

function transitionXml(page: PptPage): string {
  if (page.transition === 'fade') return '<p:transition><p:fade/></p:transition>'
  if (page.transition === 'push') return '<p:transition><p:push dir="l"/></p:transition>'
  return ''
}

/**
 * 生成一页的 XML 与关系表。
 * @param deck - 演示文稿（取主题底色与占位色）。
 * @param page - 页面。
 * @param media - 该页图片的 `source → { relId, part }` 映射。
 * @returns slide XML 与关系条目。
 */
function slideXml(
  deck: PptDeck,
  page: PptPage,
  media: ReadonlyMap<string, { relId: string; part: string }>,
  charts: { next: () => { relId: string; part: string } },
  cjkOf: CjkLookup,
): { xml: string; items: string[]; chartParts: { part: string; xml: string }[] } {
  const theme = PPT_THEMES[deck.theme]
  const background = page.background ?? theme.background
  const items: string[] = [relationship('rId1', LAYOUT_REL, '../slideLayouts/slideLayout1.xml')]
  const chartParts: { part: string; xml: string }[] = []
  const shapes = page.elements.map((element, index) => {
    if (element.kind === 'chart') {
      const { relId, part } = charts.next()
      chartParts.push({ part, xml: chartXml(element) })
      items.push(relationship(
        relId,
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
        `../charts/${part.split('/').pop() ?? part}`,
      ))
      return chartFrame(element, index, relId)
    }
    if (element.kind === 'line') return line(element, index)
    if (element.kind === 'table') return table(element, index, background, cjkOf)
    if (element.kind === 'image') {
      const rel = media.get(element.source)
      if (rel === undefined) {
        return shape({
          id: element.id, kind: 'rect', x: element.x, y: element.y,
          w: element.w, h: element.h, fill: theme.surface,
        }, index, cjkOf)
      }
      const fileName = rel.part.slice('ppt/media/'.length)
      items.push(relationship(rel.relId, IMAGE_REL, `../media/${fileName}`))
      return picture(element, index, rel.relId)
    }
    return shape(element, index, cjkOf)
  }).join('')
  return {
    xml: `${XML_DECL}\n<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill>`
      + `<a:srgbClr val="${srgb(background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
      + `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`
      + `</p:cSld>${transitionXml(page)}${timingXml(page)}`
      + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    items,
    chartParts,
  }
}

function themeXml(deck: PptDeck): string {
  const palette = PPT_THEMES[deck.theme]
  const colors = [
    ['dk1', srgb(palette.text)], ['lt1', srgb(palette.background)],
    ['dk2', srgb(palette.text)], ['lt2', srgb(palette.surface)],
    ['accent1', srgb(palette.accent)], ['accent2', '4472C4'], ['accent3', 'ED7D31'],
    ['accent4', 'A5A5A5'], ['accent5', 'FFC000'], ['accent6', '70AD47'],
    ['hlink', srgb(palette.accent)], ['folHlink', '954F72'],
  ].map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const lineStyle = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  // 主题字体就是默认黑体：空 font 的 run 走 `+mn-lt`／`+mn-ea`，落到的也是黑体。
  const themeFont = escapeXml(DEFAULT_FONT_FAMILY)
  return `${XML_DECL}\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PPT">`
    + `<a:themeElements><a:clrScheme name="PPT">${colors}</a:clrScheme>`
    + `<a:fontScheme name="PPT"><a:majorFont><a:latin typeface="${themeFont}"/>`
    + `<a:ea typeface="${themeFont}"/><a:cs typeface="${themeFont}"/></a:majorFont>`
    + `<a:minorFont><a:latin typeface="${themeFont}"/><a:ea typeface="${themeFont}"/>`
    + `<a:cs typeface="${themeFont}"/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="PPT"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>`
    + `<a:lnStyleLst>${lineStyle}${lineStyle}${lineStyle}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
    + '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>'
    + '</a:effectStyleLst>'
    + `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements>`
    + '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
}

function masterXml(): string {
  const style = (tag: string, size: number): string => `<p:${tag}><a:lvl1pPr><a:defRPr sz="${size}"/>`
    + '</a:lvl1pPr></p:' + tag + '>'
  return `${XML_DECL}\n<p:sldMaster ${NS}><p:cSld>`
    + '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
    + `${emptyTree()}</p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
    + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"'
    + ' hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + `<p:txStyles>${style('titleStyle', 3200)}${style('bodyStyle', 1800)}${style('otherStyle', 1800)}`
    + '</p:txStyles></p:sldMaster>'
}

function layoutXml(): string {
  return `${XML_DECL}\n<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="空白">`
    + `${emptyTree()}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}

function presentationXml(deck: PptDeck, fonts: readonly PptxFont[]): string {
  const size = SLIDE_SIZES[deck.size]
  const ids = deck.pages.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  const embedded = fonts.length === 0 ? '' : '<p:embeddedFontLst>'
    + fonts.map((font, index) => '<p:embeddedFont><p:font typeface="' + escapeXml(font.family) + '" charset="0"/>'
      + `<p:regular r:id="rId${deck.pages.length + 3 + index}"/></p:embeddedFont>`).join('')
    + '</p:embeddedFontLst>'
  return `${XML_DECL}\n<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${ids}</p:sldIdLst>`
    + `<p:sldSz cx="${emu(size.width)}" cy="${emu(size.height)}"/>`
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + embedded
    + '<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>'
    + '</p:presentation>'
}

function contentTypes(pages: number, media: readonly MediaRef[], charts: number, fonts: number): string {
  const slides = Array.from({ length: pages }, (_, index) => (
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="${CONTENT_TYPES}.presentationml.slide+xml"/>`
  )).join('')
  const defaults = [...new Set(media.map(entry => entry.ext))]
    .map(ext => `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext] ?? 'image/png'}"/>`).join('')
  return `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + defaults
    + (fonts > 0 ? '<Default Extension="fntdata" ContentType="application/x-fontdata"/>' : '')
    + `<Override PartName="/ppt/presentation.xml" ContentType="${CONTENT_TYPES}.presentationml.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CONTENT_TYPES}.presentationml.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CONTENT_TYPES}.presentationml.slideLayout+xml"/>`
    + `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CONTENT_TYPES}.theme+xml"/>`
    + Array.from({ length: charts }, (_, index) => (
      `<Override PartName="/ppt/charts/chart${index + 1}.xml" `
      + `ContentType="${CONTENT_TYPES}.drawingml.chart+xml"/>`
    )).join('')
    + `${slides}</Types>`
}

function chartCount(deck: PptDeck): number {
  return deck.pages.reduce(
    (sum, page) => sum + page.elements.filter(element => element.kind === 'chart').length,
    0,
  )
}

function packageRels(): string {
  return rels([relationship('rId1', OFFICE_DOCUMENT_REL, 'ppt/presentation.xml')])
}

function presentationRels(pages: number, fonts: readonly PptxFont[]): string {
  const slides = Array.from({ length: pages }, (_, index) => (
    relationship(`rId${index + 2}`, SLIDE_REL, `slides/slide${index + 1}.xml`)
  )).join('')
  const fontRels = fonts.map((font, index) => relationship(
    `rId${pages + 3 + index}`,
    FONT_REL,
    `fonts/${font.part.split('/').pop() ?? font.part}`,
  )).join('')
  return rels([
    relationship('rId1', MASTER_REL, 'slideMasters/slideMaster1.xml'),
    slides,
    relationship(`rId${pages + 2}`, THEME_REL, 'theme/theme1.xml'),
    fontRels,
  ])
}

/**
 * 收集要嵌入的图片，按首次出现的顺序编号。
 * @param deck - 演示文稿。
 * @param options - 媒体读取器。
 * @returns 媒体部件列表（同一 source 只出现一次）。
 */
function collectMedia(deck: PptDeck, options: PptxOptions): MediaRef[] {
  const collected: MediaRef[] = []
  const seen = new Set<string>()
  for (const page of deck.pages) {
    for (const element of page.elements) {
      if (element.kind !== 'image' || seen.has(element.source) || options.media === undefined) continue
      const bytes = options.media(element.source)
      if (bytes === undefined) continue
      seen.add(element.source)
      const ext = extensionOf(element.source)
      collected.push({ source: element.source, part: `ppt/media/image${collected.length + 1}.${ext}`, ext, bytes })
    }
  }
  return collected
}

/**
 * 生成 .pptx 字节。
 * @param deck - 已校验的演示文稿。
 * @param options - 可选的图片字节读取器；缺省时图片元素退化为占位框。
 * @returns 可直接写盘的 .pptx 内容。
 */
export function buildPptx(deck: PptDeck, options: PptxOptions = {}): Uint8Array {
  const encoder = new TextEncoder()
  const fonts = options.fonts ?? []
  const cjkOf: CjkLookup = new Map(fonts.map(font => [font.family, font.cjk]))
  const media = collectMedia(deck, options)
  const byPart = new Map<string, MediaRef>()
  for (const entry of media) byPart.set(entry.part, entry)
  const partOf = new Map(media.map(entry => [entry.source, entry.part]))
  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      data: encoder.encode(contentTypes(deck.pages.length, media, chartCount(deck), fonts.length)),
    },
    { path: '_rels/.rels', data: encoder.encode(packageRels()) },
    { path: 'ppt/presentation.xml', data: encoder.encode(presentationXml(deck, fonts)) },
    { path: 'ppt/_rels/presentation.xml.rels', data: encoder.encode(presentationRels(deck.pages.length, fonts)) },
    { path: 'ppt/slideMasters/slideMaster1.xml', data: encoder.encode(masterXml()) },
    {
      path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: encoder.encode(rels([
        relationship('rId1', LAYOUT_REL, '../slideLayouts/slideLayout1.xml'),
        relationship('rId2', THEME_REL, '../theme/theme1.xml'),
      ])),
    },
    { path: 'ppt/slideLayouts/slideLayout1.xml', data: encoder.encode(layoutXml()) },
    {
      path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: encoder.encode(rels([relationship('rId1', MASTER_REL, '../slideMasters/slideMaster1.xml')])),
    },
    { path: 'ppt/theme/theme1.xml', data: encoder.encode(themeXml(deck)) },
  ]
  const chartParts: { part: string; xml: string }[] = []
  let chartSeq = 0
  const charts = {
    next: () => {
      chartSeq += 1
      return { relId: `rIdC${chartSeq}`, part: `ppt/charts/chart${chartSeq}.xml` }
    },
  }
  deck.pages.forEach((page, index) => {
    const used = new Map<string, { relId: string; part: string }>()
    for (const element of page.elements) {
      if (element.kind !== 'image' || used.has(element.source)) continue
      const part = partOf.get(element.source)
      if (part === undefined || !byPart.has(part)) continue
      used.set(element.source, { relId: `rId${used.size + 2}`, part })
    }
    const slide = slideXml(deck, page, used, charts, cjkOf)
    chartParts.push(...slide.chartParts)
    entries.push({ path: `ppt/slides/slide${index + 1}.xml`, data: encoder.encode(slide.xml) })
    entries.push({ path: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: encoder.encode(rels(slide.items)) })
  })
  for (const chart of chartParts) {
    entries.push({ path: chart.part, data: encoder.encode(chart.xml) })
    entries.push({ path: `ppt/charts/_rels/${chart.part.split('/').pop() ?? 'chart'}.rels`, data: encoder.encode(rels([])) })
  }
  for (const entry of media) entries.push({ path: entry.part, data: entry.bytes })
  for (const font of fonts) entries.push({ path: font.part, data: font.bytes })
  return zip(entries)
}
