/**
 * 把既有 .pptx 逆向成工程：解包 OPC 容器，按页读取位置尺寸、文本、几何形状与图片，
 * 表格按单元格文本重建。图表、SmartArt、OLE 与动画不在模型里，导入时列进 `dropped`
 * 让调用方如实告知用户改动了什么。
 *
 * 解析走的是刻意收窄的子集：只认这个模型能表达的元素，遇到不认识的结构跳过而不是猜。
 * @module coding-ppt-workbench/import
 */

import { Unzip, UnzipInflate } from 'fflate'
import {
  PPT_THEMES, SLIDE_SIZES, PptModelError, newId, parseDeck,
  type PptDeck, type PptDeck as Deck, type PptElement, type PptPage, type SlideSizeId,
  type TextAlign, type TextVAlign,
} from 'coding-ppt-model'
import { axisAlignedCustomPath } from './custom-path.ts'
import { crc32 } from './export/zip.ts'
import { sourceDesign, type SourceDesign } from './source-design.ts'

/** 导入结果。 */
export interface PptImportResult {
  readonly deck: PptDeck
  /** 需要写进工程 `media/` 的图片。 */
  readonly media: readonly { readonly part: string; readonly bytes: Uint8Array }[]
  /** 未能表达的元素类别，去重后供调用方汇报。 */
  readonly dropped: readonly string[]
  /** 按源幻灯片顺序记录的结构保留情况；不代表视觉样式保真。 */
  readonly report: PptImportReport
}

/** 导入不能保留的页内对象种类。 */
export type PptPageLoss = 'chart' | 'diagram' | 'group' | 'table' | 'image' | 'text' | 'shape' | 'object'

/** 源页及导入页的逐页结构对照。 */
export interface PptImportReport {
  readonly sourceSlides: number
  readonly importedPages: number
  readonly pages: readonly {
    readonly sourceIndex: number
    readonly pageId: string
    readonly slidePart: string
    readonly source: Readonly<{ text: number; image: number; table: number; chart: number; diagram: number; other: number }>
    readonly imported: Readonly<{ text: number; image: number; table: number; chart: number }>
    readonly status: 'no_known_loss' | 'image_only' | 'empty_source' | 'empty_import' | 'partial'
    readonly losses: readonly PptPageLoss[]
    readonly textPreview: readonly string[]
    readonly truncated: boolean
  }[]
}

/** 有界、可按偏移续读的源页 XML 证据片段。 */
export interface PptPageEvidenceChunk {
  readonly sourceIndex: number
  readonly content: string
  readonly totalChars: number
  readonly nextOffset: number | null
}

/** 导入失败。 */
export class PptImportError extends PptModelError {
  constructor(message: string) {
    super(message)
    this.name = 'PptImportError'
  }
}

/** 导入文件的压缩体上限；服务层可复用此准入预算。 */
export const PPT_IMPORT_MAX_BYTES = 8 * 1024 * 1024
const MAX_UNPACKED = 64 * 1024 * 1024
const MAX_XML = 4 * 1024 * 1024
const MAX_MEDIA = 8 * 1024 * 1024
const MAX_ENTRIES = 1000
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

function bad(message: string): never {
  throw new PptImportError(message)
}

function validPath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.includes('\\')
    && !/[\u0000-\u001f\u007f:%?#]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

interface ZipMember { readonly crc: number; readonly method: number; readonly size: number }

/** 先核对中央目录和本地头，避免流解包器忽略伪造条目或静默接纳坏 ZIP。 */
function zipDirectory(bytes: Uint8Array): Map<string, ZipMember> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos -= 1) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) {
      end = pos
      break
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
    || view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)) bad('ZIP 目录损坏或包含多磁盘分卷')
  const count = view.getUint16(end + 10, true)
  if (count > MAX_ENTRIES) bad(`.pptx 条目不能超过 ${MAX_ENTRIES} 个`)
  const size = view.getUint32(end + 12, true)
  let pos = view.getUint32(end + 16, true)
  if (pos + size !== end) bad('ZIP 中央目录损坏')
  const files = new Map<string, ZipMember>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) bad('ZIP 中央目录条目损坏')
    const flags = view.getUint16(pos + 8, true)
    const method = view.getUint16(pos + 10, true)
    const nameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    const next = pos + 46 + nameLength + extraLength + commentLength
    const local = view.getUint32(pos + 42, true)
    if (next > end || local + 30 > pos || view.getUint32(local, true) !== 0x04034b50
      || view.getUint16(pos + 34, true) !== 0 || view.getUint32(pos + 20, true) === 0xffffffff
      || view.getUint32(pos + 24, true) === 0xffffffff || local === 0xffffffff
      || (flags & ~(method === 8 ? 0x080e : 0x0808)) !== 0 || (method !== 0 && method !== 8)
      || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method
      || view.getUint16(local + 26, true) !== nameLength) bad('ZIP 条目使用不支持的压缩方式或头部损坏')
    let name: string
    try { name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)) }
    catch { bad('ZIP 文件名不是 UTF-8') }
    const localName = bytes.subarray(local + 30, local + 30 + nameLength)
    if (!validPath(name.endsWith('/') ? name.slice(0, -1) : name) || local + 30 + nameLength > pos
      || !localName.every((byte, index) => byte === bytes[pos + 46 + index]) || files.has(name)) {
      bad('ZIP 包含非法路径或重复条目')
    }
    if (/\.(?:pptm|vbaProject\.bin)$/iu.test(name) || /(^|\/)vbaProject\.bin$/iu.test(name)) bad('不支持带宏的演示文稿')
    files.set(name, { crc: view.getUint32(pos + 16, true), method, size: view.getUint32(pos + 24, true) })
    pos = next
  }
  if (pos !== end) bad('ZIP 中央目录条目数不一致')
  return files
}

function unpack(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > PPT_IMPORT_MAX_BYTES) bad('PPTX 文件不能超过 8 MiB')
  if (bytes.length < 22) bad('这个文件不是可读取的 .pptx（ZIP 容器损坏）')
  const directory = zipDirectory(bytes)
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  const seen = new Set<string>()
  let total = 0
  let failure: PptImportError | undefined
  const unzip = new Unzip((file) => {
    const member = directory.get(file.name)
    if (member === undefined || seen.has(file.name) || file.compression !== member.method) bad('ZIP 条目与目录不一致')
    seen.add(file.name)
    const isXml = file.name.endsWith('.xml') || file.name.endsWith('.rels')
    const limit = isXml ? MAX_XML : MAX_MEDIA
    let length = 0
    const chunks: Uint8Array[] = []
    file.ondata = (error, chunk, final) => {
      if (failure !== undefined) return
      if (error) { failure = new PptImportError('ZIP 条目解压失败'); return }
      length += chunk.length
      total += chunk.length
      if (length > limit || total > MAX_UNPACKED) {
        failure = new PptImportError('PPTX 解压内容超出安全预算')
        return
      }
      chunks.push(chunk)
      if (final) {
        const data = new Uint8Array(length)
        let offset = 0
        for (const piece of chunks) { data.set(piece, offset); offset += piece.length }
        if (length !== member.size || crc32(data) !== member.crc) {
          failure = new PptImportError('ZIP 条目校验失败')
          return
        }
        files[file.name] = data
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
      if (failure !== undefined) throw failure
    }
  } catch (error) {
    if (error instanceof PptImportError) throw error
    bad('这个文件不是可读取的 .pptx（ZIP 容器损坏）')
  }
  if (seen.size !== directory.size || Object.keys(files).length !== directory.size) bad('ZIP 条目缺失或损坏')
  return files
}

interface Relationship { readonly type: string; readonly target: string }

function resolvePart(source: string, target: string): string {
  if (target.includes('\\') || /[\u0000-\u001f\u007f:%?#]/u.test(target)) bad('PPTX 关系目标路径不安全')
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1)
  for (const segment of (target.startsWith('/') ? target.slice(1) : target).split('/')) {
    if (segment === '..') {
      if (segments.length === 0) bad('PPTX 关系目标越出包根目录')
      segments.pop()
    } else if (segment !== '.') {
      if (segment === '') bad('PPTX 关系目标路径不安全')
      segments.push(segment)
    }
  }
  const path = segments.join('/')
  if (!validPath(path)) bad('PPTX 关系目标路径不安全')
  return path
}

function relationships(xml: string, source: string): Map<string, Relationship> {
  const result = new Map<string, Relationship>()
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)) {
    const tag = match[1] ?? ''
    const id = attr(tag, 'Id')
    const type = attr(tag, 'Type')
    const target = attr(tag, 'Target')
    if (id === undefined || type === undefined || target === undefined || result.has(id)
      || /\bTargetMode\s*=/iu.test(tag)) bad('PPTX 包含外部或无效的关系')
    result.set(id, { type, target: resolvePart(source, decodeXml(target)) })
  }
  return result
}

/** 单趟核对 XML 标签配对，并只提取互不重叠的可编辑形状块。 */
function shapeBlocks(xml: string, collect: boolean): string[] {
  const blocks: string[] = []
  const stack: { name: string; start: number }[] = []
  let cursor = 0
  let count = 0
  let roots = 0
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor)
    if (start < 0) break
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4)
      if (end < 0) bad('PPTX XML 注释未闭合')
      cursor = end + 3
      continue
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2)
      if (end < 0) bad('PPTX XML 指令未闭合')
      cursor = end + 2
      continue
    }
    if (xml.startsWith('<!', start)) bad('PPTX XML 不允许声明或 CDATA')
    let end = start + 1
    let quote = ''
    for (; end < xml.length; end += 1) {
      const char = xml[end]
      if (quote !== '') {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
      else if (char === '<') bad('PPTX XML 标签未闭合')
    }
    if (end === xml.length) bad('PPTX XML 标签未闭合')
    count += 1
    if (count > 200000) bad('PPTX XML 标签数超出安全预算')
    const tag = xml.slice(start + 1, end)
    const closing = tag.startsWith('/')
    const name = /^\/?([A-Za-z_][\w:.-]*)\b/u.exec(tag)?.[1]
    if (name === undefined) bad('PPTX XML 标签不合法')
    const selfClosing = !closing && /\/\s*$/u.test(tag)
    if (closing) {
      if (tag.slice(name.length + 1).trim() !== '' || stack.at(-1)?.name !== name) {
        bad(`PPTX XML 标签不匹配：${name}`)
      }
      const opened = stack.pop()
      if (opened === undefined) bad('PPTX XML 标签不匹配')
      if (collect && /^(?:p:sp|p:pic|p:graphicFrame|p:cxnSp)$/u.test(name)) {
        if (blocks.length >= 200) bad('PPTX 单页不能超过 200 个元素')
        blocks.push(xml.slice(opened.start, end + 1))
      }
    } else {
      if (stack.length === 0) roots += 1
      if (stack.length >= 128) bad('PPTX XML 嵌套层级超出安全预算')
      if (collect && /^(?:p:sp|p:pic|p:graphicFrame|p:cxnSp)$/u.test(name)
        && stack.some(item => /^(?:p:sp|p:pic|p:graphicFrame|p:cxnSp)$/u.test(item.name))) {
        bad('PPTX 幻灯片元素不能嵌套')
      }
      if (!selfClosing) stack.push({ name, start })
    }
    cursor = end + 1
  }
  if (stack.length !== 0 || roots !== 1) bad('PPTX XML 结构不完整')
  return blocks
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
  return value.replace(/&(#(?:x[0-9a-fA-F]+|[0-9]+)|lt|gt|quot|apos|amp);/gu, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const digits = entity.slice(1)
      const code = digits.startsWith('x') ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10)
      if (code !== 9 && code !== 10 && code !== 13
        && (code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          || (code >= 0xfffe && code <= 0xffff))) bad('PPTX XML 数字实体不合法')
      return String.fromCodePoint(code)
    }
    switch (entity) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: return '&'
    }
  })
}

/** 保留原有片段顺序，线性移除已通过结构扫描的 XML 注释。 */
function withoutComments(xml: string): string {
  const parts: string[] = []
  let cursor = 0
  while (true) {
    const start = xml.indexOf('<!--', cursor)
    if (start < 0) { parts.push(xml.slice(cursor)); return parts.join('') }
    parts.push(xml.slice(cursor, start))
    const end = xml.indexOf('-->', start + 4)
    if (end < 0) bad('PPTX XML 注释未闭合')
    cursor = end + 3
  }
}

function hexColor(value: string | undefined, fallback: string): string {
  return value !== undefined && /^[0-9a-fA-F]{6}$/u.test(value) ? `#${value.toLowerCase()}` : fallback
}

/** XML 已通过结构扫描，只取首个同名元素，避免失败匹配反复扫描后续内容。 */
function firstElement(xml: string, name: string): string {
  const start = new RegExp(`<${name}(?=[\\s/>])`, 'u').exec(xml)?.index
  if (start === undefined) return ''
  const openingEnd = xml.indexOf('>', start)
  if (openingEnd < 0) bad('PPTX XML 标签未闭合')
  const opening = xml.slice(start, openingEnd + 1)
  if (/\/\s*>$/u.test(opening)) return opening
  const closing = xml.indexOf(`</${name}>`, openingEnd + 1)
  if (closing < 0) bad('PPTX XML 标签不匹配')
  return xml.slice(start, closing + name.length + 3)
}

function slideSize(presentation: string): SlideSizeId {
  const block = /<p:sldSz[^>]*>/u.exec(presentation)?.[0] ?? ''
  const width = Number(attr(block, 'cx') ?? 0)
  const height = Number(attr(block, 'cy') ?? 0)
  if (height > 0 && Math.abs(width / height - 16 / 9) < 0.05) return '16:9'
  return '4:3'
}

function decodeText(runs: string): string {
  let content = ''
  let paragraphs = 0
  for (const paragraph of runs.matchAll(/<a:p\b(?![^>]*\/\s*>)[^>]*>([\s\S]*?)<\/a:p>/gu)) {
    if (paragraphs++ > 0) content += '\n'
    for (const item of (paragraph[1] ?? '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)) {
      content += decodeXml(item[1] ?? '')
      if (content.length > 5000) bad('PPTX 文本不能超过 5000 字符')
    }
    if (content.length > 5000) bad('PPTX 文本不能超过 5000 字符')
  }
  return content.trim()
}

function textStyle(block: string, design?: SourceDesign): {
  content: string
  size: number
  color: string
  bold: boolean
  align: TextAlign
  valign: TextVAlign
  font: string
} {
  const palette = PPT_THEMES.ink
  const runProps = /<a:rPr\b[^>]*>/u.exec(block)?.[0] ?? ''
  const size = Number(attr(runProps, 'sz') ?? 1800) / 75
  const run = /<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/u.exec(block)?.[0]
    ?? /<a:defRPr\b[^>]*>([\s\S]*?)<\/a:defRPr>/u.exec(block)?.[0] ?? ''
  const colorValue = design?.color(run)
    ?? /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(block)?.[1]
  const alignRaw = /<a:pPr[^>]*algn="(\w+)"/u.exec(block)?.[1]
  const anchorRaw = attr(/<a:bodyPr\b[^>]*>/u.exec(block)?.[0] ?? '', 'anchor')
  return {
    content: decodeText(block),
    size: Math.min(Math.max(Math.round(size), 6), 400),
    color: colorValue?.startsWith('#') ? colorValue
      : hexColor(colorValue, design?.background === '#ffffff' ? '#16181d' : palette.text),
    bold: attr(runProps, 'b') === '1',
    align: alignRaw === 'ctr' ? 'center' : alignRaw === 'r' ? 'right' : 'left',
    valign: anchorRaw === 'ctr' ? 'middle' : anchorRaw === 'b' ? 'bottom' : 'top',
    font: /<a:latin typeface="([^"]+)"/u.exec(block)?.[1]?.replace(/^\+(?:mn|mj)-lt$/u, design?.font ?? '')
      ?? design?.font ?? '',
  }
}

function frame(block: string): { x: number; y: number; w: number; h: number } {
  const off = /<a:off\b[^>]*>/u.exec(block)?.[0] ?? ''
  const ext = /<a:ext\b[^>]*>/u.exec(block)?.[0] ?? ''
  return { x: px(attr(off, 'x')), y: px(attr(off, 'y')), w: px(attr(ext, 'cx')), h: px(attr(ext, 'cy')) }
}

function lineWidth(block: string): number {
  const line = /<a:ln\b[^>]*>/u.exec(block)?.[0] ?? ''
  return Math.max(1, px(attr(line, 'w') ?? '12700'))
}

function readSource(bytes: Uint8Array): {
  files: Record<string, Uint8Array>
  slideBlocks: Map<string, string[]>
  decode: (path: string) => string
  presentation: string
  slidePaths: string[]
  tempPng: boolean
} {
  const files = unpack(bytes)
  const slideBlocks = new Map<string, string[]>()
  const decode = (path: string): string => {
    const entry = files[path]
    if (entry === undefined) return ''
    try { return new TextDecoder('utf-8', { fatal: true }).decode(entry) }
    catch { return bad(`PPTX XML 编码不合法：${path}`) }
  }
  for (const path of Object.keys(files)) {
    if (path.endsWith('.xml') || path.endsWith('.rels')) {
      const xml = decode(path)
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)
        || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)[^;\s]{1,40};/iu.test(xml)) {
        bad('PPTX XML 不允许 DTD 或自定义实体')
      }
      const isSlide = /^ppt\/slides\/slide\d+\.xml$/u.test(path)
      const blocks = shapeBlocks(xml, isSlide)
      if (isSlide) slideBlocks.set(path, blocks)
      if (path.endsWith('.rels')) relationships(xml, path.replace(/\/_rels\/([^/]+)\.rels$/u, '/$1'))
    }
  }
  if (Object.keys(files).some(path => /(?:^|\/)(?:vbaProject\.bin|activeX|embeddings)(?:\/|$)/iu.test(path))
    || /macroEnabled/iu.test(decode('[Content_Types].xml'))) {
    bad('不支持宏、ActiveX 或嵌入对象')
  }
  const tempTypes = [...decode('[Content_Types].xml').matchAll(/<Default\b[^>]*>/gu)]
    .map(([tag]) => tag).filter(tag => attr(tag, 'Extension') === 'tmp')
  const tempPng = tempTypes.length === 1 && attr(tempTypes[0] ?? '', 'ContentType') === 'image/png'
  const presentation = decode('ppt/presentation.xml')
  if (presentation === '') bad('这个 .pptx 缺少演示文稿主文件')
  const numberedSlides = Object.keys(files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort((left, right) => Number(left.match(/\d+/u)?.[0] ?? 0) - Number(right.match(/\d+/u)?.[0] ?? 0))
  const presentationRels = decode('ppt/_rels/presentation.xml.rels')
  const slidePaths = presentationRels === '' ? numberedSlides : (() => {
    const rels = relationships(presentationRels, 'ppt/presentation.xml')
    const ids = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/gu)]
    if (ids.length === 0) bad('PPTX 演示文稿没有幻灯片关系')
    const paths = ids.map((match) => {
      const rel = rels.get(match[1] ?? '')
      if (rel?.type !== SLIDE_REL || !/^ppt\/slides\/[^/]+\.xml$/u.test(rel.target)
        || files[rel.target] === undefined) bad('PPTX 幻灯片关系缺失或不合法')
      return rel.target
    })
    if (new Set(paths).size !== paths.length) bad('PPTX 幻灯片关系重复')
    return paths
  })()
  if (slidePaths.length === 0) throw new PptImportError('这个 .pptx 里没有幻灯片')
  if (slidePaths.length > 200) bad('演示文稿不能超过 200 页')
  return { files, slideBlocks, decode, presentation, slidePaths, tempPng }
}

/**
 * 解包并解析一份 .pptx。
 * @param bytes - .pptx 文件内容。
 * @param options - 文稿标题；`design` 仅读取源配色和字体，不修复不能表达的图形。
 * @returns 导入结果。
 * @throws PptImportError - 不是合法的 .pptx、或没有任何可解析的幻灯片时。
 */
export function importPptx(bytes: Uint8Array, options: { title: string; design?: boolean }): PptImportResult {
  const { files, slideBlocks, decode, presentation, slidePaths, tempPng } = readSource(bytes)

  const dropped = new Set<string>()
  dropped.add('复杂母版与版式')
  dropped.add('动画与高级转场')
  const media: { part: string; bytes: Uint8Array }[] = []
  const mediaNames = new Map<string, string>()
  const pageReports: PptImportReport['pages'][number][] = []
  const pages: PptPage[] = slidePaths.map((path, index) => {
    const xml = decode(path)
    const visibleXml = withoutComments(xml)
    const rels = relationships(decode(path.replace('slides/', 'slides/_rels/') + '.rels'), path)
    const design = options.design === true ? sourceDesign(designEvidence(files, decode, rels)) : undefined
    const background = firstElement(visibleXml, 'p:bg')
    const backgroundRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(background)?.[1]
    const elements: PptElement[] = []
    const source = { text: 0, image: 0, table: 0, chart: 0, diagram: 0, other: 0 }
    const losses = new Set<PptPageLoss>()
    const backgroundBlip = /<a:blip\b[^>]*>/u.exec(firstElement(background, 'p:bgPr'))?.[0]
    if (backgroundBlip !== undefined) {
      source.image += 1
      const relId = attr(backgroundBlip, 'r:embed')
      const size = SLIDE_SIZES[slideSize(presentation)]
      const image = parseImage(relId, { x: 0, y: 0, w: size.width, h: size.height },
        rels, files, media, mediaNames, dropped, tempPng)
      if (image === null) losses.add('image')
      else elements.push(image)
    }
    const groupCount = [...visibleXml.matchAll(/<p:grpSp\b/gu)].length
    const unknownCount = [...visibleXml.matchAll(/<p:(?:contentPart|oleObj|control)\b/gu)].length
    source.other += groupCount + unknownCount
    if (groupCount > 0) losses.add('group')
    if (unknownCount > 0) losses.add('object')
    for (const block of slideBlocks.get(path) ?? []) {
      if (elements.length >= 200) bad(`第 ${index + 1} 页不能超过 200 个元素`)
      let category: keyof typeof source
      if (block.startsWith('<p:pic')) category = 'image'
      else if (block.startsWith('<p:graphicFrame')) {
        category = block.includes('drawingml/2006/chart') ? 'chart'
          : block.includes('drawingml/2006/diagram') ? 'diagram'
            : block.includes('/table') ? 'table' : 'other'
      } else category = block.startsWith('<p:sp') && /<a:t(?:\s[^>]*)?>/u.test(block) ? 'text' : 'other'
      source[category] += 1
      const element = parseShape(block, rels, files, media, mediaNames, dropped, tempPng, design)
      if (element !== null) elements.push(element)
      else losses.add(category === 'other' ? block.startsWith('<p:graphicFrame') ? 'object' : 'shape' : category)
      if (block.startsWith('<p:graphicFrame')) {
        if (block.includes('drawingml/2006/chart')) dropped.add('图表')
        if (block.includes('drawingml/2006/diagram')) dropped.add('SmartArt')
      }
    }
    const page: PptPage = {
      id: newId(),
      name: `第 ${index + 1} 页`,
      background: options.design === true ? design?.color(background) ?? design?.background ?? '#ffffff'
        : backgroundRaw === undefined ? null : hexColor(backgroundRaw, '#ffffff'),
      transition: /<p:transition>\s*<p:fade/u.test(xml) ? 'fade'
        : /<p:transition>\s*<p:push/u.test(xml) ? 'push' : 'none',
      elements,
    }
    const imported = { text: 0, image: 0, table: 0, chart: 0 }
    for (const element of elements) {
      if (element.kind === 'text' || element.kind === 'image' || element.kind === 'table' || element.kind === 'chart') {
        imported[element.kind] += 1
      }
    }
    for (const category of ['text', 'image', 'table', 'chart'] as const) {
      if (source[category] > imported[category]) losses.add(category)
    }
    const preview = previewText(visibleXml)
    const sourceCount = Object.values(source).reduce((total, count) => total + count, 0)
    const status = sourceCount === 0 ? 'empty_source'
      : elements.length === 0 ? 'empty_import'
        : losses.size > 0 ? 'partial'
          : elements.every(element => element.kind === 'image') ? 'image_only' : 'no_known_loss'
    pageReports.push({ sourceIndex: index + 1, pageId: page.id, slidePart: path, source, imported,
      status, losses: [...losses], textPreview: preview.text, truncated: preview.truncated })
    return page
  })

  const deck: Deck = {
    format: 1,
    title: options.title,
    size: slideSize(presentation),
    theme: options.design === true ? 'inference' : pageTheme(pages),
    pages,
  }
  const parsed = parseDeck(deck)
  if (parsed.pages.length !== slidePaths.length) bad('PPTX 导入后页数与源文件不一致')
  return { deck: parsed, media, dropped: [...dropped], report: {
    sourceSlides: slidePaths.length, importedPages: parsed.pages.length, pages: pageReports,
  } }
}

function previewText(xml: string): { text: string[]; truncated: boolean } {
  const text: string[] = []
  let remaining = 600
  let truncated = false
  for (const match of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)) {
    const value = decodeXml(match[1] ?? '').trim()
    if (value === '') continue
    if (remaining === 0 || text.length === 24) { truncated = true; break }
    const allowed = remaining
    text.push(value.slice(0, remaining))
    remaining -= text.at(-1)?.length ?? 0
    if (value.length > allowed) { truncated = true; break }
  }
  return { text, truncated }
}

const MAX_EVIDENCE_CHARS = 1024 * 1024
const DESIGN_REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

function designEvidence(
  files: Record<string, Uint8Array>,
  decode: (part: string) => string,
  slideRelations: ReadonlyMap<string, Relationship>,
): { kind: 'layout' | 'master' | 'theme'; part: string; xml: string }[] {
  const result: { kind: 'layout' | 'master' | 'theme'; part: string; xml: string }[] = []
  const active = new Set<string>()
  const visited = new Set<string>()
  const relsOf = (part: string): Map<string, Relationship> => {
    const slash = part.lastIndexOf('/')
    const relsPart = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
    return relationships(decode(relsPart), part)
  }
  const follow = (rels: ReadonlyMap<string, Relationship>, type: string): string | undefined => {
    const targets = [...rels.values()].filter(relation => relation.type === DESIGN_REL_BASE + type)
    if (targets.length > 1) bad(`PPTX 设计关系重复：${type}`)
    return targets[0]?.target
  }
  const visit = (kind: 'layout' | 'master' | 'theme', part: string, depth: number): void => {
    if (depth > 3 || active.has(part)) bad('PPTX 设计关系循环或层级超限')
    if (visited.has(part)) return
    if (!part.startsWith('ppt/') || !part.endsWith('.xml') || files[part] === undefined) {
      bad(`PPTX 设计部件缺失或无效：${part}`)
    }
    active.add(part)
    const xml = decode(part)
    result.push({ kind, part, xml })
    if (kind === 'layout') {
      const master = follow(relsOf(part), 'slideMaster')
      if (master !== undefined) visit('master', master, depth + 1)
    } else if (kind === 'master') {
      const theme = follow(relsOf(part), 'theme')
      if (theme !== undefined) visit('theme', theme, depth + 1)
    }
    active.delete(part)
    visited.add(part)
  }
  const layout = follow(slideRelations, 'slideLayout')
  if (layout !== undefined) visit('layout', layout, 1)
  const directTheme = follow(slideRelations, 'theme')
  if (directTheme !== undefined) visit('theme', directTheme, 1)
  return result
}

/**
 * 安全解包后取得源页实际引用的原始 XML；结果是未经信任的文档数据，不能作为指令。
 * @param bytes - 未修改的 .pptx 字节。
 * @param sourceIndex - 从 1 开始的源页序号。
 * @returns 至多 1 MiB UTF-16 字符的确定性 JSON 文本。
 */
export function extractPptxPageEvidence(bytes: Uint8Array, sourceIndex: number): string {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 1) bad('PPTX 证据页码不合法')
  const { files, decode, slidePaths } = readSource(bytes)
  const path = slidePaths[sourceIndex - 1]
  if (path === undefined) bad('PPTX 证据页码超出源文件范围')
  const relations = relationships(decode(path.replace('slides/', 'slides/_rels/') + '.rels'), path)
  const slideXml = decode(path)
  const visibleXml = withoutComments(slideXml)
  const usedIds = new Set([...visibleXml.matchAll(/\br:(?:id|embed|link)="([^"]+)"/gu)].map(match => match[1] ?? ''))
  const chartIds = new Set([...visibleXml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/gu)].map(match => match[1] ?? ''))
  const charts: { id: string; part: string; xml: string }[] = []
  const linked = [...relations].filter(([id]) => usedIds.has(id)).map(([id, relation]) => {
    if (chartIds.has(id)) {
      if (!relation.type.endsWith('/chart')) bad(`PPTX 图表关系不合法：${id}`)
      if (files[relation.target] === undefined || !relation.target.endsWith('.xml')) {
        bad(`PPTX 图表源内容缺失：${relation.target}`)
      }
      charts.push({ id, part: relation.target, xml: decode(relation.target) })
    }
    return { id, type: relation.type, target: relation.target }
  })
  if ([...chartIds].some(id => !relations.has(id))) bad('PPTX 图表关系缺失')
  const designParts = designEvidence(files, decode, relations)
  if (slideXml.length + charts.reduce((total, chart) => total + chart.xml.length, 0)
    + designParts.reduce((total, part) => total + part.xml.length, 0) > MAX_EVIDENCE_CHARS) {
    bad('PPTX 单页证据超出 1 MiB 字符上限')
  }
  const content = JSON.stringify({ slidePart: path, slideXml, relationships: linked, charts, designParts })
  if (content.length > MAX_EVIDENCE_CHARS) bad('PPTX 单页证据超出 1 MiB 字符上限')
  return content
}

/**
 * 从已验证的完整证据中安全切片，供 Host 缓存命中时复用相同的分页约束。
 * @param content - extractPptxPageEvidence 返回的完整 JSON。
 * @param options - 页码、UTF-16 字符偏移及单片字符上限。
 * @returns 片段及下一片的偏移。
 */
export function slicePptxPageEvidence(
  content: string,
  options: { sourceIndex: number; offset?: number | undefined; limit?: number | undefined },
): PptPageEvidenceChunk {
  const { sourceIndex, offset = 0, limit = 8000 } = options
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 1
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) {
    bad('PPTX 证据页码、偏移或片段上限不合法')
  }
  if (offset > content.length) bad('PPTX 证据偏移超出源文件范围')
  const end = Math.min(content.length, offset + limit)
  return { sourceIndex, content: content.slice(offset, end), totalChars: content.length,
    nextOffset: end < content.length ? end : null }
}

/**
 * 从源 PPTX 读取指定页的有界证据片段。
 * @param bytes - 未修改的 .pptx 字节。
 * @param options - 从 1 开始的页码、字符偏移与分片上限。
 * @returns 拼接所有片段后得到完整的 JSON 证据。
 */
export function readPptxPageEvidence(
  bytes: Uint8Array,
  options: { sourceIndex: number; offset?: number | undefined; limit?: number | undefined },
): PptPageEvidenceChunk {
  return slicePptxPageEvidence(extractPptxPageEvidence(bytes, options.sourceIndex), options)
}

/** 导入时保持默认主题：模型元素带显式颜色，主题只影响后续新增元素的默认色。 */
function pageTheme(_pages: readonly PptPage[]): 'ink' {
  void _pages
  return 'ink'
}

function parseShape(
  block: string,
  rels: ReadonlyMap<string, Relationship>,
  files: Record<string, Uint8Array>,
  media: { part: string; bytes: Uint8Array }[],
  mediaNames: Map<string, string>,
  dropped: Set<string>,
  tempPng: boolean,
  design?: SourceDesign,
): PptElement | null {
  const box = frame(block)
  if (block.startsWith('<p:pic')) {
    const relId = /<a:blip[^>]*r:embed="([^"]+)"/u.exec(block)?.[1]
    return parseImage(relId, box, rels, files, media, mediaNames, dropped, tempPng)
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
  if (block.startsWith('<p:cxnSp')) {
    const lineRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstElement(block, 'a:ln'))?.[1]
    return { id: newId(), kind: 'line', ...box, color: design?.color(firstElement(block, 'a:ln'))
      ?? hexColor(lineRaw, '#9aa7b4'), width: lineWidth(block) }
  }
  const preset = /<a:prstGeom prst="([^"]+)"/u.exec(block)?.[1]
  const shapeProps = firstElement(block, 'p:spPr')
  const fillRaw = /<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(shapeProps)?.[1]
  const lineRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstElement(shapeProps, 'a:ln'))?.[1]
  const hasText = /<a:t(?:\s[^>]*)?>/u.test(block)
  if (hasText) {
    return { id: newId(), kind: 'text', ...box, text: textStyle(block, design) }
  }
  if (preset === 'line' || preset === 'straightConnector1') {
    return {
      id: newId(), kind: 'line', ...box,
      color: design?.color(firstElement(shapeProps, 'a:ln')) ?? hexColor(lineRaw, '#9aa7b4'),
      width: lineWidth(shapeProps),
    }
  }
  if (preset === 'ellipse') {
    return { id: newId(), kind: 'ellipse', ...box, fill: design?.color(firstElement(shapeProps, 'a:solidFill'))
      ?? hexColor(fillRaw, '#4f8cff') }
  }
  if (shapeProps.includes('<a:custGeom') && design !== undefined) {
    const customLine = axisAlignedCustomPath(shapeProps, box)
    if (customLine !== null) {
      return { id: newId(), kind: 'line', ...customLine,
        color: design.color(firstElement(shapeProps, 'a:ln')) ?? hexColor(lineRaw, '#9aa7b4'),
        width: lineWidth(shapeProps) }
    }
    dropped.add('自定义路径')
    return null
  }
  if (fillRaw !== undefined || preset === 'rect' || preset === undefined) {
    return { id: newId(), kind: 'rect', ...box, fill: design?.color(firstElement(shapeProps, 'a:solidFill'))
      ?? hexColor(fillRaw, '#4f8cff') }
  }
  dropped.add('形状')
  return null
}

function parseImage(
  relId: string | undefined,
  box: { x: number; y: number; w: number; h: number },
  rels: ReadonlyMap<string, Relationship>,
  files: Record<string, Uint8Array>,
  media: { part: string; bytes: Uint8Array }[],
  mediaNames: Map<string, string>,
  dropped: Set<string>,
  tempPng: boolean,
): PptElement | null {
  const relation = relId === undefined ? undefined : rels.get(relId)
  if (relation === undefined) {
    dropped.add('图片')
    return null
  }
  if (relation.type !== IMAGE_REL || !/^ppt\/media\/[^/]+\.(?:png|jpe?g|gif|webp|tmp)$/iu.test(relation.target)) {
    bad('PPTX 图片关系格式不受支持')
  }
  const part = relation.target
  const bytes = files[part]
  if (bytes === undefined) {
    dropped.add('图片')
    return null
  }
  const ext = part.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'tmp' && !tempPng) bad('PPTX 图片关系格式不受支持')
  const imageExt = ext === 'tmp' ? 'png' : ext
  const valid = imageExt === 'png' ? bytes.length >= 8 && bytes.subarray(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i])
    : imageExt === 'jpg' || imageExt === 'jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : imageExt === 'gif' ? new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/u) !== null
        : bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF'
          && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  if (!valid) bad('PPTX 图片内容与格式不符')
  let name = mediaNames.get(part)
  if (name === undefined) {
    name = `media/image${mediaNames.size + 1}.${imageExt}`
    mediaNames.set(part, name)
    media.push({ part: name, bytes })
  }
  return { id: newId(), kind: 'image', ...box, source: name, fit: 'cover' }
}

function parseTable(
  block: string,
  box: { x: number; y: number; w: number; h: number },
): PptElement | null {
  const rows: string[] = []
  for (const match of block.matchAll(/<a:tr\b(?![^>]*\/\s*>)[^>]*>([\s\S]*?)<\/a:tr>/gu)) {
    if (rows.length >= 50) bad('PPTX 表格不能超过 50 行')
    rows.push(match[1] ?? '')
  }
  if (rows.length === 0) return null
  const grid: number[] = []
  for (const match of block.matchAll(/<a:gridCol w="(\d+)"/gu)) {
    if (grid.length >= 20) bad('PPTX 表格不能超过 20 列')
    grid.push(px(match[1]))
  }
  const columns = grid.length > 0 ? grid.length : 1
  const cells = rows.map((row) => {
    const parsed: { content: string }[] = []
    for (const tc of row.matchAll(/<a:tc\b(?![^>]*\/\s*>)[^>]*>[\s\S]*?<\/a:tc>/gu)) {
      if (parsed.length >= 20) bad('PPTX 表格不能超过 20 列')
      parsed.push({ content: decodeText(tc[0]) })
    }
    while (parsed.length < columns) parsed.push({ content: '' })
    return parsed.slice(0, columns)
  })
  const firstCell = rows[0] ?? ''
  const fill = /<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstCell)?.[1]
  const gridTotal = grid.reduce((sum, value) => sum + value, 0)
  return {
    id: newId(), kind: 'table', ...box,
    rows: cells.length,
    columns,
    columnWeights: gridTotal > 0
      ? grid.map(width => Math.max(0.1, Math.min(100, width * columns / gridTotal)))
      : Array.from({ length: columns }, () => 1),
    header: true,
    headerFill: hexColor(fill, '#4f8cff'),
    borderColor: '#9aa7b4',
    text: { size: 20, color: '#101418', bold: false, align: 'left', font: '' },
    cells,
  }
}
