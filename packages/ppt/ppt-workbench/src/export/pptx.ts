/**
 * 把一份工程导出成 .pptx：每页对应一张 slide，元素转成 DrawingML 的文本框、预设形状、
 * 连接线、图片与表格，页面转场写成 `<p:transition>`。
 *
 * 这里生成的是 PowerPoint / Keynote / WPS 都能打开的最小 OPC 包：只写模型拥有的东西，
 * 不做母版设计、动画与字体嵌入。图片字节由调用方经 `media` 读取器提供，导出本身不碰
 * 文件系统，测试与其它载体可以喂自己的实现。
 * @module coding-ppt-workbench/export/pptx
 */

import {
  PPT_THEMES, SLIDE_SIZES,
  type PptDeck, type PptElement, type PptImageElement, type PptPage, type PptTableElement,
} from 'coding-ppt-model'
import { zip, type ZipEntry } from './zip.ts'

/** 1 个基准像素对应的 EMU（96 DPI）。 */
const EMU_PER_PX = 9525

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const MASTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster'
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const THEME_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
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

/** 导出时可选的媒体读取器。 */
export interface PptxOptions {
  /**
   * 读取图片字节。
   * @param source - 工程内 `media/<file>` 相对路径。
   * @returns 图片字节；缺失时该元素退化成主题色占位框。
   */
  readonly media?: (source: string) => Uint8Array | undefined
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

function textBody(element: Extract<PptElement, { kind: 'text' }>): string {
  const { text } = element
  const anchor = text.valign === 'middle' ? 'ctr' : text.valign === 'bottom' ? 'b' : 't'
  const align = text.align === 'center' ? 'ctr' : text.align === 'right' ? 'r' : 'l'
  const paragraphs = text.content.split('\n').map((line) => {
    const paragraphProps = `<a:pPr algn="${align}"/>`
    if (line === '') return `<a:p>${paragraphProps}</a:p>`
    const runProps = `<a:rPr lang="zh-CN" altLang="en-US" sz="${Math.round(text.size * 75)}"`
      + `${text.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${srgb(text.color)}"/>`
      + '</a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:rPr>'
    return `<a:p>${paragraphProps}<a:r>${runProps}<a:t>${escapeXml(line)}</a:t></a:r></a:p>`
  })
  return '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"'
    + ` anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs.join('')}</p:txBody>`
}

type BoxElement = Extract<PptElement, { kind: 'text' | 'rect' | 'ellipse' }>

function shape(element: BoxElement, index: number): string {
  const name = `Shape ${index + 2}`
  if (element.kind === 'text') {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="${escapeXml(name)}"/>`
      + '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
      + `<p:spPr>${xfrm(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
      + '<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>'
      + `${textBody(element)}</p:sp>`
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
    + '<p:cNvCxnSpPr/><p:nvPr/></p:cNvCxnSpPr>'
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

function tableCell(content: string, style: PptTableElement['text'], fill: string): string {
  const align = style.align === 'center' ? 'ctr' : style.align === 'right' ? 'r' : 'l'
  const paragraph = content === ''
    ? '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'
    : `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(style.size * 75)}"`
      + `${style.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${srgb(style.color)}"/>`
      + `</a:solidFill></a:rPr><a:t>${escapeXml(content)}</a:t></a:r></a:p>`
  return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>'
    + `${paragraph}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">`
    + `<a:solidFill><a:srgbClr val="${srgb(fill)}"/></a:solidFill></a:tcPr></a:tc>`
}

function table(element: PptTableElement, index: number, pageBackground: string): string {
  const total = element.columnWeights.reduce((sum, weight) => sum + weight, 0)
  const columns = element.columnWeights.map(weight => Math.max(1, Math.round(element.w * weight / total)))
  const rowHeight = Math.max(1, Math.round(element.h / element.rows))
  const grid = columns.map(width => `<a:gridCol w="${emu(width)}"/>`).join('')
  const rows = element.cells.map((row, rowIndex) => {
    const fill = element.header && rowIndex === 0 ? element.headerFill : pageBackground
    const cells = row.map(cell => tableCell(cell.content, element.text, fill)).join('')
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
): { xml: string; items: string[] } {
  const theme = PPT_THEMES[deck.theme]
  const background = page.background ?? theme.background
  const items: string[] = [relationship('rId1', LAYOUT_REL, '../slideLayouts/slideLayout1.xml')]
  const shapes = page.elements.map((element, index) => {
    if (element.kind === 'line') return line(element, index)
    if (element.kind === 'table') return table(element, index, background)
    if (element.kind === 'image') {
      const rel = media.get(element.source)
      if (rel === undefined) {
        return shape({
          id: element.id, kind: 'rect', x: element.x, y: element.y,
          w: element.w, h: element.h, fill: theme.surface,
        }, index)
      }
      const fileName = rel.part.slice('ppt/media/'.length)
      items.push(relationship(rel.relId, IMAGE_REL, `../media/${fileName}`))
      return picture(element, index, rel.relId)
    }
    return shape(element, index)
  }).join('')
  return {
    xml: `${XML_DECL}\n<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill>`
      + `<a:srgbClr val="${srgb(background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
      + `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`
      + `</p:cSld>${transitionXml(page)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    items,
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
  return `${XML_DECL}\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PPT">`
    + `<a:themeElements><a:clrScheme name="PPT">${colors}</a:clrScheme>`
    + '<a:fontScheme name="PPT"><a:majorFont><a:latin typeface="Calibri Light"/>'
    + '<a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>'
    + '</a:minorFont></a:fontScheme>'
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

function presentationXml(deck: PptDeck): string {
  const size = SLIDE_SIZES[deck.size]
  const ids = deck.pages.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return `${XML_DECL}\n<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${ids}</p:sldIdLst>`
    + `<p:sldSz cx="${emu(size.width)}" cy="${emu(size.height)}"/>`
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + '<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>'
    + '</p:presentation>'
}

function contentTypes(pages: number, media: readonly MediaRef[]): string {
  const slides = Array.from({ length: pages }, (_, index) => (
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="${CONTENT_TYPES}.presentationml.slide+xml"/>`
  )).join('')
  const defaults = [...new Set(media.map(entry => entry.ext))]
    .map(ext => `<Default Extension="${ext}" ContentType="${MEDIA_TYPES[ext] ?? 'image/png'}"/>`).join('')
  return `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + defaults
    + `<Override PartName="/ppt/presentation.xml" ContentType="${CONTENT_TYPES}.presentationml.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CONTENT_TYPES}.presentationml.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CONTENT_TYPES}.presentationml.slideLayout+xml"/>`
    + `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CONTENT_TYPES}.theme+xml"/>`
    + `${slides}</Types>`
}

function packageRels(): string {
  return rels([relationship('rId1', `${CONTENT_TYPES}.presentationml.presentation.main+xml`, 'ppt/presentation.xml')])
}

function presentationRels(pages: number): string {
  const slides = Array.from({ length: pages }, (_, index) => (
    relationship(`rId${index + 2}`, SLIDE_REL, `slides/slide${index + 1}.xml`)
  )).join('')
  return rels([
    relationship('rId1', MASTER_REL, 'slideMasters/slideMaster1.xml'),
    slides,
    relationship(`rId${pages + 2}`, THEME_REL, 'theme/theme1.xml'),
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
  const media = collectMedia(deck, options)
  const byPart = new Map<string, MediaRef>()
  for (const entry of media) byPart.set(entry.part, entry)
  const partOf = new Map(media.map(entry => [entry.source, entry.part]))
  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: encoder.encode(contentTypes(deck.pages.length, media)) },
    { path: '_rels/.rels', data: encoder.encode(packageRels()) },
    { path: 'ppt/presentation.xml', data: encoder.encode(presentationXml(deck)) },
    { path: 'ppt/_rels/presentation.xml.rels', data: encoder.encode(presentationRels(deck.pages.length)) },
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
  deck.pages.forEach((page, index) => {
    const used = new Map<string, { relId: string; part: string }>()
    for (const element of page.elements) {
      if (element.kind !== 'image' || used.has(element.source)) continue
      const part = partOf.get(element.source)
      if (part === undefined || !byPart.has(part)) continue
      used.set(element.source, { relId: `rId${used.size + 2}`, part })
    }
    const slide = slideXml(deck, page, used)
    entries.push({ path: `ppt/slides/slide${index + 1}.xml`, data: encoder.encode(slide.xml) })
    entries.push({ path: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: encoder.encode(rels(slide.items)) })
  })
  for (const entry of media) entries.push({ path: entry.part, data: entry.bytes })
  return zip(entries)
}
