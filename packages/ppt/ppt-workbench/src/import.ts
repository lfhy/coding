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
  PPT_THEMES, PptModelError, newId, parseDeck,
  type PptDeck, type PptDeck as Deck, type PptElement, type PptPage, type SlideSizeId,
  type TextAlign, type TextVAlign,
} from 'coding-ppt-model'
import { crc32 } from './export/zip.ts'

/** 导入结果。 */
export interface PptImportResult {
  readonly deck: PptDeck
  /** 需要写进工程 `media/` 的图片。 */
  readonly media: readonly { readonly part: string; readonly bytes: Uint8Array }[]
  /** 未能表达的元素类别，去重后供调用方汇报。 */
  readonly dropped: readonly string[]
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
      || (flags & ~0x0808) !== 0 || (method !== 0 && method !== 8)
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
  if (target.startsWith('/') || target.includes('\\') || /[\u0000-\u001f\u007f:%?#]/u.test(target)) bad('PPTX 关系目标路径不安全')
  const segments = source.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
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
    for (const item of (paragraph[1] ?? '').matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)) {
      content += decodeXml(item[1] ?? '')
      if (content.length > 5000) bad('PPTX 文本不能超过 5000 字符')
    }
    if (content.length > 5000) bad('PPTX 文本不能超过 5000 字符')
  }
  return content.trim()
}

function textStyle(block: string, theme: keyof typeof PPT_THEMES = 'ink'): {
  content: string
  size: number
  color: string
  bold: boolean
  align: TextAlign
  valign: TextVAlign
  font: string
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
    font: /<a:latin typeface="([^"]+)"/u.exec(block)?.[1] ?? '',
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

/**
 * 解包并解析一份 .pptx。
 * @param bytes - .pptx 文件内容。
 * @param options - 文稿标题。
 * @returns 导入结果。
 * @throws PptImportError - 不是合法的 .pptx、或没有任何可解析的幻灯片时。
 */
export function importPptx(bytes: Uint8Array, options: { title: string }): PptImportResult {
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

  const dropped = new Set<string>()
  dropped.add('复杂母版与版式')
  dropped.add('动画与高级转场')
  const media: { part: string; bytes: Uint8Array }[] = []
  const mediaNames = new Map<string, string>()
  const pages: PptPage[] = slidePaths.map((path, index) => {
    const xml = decode(path)
    const rels = relationships(decode(path.replace('slides/', 'slides/_rels/') + '.rels'), path)
    const backgroundRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstElement(xml, 'p:bg'))?.[1]
    const elements: PptElement[] = []
    for (const block of slideBlocks.get(path) ?? []) {
      if (elements.length >= 200) bad(`第 ${index + 1} 页不能超过 200 个元素`)
      const element = parseShape(block, rels, files, media, mediaNames, dropped)
      if (element !== null) elements.push(element)
      if (block.startsWith('<p:graphicFrame')) {
        if (block.includes('drawingml/2006/chart')) dropped.add('图表')
        if (block.includes('drawingml/2006/diagram')) dropped.add('SmartArt')
      }
    }
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
  return { deck: parseDeck(deck), media, dropped: [...dropped] }
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
): PptElement | null {
  const box = frame(block)
  if (block.startsWith('<p:pic')) {
    const relId = /<a:blip[^>]*r:embed="([^"]+)"/u.exec(block)?.[1]
    const relation = relId === undefined ? undefined : rels.get(relId)
    if (relation === undefined) {
      dropped.add('图片')
      return null
    }
    if (relation.type !== IMAGE_REL || !/^ppt\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/iu.test(relation.target)) {
      bad('PPTX 图片关系格式不受支持')
    }
    const part = relation.target
    const bytes = files[part]
    if (bytes === undefined) {
      dropped.add('图片')
      return null
    }
    const ext = part.split('.').pop()?.toLowerCase() ?? ''
    const valid = ext === 'png' ? bytes.length >= 8 && bytes.subarray(0, 8).every((value, i) => value === [137, 80, 78, 71, 13, 10, 26, 10][i])
      : ext === 'jpg' || ext === 'jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : ext === 'gif' ? new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/u) !== null
          : bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF'
            && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
    if (!valid) bad('PPTX 图片内容与格式不符')
    let name = mediaNames.get(part)
    if (name === undefined) {
      name = `media/image${mediaNames.size + 1}.${ext}`
      mediaNames.set(part, name)
      media.push({ part: name, bytes })
    }
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
  if (block.startsWith('<p:cxnSp')) {
    const lineRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstElement(block, 'a:ln'))?.[1]
    return { id: newId(), kind: 'line', ...box, color: hexColor(lineRaw, '#9aa7b4'), width: lineWidth(block) }
  }
  const preset = /<a:prstGeom prst="([^"]+)"/u.exec(block)?.[1]
  const shapeProps = firstElement(block, 'p:spPr')
  const fillRaw = /<a:solidFill>\s*<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(shapeProps)?.[1]
  const lineRaw = /<a:srgbClr val="([0-9a-fA-F]{6})"/u.exec(firstElement(shapeProps, 'a:ln'))?.[1]
  const hasText = /<a:t>/u.test(block)
  if (hasText) {
    return { id: newId(), kind: 'text', ...box, text: textStyle(block) }
  }
  if (preset === 'line' || preset === 'straightConnector1') {
    return {
      id: newId(), kind: 'line', ...box,
      color: hexColor(lineRaw, '#9aa7b4'),
      width: lineWidth(shapeProps),
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
  return {
    id: newId(), kind: 'table', ...box,
    rows: cells.length,
    columns,
    columnWeights: grid.length > 0 ? grid.map(width => Math.max(1, width)) : Array.from({ length: columns }, () => 1),
    header: true,
    headerFill: hexColor(fill, '#4f8cff'),
    borderColor: '#9aa7b4',
    text: { size: 20, color: '#101418', bold: false, align: 'left', font: '' },
    cells,
  }
}
