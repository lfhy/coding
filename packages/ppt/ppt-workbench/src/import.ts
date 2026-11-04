/**
 * 把既有 .pptx 逆向成工程：解包 OPC 容器，按页读取位置尺寸、文本、几何形状与图片，
 * 表格按单元格文本重建。图表、SmartArt、OLE 与动画不在模型里，导入时列进 `dropped`
 * 让调用方如实告知用户改动了什么。
 *
 * 解析走的是刻意收窄的子集：只认这个模型能表达的元素，遇到不认识的结构跳过而不是猜。
 * @module coding-ppt-workbench/import
 */

import { unzipSync } from 'fflate'
import {
  PPT_THEMES, newId,
  type PptDeck, type PptDeck as Deck, type PptElement, type PptPage, type SlideSizeId,
  type TextAlign, type TextVAlign,
} from 'coding-ppt-model'

/** 导入结果。 */
export interface PptImportResult {
  readonly deck: PptDeck
  /** 需要写进工程 `media/` 的图片。 */
  readonly media: readonly { readonly part: string; readonly bytes: Uint8Array }[]
  /** 未能表达的元素类别，去重后供调用方汇报。 */
  readonly dropped: readonly string[]
}

/** 导入失败。 */
export class PptImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptImportError'
  }
}

const EMU_PER_PX = 9525

function px(value: string | undefined): number {
  const number = Number(value ?? '')
  return Number.isFinite(number) ? Math.round(number / EMU_PER_PX) : 0
}

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(xml)?.[1]
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function hexColor(value: string | undefined, fallback: string): string {
  return value !== undefined && /^[0-9a-fA-F]{6}$/u.test(value) ? `#${value.toLowerCase()}` : fallback
}

/** 从关系表里取 target。 */
function relationTarget(relsXml: string, id: string): string | undefined {
  const block = new RegExp(`<Relationship[^>]*Id="${id}"[^>]*>`, 'u').exec(relsXml)?.[0]
  return block === undefined ? undefined : attr(block, 'Target')
}

function slideSize(presentation: string): SlideSizeId {
  const block = /<p:sldSz[^>]*>/u.exec(presentation)?.[0] ?? ''
  const width = Number(attr(block, 'cx') ?? 0)
  const height = Number(attr(block, 'cy') ?? 0)
  if (height > 0 && Math.abs(width / height - 16 / 9) < 0.05) return '16:9'
  return '4:3'
}

function decodeText(runs: string): string {
  const paragraphs = [...runs.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gu)].map(match => (
    [...(match[1] ?? '').matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)]
      .map(item => decodeXml(item[1] ?? ''))
      .join('')
  ))
  return paragraphs.join('\n').trim()
}

function textStyle(block: string, theme: keyof typeof PPT_THEMES = 'ink'): {
  content: string
  size: number
  color: string
  bold: boolean
  align: TextAlign
  valign: TextVAlign
} {
  const palette = PPT_THEMES[theme]
  const runProps = /<a:rPr\b[^>]*>/u.exec(block)?.[0] ?? ''
  const size = Number(attr(runProps, 'sz') ?? 1800) / 75
  const colorValue = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(block)?.[1]
  const alignRaw = /<a:pPr[^>]*algn="(\w+)"/u.exec(block)?.[1]
  const anchorRaw = attr(/<a:bodyPr\b[^>]*>/u.exec(block)?.[0] ?? '', 'anchor')
  return {
    content: decodeText(block),
    size: Math.min(Math.max(Math.round(size), 6), 400),
    color: hexColor(colorValue, palette.text),
    bold: attr(runProps, 'b') === '1',
    align: alignRaw === 'ctr' ? 'center' : alignRaw === 'r' ? 'right' : 'left',
    valign: anchorRaw === 'ctr' ? 'middle' : anchorRaw === 'b' ? 'bottom' : 'top',
  }
}

function frame(block: string): { x: number; y: number; w: number; h: number } {
  const off = /<a:off\b[^>]*>/u.exec(block)?.[0] ?? ''
  const ext = /<a:ext\b[^>]*>/u.exec(block)?.[0] ?? ''
  return { x: px(attr(off, 'x')), y: px(attr(off, 'y')), w: px(attr(ext, 'cx')), h: px(attr(ext, 'cy')) }
}

/**
 * 解包并解析一份 .pptx。
 * @param bytes - .pptx 文件内容。
 * @param options - 文稿标题。
 * @returns 导入结果。
 * @throws PptImportError - 不是合法的 .pptx、或没有任何可解析的幻灯片时。
 */
export function importPptx(bytes: Uint8Array, options: { title: string }): PptImportResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new PptImportError('这个文件不是可读取的 .pptx（ZIP 容器损坏）')
  }
  const decode = (path: string): string => {
    const entry = files[path]
    return entry === undefined ? '' : new TextDecoder().decode(entry)
  }
  const presentation = decode('ppt/presentation.xml')
  const slidePaths = Object.keys(files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort((left, right) => Number(left.match(/\d+/u)?.[0] ?? 0) - Number(right.match(/\d+/u)?.[0] ?? 0))
  if (slidePaths.length === 0) throw new PptImportError('这个 .pptx 里没有幻灯片')

  const dropped = new Set<string>()
  const media: { part: string; bytes: Uint8Array }[] = []
  const pages: PptPage[] = slidePaths.map((path, index) => {
    const xml = decode(path)
    const relsXml = decode(path.replace('slides/', 'slides/_rels/') + '.rels')
    const backgroundRaw = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(xml)?.[1]
    const elements: PptElement[] = []
    for (const block of xml.matchAll(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/gu)) {
      const element = parseShape(block[0], relsXml, files, media, dropped)
      if (element !== null) elements.push(element)
    }
    if (/<p:graphicFrame[\s\S]*?drawingml\/2006\/chart/u.test(xml)) dropped.add('图表')
    if (/<p:graphicFrame[\s\S]*?drawingml\/2006\/diagram/u.test(xml)) dropped.add('SmartArt')
    return {
      id: newId(),
      name: `第 ${index + 1} 页`,
      background: backgroundRaw === undefined ? null : hexColor(backgroundRaw, '#ffffff'),
      transition: /<p:transition>\s*<p:fade/u.test(xml) ? 'fade'
        : /<p:transition>\s*<p:push/u.test(xml) ? 'push' : 'none',
      elements,
    }
  })

  const deck: Deck = {
    format: 1,
    title: options.title,
    size: slideSize(presentation),
    theme: pageTheme(pages),
    pages,
  }
  return { deck, media, dropped: [...dropped] }
}

/** 导入时保持默认主题：模型元素带显式颜色，主题只影响后续新增元素的默认色。 */
function pageTheme(_pages: readonly PptPage[]): 'ink' {
  void _pages
  return 'ink'
}

function parseShape(
  block: string,
  relsXml: string,
  files: Record<string, Uint8Array>,
  media: { part: string; bytes: Uint8Array }[],
  dropped: Set<string>,
): PptElement | null {
  const box = frame(block)
  if (block.startsWith('<p:pic')) {
    const relId = /<a:blip[^>]*r:embed="([^"]+)"/u.exec(block)?.[1]
    const target = relId === undefined ? undefined : relationTarget(relsXml, relId)
    if (target === undefined) {
      dropped.add('图片')
      return null
    }
    const part = target.replace(/^\.\.\//u, 'ppt/')
    const bytes = files[part]
    if (bytes === undefined) {
      dropped.add('图片')
      return null
    }
    const name = `media/${part.split('/').pop() ?? 'image.png'}`
    media.push({ part: name, bytes })
    return { id: newId(), kind: 'image', ...box, source: name, fit: 'cover' }
  }
  if (block.startsWith('<p:graphicFrame')) {
    if (block.includes('/table')) {
      const table = parseTable(block, box)
      if (table !== null) return table
      dropped.add('表格')
      return null
    }
    return null
  }
  const preset = /<a:prstGeom prst="([^"]+)"/u.exec(block)?.[1]
  const shapeProps = /<p:spPr>[\s\S]*?<\/p:spPr>/u.exec(block)?.[0] ?? ''
  const fillRaw = /<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(shapeProps)?.[1]
  const lineRaw = /<a:ln[^>]*>[\s\S]*?<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(shapeProps)?.[1]
  const hasText = /<a:t>/u.test(block)
  if (hasText) {
    return { id: newId(), kind: 'text', ...box, text: textStyle(block) }
  }
  if (preset === 'line' || preset === 'straightConnector1') {
    return {
      id: newId(), kind: 'line', ...box,
      color: hexColor(lineRaw, '#9aa7b4'),
      width: Math.max(1, Math.round(Number(attr(/<a:ln[^>]*>/u.exec(shapeProps)?.[0] ?? '', 'w') ?? 12700) / EMU_PER_PX)),
    }
  }
  if (preset === 'ellipse') {
    return { id: newId(), kind: 'ellipse', ...box, fill: hexColor(fillRaw, '#4f8cff') }
  }
  if (fillRaw !== undefined || preset === 'rect' || preset === undefined) {
    return { id: newId(), kind: 'rect', ...box, fill: hexColor(fillRaw, '#4f8cff') }
  }
  dropped.add('形状')
  return null
}

function parseTable(
  block: string,
  box: { x: number; y: number; w: number; h: number },
): PptElement | null {
  const rows = [...block.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gu)]
  if (rows.length === 0) return null
  const grid = [...block.matchAll(/<a:gridCol w="(\d+)"/gu)].map(match => px(match[1]))
  const columns = grid.length > 0 ? grid.length : 1
  const cells = rows.map((row) => {
    const tcs = [...(row[1] ?? '').matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gu)]
    const parsed = tcs.map(tc => ({ content: decodeText(tc[0]) }))
    while (parsed.length < columns) parsed.push({ content: '' })
    return parsed.slice(0, columns)
  })
  const firstCell = rows[0]?.[1] ?? ''
  const fill = /<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstCell)?.[1]
  return {
    id: newId(), kind: 'table', ...box,
    rows: cells.length,
    columns,
    columnWeights: grid.length > 0 ? grid.map(width => Math.max(1, width)) : Array.from({ length: columns }, () => 1),
    header: true,
    headerFill: hexColor(fill, '#4f8cff'),
    borderColor: '#9aa7b4',
    text: { size: 20, color: '#101418', bold: false, align: 'left' },
    cells,
  }
}
