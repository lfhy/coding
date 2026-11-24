/** 在段落模型与引擎文档快照之间往返；快照里的表格、图片和链接由引擎原样保留。 */
import type { WordParagraph, WordParagraphAlign, WordParagraphStyle, WordRun, WordSnapshot } from '../types.ts'

const PARAGRAPH_BREAK = '\r'
const SECTION_END = '\n'
// 正文的 Unicode 断行器在此处分行，不创建新段落或节。
const SOFT_BREAK = '\u2028'
const MAX_RUN_LENGTH = 32_767

// 这两个数值是引擎快照协议的一部分，导入与导出共用。
const NAMED_STYLES: Record<WordParagraphStyle, number> = { normal: 1, title: 2, heading1: 4, heading2: 5, heading3: 6 }
const ALIGNMENTS: Record<WordParagraphAlign, number> = { left: 1, center: 2, right: 3, justify: 4 }
const MODERN_DOCUMENT = 2
const TABLE_START = '\u001a'
const TABLE_ROW_START = '\u001b'
const TABLE_CELL_START = '\u001c'
const TABLE_CELL_END = '\u001d'
const TABLE_END = '\u001f'

const EMPTY_PARAGRAPH: WordParagraph = { style: 'normal', runs: [] }

function styleOf(named: unknown): WordParagraphStyle {
  for (const [name, value] of Object.entries(NAMED_STYLES)) if (value === named) return name as WordParagraphStyle
  return 'normal'
}

function alignOf(horizontal: unknown): WordParagraphAlign | undefined {
  for (const [name, value] of Object.entries(ALIGNMENTS)) if (value === horizontal) return name as WordParagraphAlign
  return undefined
}

function encodeInlineStyle(run: WordRun): Record<string, unknown> {
  const style: Record<string, unknown> = {}
  if (run.bold !== undefined) style.bl = run.bold ? 1 : 0
  if (run.italic !== undefined) style.it = run.italic ? 1 : 0
  if (run.underline !== undefined) style.ul = { s: run.underline ? 1 : 0 }
  if (run.strike !== undefined) style.st = { s: run.strike ? 1 : 0 }
  if (run.color !== undefined) style.cl = { rgb: run.color }
  if (run.fontSize !== undefined) style.fs = run.fontSize
  return style
}

function encodeParagraphStyle(paragraph: WordParagraph, index: number): Record<string, unknown> {
  const namedStyleType = NAMED_STYLES[paragraph.style]
  const style: Record<string, unknown> = { namedStyleType }
  if (paragraph.align !== undefined) style.horizontalAlign = ALIGNMENTS[paragraph.align]
  if (paragraph.style !== 'normal') style.headingId = `word-heading-${index + 1}`
  if (namedStyleType >= NAMED_STYLES.heading1) style.outlineLevel = namedStyleType - NAMED_STYLES.heading1
  return style
}

/**
 * 把段落写成引擎可以直接打开的文档快照。
 * @param paragraphs - 已校验的段落；为空时补一个普通段落。
 * @param id - 文档标识。
 * @param title - 文档标题。
 * @returns 独立的引擎快照，不持有输入对象的引用。
 */
export function buildWordSnapshot(paragraphs: readonly WordParagraph[], id = 'coding-word', title = ''): WordSnapshot {
  const parts: string[] = []
  const metadata: Record<string, unknown>[] = []
  const textRuns: Record<string, unknown>[] = []
  let offset = 0
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [EMPTY_PARAGRAPH]) {
    for (const run of paragraph.runs) {
      if (run.text === '') continue
      const text = run.text.replace(/\r\n|\r|\n/g, SOFT_BREAK)
      parts.push(text)
      textRuns.push({ st: offset, ed: offset + text.length, ts: encodeInlineStyle(run) })
      offset += text.length
    }
    metadata.push({ startIndex: offset, paragraphId: `word-paragraph-${metadata.length + 1}`, paragraphStyle: encodeParagraphStyle(paragraph, metadata.length) })
    parts.push(PARAGRAPH_BREAK)
    offset++
  }
  return {
    id,
    title,
    body: {
      dataStream: parts.join('') + SECTION_END,
      paragraphs: metadata,
      textRuns,
      sectionBreaks: [{ startIndex: offset, sectionId: 'word-section-1' }],
    },
    documentStyle: { documentFlavor: MODERN_DOCUMENT },
  }
}

/** 表格在正文中由控制字符围起来；导出与助手读取都按区间整段跳过。 */
function tableRanges(snapshot: WordSnapshot): [number, number][] {
  const tables = snapshot.body.tables
  if (!Array.isArray(tables)) return []
  const ranges: [number, number][] = []
  for (const table of tables) {
    const record = table as { startIndex?: unknown; endIndex?: unknown }
    if (typeof record.startIndex === 'number' && typeof record.endIndex === 'number') {
      ranges.push([record.startIndex, record.endIndex])
    }
  }
  return ranges.sort((left, right) => left[0] - right[0])
}

function insideTable(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from)
}

function runStyle(value: unknown): Omit<WordRun, 'text'> {
  if (typeof value !== 'object' || value === null) return {}
  const style = value as Record<string, unknown>
  const result: Omit<WordRun, 'text'> = {}
  if (style.bl === 1) result.bold = true
  else if (style.bl === 0) result.bold = false
  if (style.it === 1) result.italic = true
  else if (style.it === 0) result.italic = false
  const underline = style.ul as { s?: unknown } | undefined
  if (underline?.s === 1) result.underline = true
  else if (underline?.s === 0) result.underline = false
  const strike = style.st as { s?: unknown } | undefined
  if (strike?.s === 1) result.strike = true
  else if (strike?.s === 0) result.strike = false
  const color = style.cl as { rgb?: unknown } | undefined
  if (typeof color?.rgb === 'string' && /^#[\da-f]{6}$/iu.test(color.rgb)) result.color = color.rgb
  if (typeof style.fs === 'number' && Number.isFinite(style.fs) && style.fs > 0) result.fontSize = style.fs
  return result
}

function sliceRuns(stream: string, runs: readonly Record<string, unknown>[], start: number, end: number): WordRun[] {
  const out: WordRun[] = []
  let cursor = start
  const push = (from: number, to: number, style: Omit<WordRun, 'text'>): void => {
    let offset = from
    while (offset < to) {
      let limit = Math.min(to, offset + MAX_RUN_LENGTH)
      if (limit < to && (stream.charCodeAt(limit) & 0xfc00) === 0xdc00 && (stream.charCodeAt(limit - 1) & 0xfc00) === 0xd800) limit--
      out.push({ text: stream.slice(offset, limit).replaceAll(SOFT_BREAK, '\n'), ...style })
      offset = limit
    }
  }
  for (const run of runs) {
    const from = run.st as number
    const to = run.ed as number
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < start || from >= to) continue
    if (from > cursor) push(cursor, Math.min(from, end), {})
    push(Math.max(from, cursor), Math.min(to, end), runStyle(run.ts))
    cursor = Math.min(Math.max(to, cursor), end)
  }
  if (cursor < end) push(cursor, end, {})
  return out
}

/** 表格里的单元格按段落保存；每行至少一格才能导出。 */
export interface WordTableBlock {
  readonly rows: readonly { readonly cells: readonly WordParagraph[][] }[]
}

/** 导出与助手共用的块序列：段落按顺序排列，表格作为整块出现。 */
export type WordBlock =
  | { readonly kind: 'paragraph'; readonly paragraph: WordParagraph }
  | { readonly kind: 'table'; readonly table: WordTableBlock }

function cellParagraphs(stream: string, runs: readonly Record<string, unknown>[], start: number, end: number): WordParagraph[] {
  const paragraphs: WordParagraph[] = []
  let cursor = start
  while (cursor < end) {
    const breakAt = stream.indexOf(PARAGRAPH_BREAK, cursor)
    const stop = breakAt < 0 || breakAt > end ? end : breakAt
    paragraphs.push({ style: 'normal', runs: sliceRuns(stream, runs, cursor, stop) })
    cursor = stop + 1
  }
  return paragraphs.length > 0 ? paragraphs : [{ style: 'normal', runs: [] }]
}

/** 按控制字符切分表格：行以 `\u001b` 开始，单元格内容落在 `\u001c` 与 `\u001d` 之间。 */
function parseTable(stream: string, runs: readonly Record<string, unknown>[], from: number, to: number): WordTableBlock {
  const rows: { cells: WordParagraph[][] }[] = []
  let row: { cells: WordParagraph[][] } | undefined
  for (let i = from + 1; i < to;) {
    const char = stream[i]
    if (char === TABLE_ROW_START) {
      row = { cells: [] }
      rows.push(row)
      i++
    } else if (char === TABLE_CELL_START) {
      const close = stream.indexOf(TABLE_CELL_END, i)
      const stop = close < 0 || close > to ? to : close
      row?.cells.push(cellParagraphs(stream, runs, i + 1, stop))
      i = stop + 1
    } else if (char === TABLE_END) break
    else i++
  }
  return { rows: rows.filter(item => item.cells.length > 0) }
}

/**
 * 按正文顺序读回段落与表格，供导出 `.docx` 使用；图片另行按 `drawings` 读取。
 * @param snapshot - 已校验的引擎快照。
 * @returns 段落与表格交替出现的块序列。
 */
export function readWordBlocks(snapshot: WordSnapshot): WordBlock[] {
  const stream = snapshot.body.dataStream
  const runs = Array.isArray(snapshot.body.textRuns) ? snapshot.body.textRuns as Record<string, unknown>[] : []
  const metadata = Array.isArray(snapshot.body.paragraphs) ? snapshot.body.paragraphs as Record<string, unknown>[] : []
  const blocks: WordBlock[] = []
  let start = 0
  while (start < stream.length) {
    if (stream[start] === TABLE_START) {
      const table = tableRanges(snapshot).find(([from]) => from === start)
      const stop = table === undefined ? stream.indexOf(TABLE_END, start) + 1 : table[1]
      // `endIndex` 已是 TABLE_END 之后的边界，直接当排他终点使用。
      const end = stop < 0 ? stream.length : Math.min(stop, stream.length)
      blocks.push({ kind: 'table', table: parseTable(stream, runs, start, end) })
      start = end
      continue
    }
    const breakAt = stream.indexOf(PARAGRAPH_BREAK, start)
    const end = breakAt < 0 ? stream.length : breakAt
    const meta = metadata.find(item => item.startIndex === end)
    const style = styleOf((meta?.paragraphStyle as Record<string, unknown> | undefined)?.namedStyleType)
    const align = alignOf((meta?.paragraphStyle as Record<string, unknown> | undefined)?.horizontalAlign)
    blocks.push({ kind: 'paragraph', paragraph: { style, ...(align === undefined ? {} : { align }), runs: sliceRuns(stream, runs, start, end) } })
    if (breakAt < 0) break
    start = breakAt + 1
    if (stream.slice(start).trim() === '') break
  }
  return blocks
}

/**
 * 从引擎快照读回段落与文字格式，供导出 `.docx` 与助手读取；表格按其区间整段跳过。
 * @param snapshot - 已校验的引擎快照。
 * @returns 至少包含一个段落的段落列表。
 */
export function readWordParagraphs(snapshot: WordSnapshot): WordParagraph[] {
  const stream = snapshot.body.dataStream
  const runs = Array.isArray(snapshot.body.textRuns) ? snapshot.body.textRuns as Record<string, unknown>[] : []
  const metadata = Array.isArray(snapshot.body.paragraphs) ? snapshot.body.paragraphs as Record<string, unknown>[] : []
  const tables = tableRanges(snapshot)
  const paragraphs: WordParagraph[] = []
  let start = 0
  while (start < stream.length) {
    const breakAt = stream.indexOf(PARAGRAPH_BREAK, start)
    const end = breakAt < 0 ? stream.length : breakAt
    const next = breakAt < 0 ? stream.length : breakAt + 1
    if (!insideTable(tables, start, next) && stream[start] !== TABLE_START) {
      const meta = metadata.find(item => item.startIndex === end)
      const style = styleOf((meta?.paragraphStyle as Record<string, unknown> | undefined)?.namedStyleType)
      const align = alignOf((meta?.paragraphStyle as Record<string, unknown> | undefined)?.horizontalAlign)
      paragraphs.push({ style, ...(align === undefined ? {} : { align }), runs: sliceRuns(stream, runs, start, end) })
    }
    start = next
    if (stream.slice(start).trim() === '') break
  }
  return paragraphs.length > 0 ? paragraphs : [EMPTY_PARAGRAPH]
}

/**
 * 判断快照里是否有段落之外的引擎结构；这些结构目前导出 `.docx` 与助手改写都不保留。
 * @param snapshot - 已校验的引擎快照。
 * @returns 是否含表格、图片、链接或页眉页脚等内容。
 */
export function hasRichWordContent(snapshot: WordSnapshot): boolean {
  const body = snapshot.body as Record<string, unknown>
  const values = [
    body.tables, body.customRanges, body.customBlocks,
    snapshot.drawings, snapshot.tableSource, snapshot.headers, snapshot.footers,
  ]
  return values.some((value) => {
    if (Array.isArray(value)) return value.length > 0
    if (value === undefined || value === null) return false
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  })
}

/** 导出 `.docx` 需要的内嵌图片：类型、原始字节与显示尺寸。 */
export interface WordImage {
  readonly type: 'png' | 'jpg' | 'gif' | 'bmp'
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

const IMAGE_TYPES = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', bmp: 'bmp' } as const

/**
 * 读出快照里内嵌的图片。图片既可以直接写成 data URL，也可以按标识引用 `resources`。
 * @param snapshot - 已校验的引擎快照。
 * @returns 可写入 `.docx` 的图片列表；不是内嵌 data URL 的来源直接跳过。
 */
export function readWordImages(snapshot: WordSnapshot): WordImage[] {
  const drawings = snapshot.drawings
  if (typeof drawings !== 'object' || drawings === null || Array.isArray(drawings)) return []
  const resources = new Map<string, string>()
  if (Array.isArray(snapshot.resources)) {
    for (const item of snapshot.resources) {
      const record = item as { name?: unknown; data?: unknown }
      if (typeof record.name === 'string' && typeof record.data === 'string') resources.set(record.name, record.data)
    }
  }
  const images: WordImage[] = []
  for (const drawing of Object.values(drawings as Record<string, unknown>)) {
    if (typeof drawing !== 'object' || drawing === null) continue
    const record = drawing as Record<string, unknown>
    const source = typeof record.source === 'string' ? record.source : undefined
    if (source === undefined) continue
    const url = source.startsWith('data:') ? source : resources.get(source)
    const match = url === undefined ? null : /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/u.exec(url)
    if (match === null || match[2] === undefined) continue
    const position = (record.docTransform ?? record.transform) as { width?: unknown; height?: unknown } | undefined
    images.push({
      type: IMAGE_TYPES[match[1] as keyof typeof IMAGE_TYPES],
      data: Buffer.from(match[2], 'base64'),
      width: typeof position?.width === 'number' ? Math.round(position.width) : 200,
      height: typeof position?.height === 'number' ? Math.round(position.height) : 150,
    })
  }
  return images
}
