/** 在笔记协议和 Univer Docs 1.5 的 UTF-16 正文索引之间转换，不加载编辑器。 */
import type {
  IColorStyle,
  IDocumentBody,
  IDocumentData,
  IParagraphStyle,
  ITextRun,
  ITextStyle,
} from '@univerjs/presets'
import type { ParagraphAlign, ParagraphStyle, WordDocument, WordParagraph, WordRun } from './office-document.ts'

const PARAGRAPH_BREAK = '\r'
const SECTION_END = '\n'
// 正文的 Unicode 断行器在此处分行，不创建新段落或节。
const SOFT_BREAK = '\u2028'

// 这些数值是快照协议；使用类型导入，避免转换器初始化编辑器。
const NAMED_STYLES = { normal: 1, title: 2, heading1: 4, heading2: 5, heading3: 6 } as const
const ALIGNMENTS = { left: 1, center: 2, right: 3, justify: 4 } as const
const MODERN_DOCUMENT = 2
const MAX_RUN_LENGTH = 32_767

const EMPTY_PARAGRAPH: WordParagraph = { style: 'normal', runs: [] }

// DocumentDataModel 会把这些布局默认值补进输入快照；字体大小和颜色仍由段落或行内样式承载。
const ENGINE_PARAGRAPH_DEFAULTS = { lineSpacing: 1.5, spaceAbove: { v: 0 }, spaceBelow: { v: 12 } }
const ENGINE_DOCUMENT_DEFAULTS = {
  documentFlavor: MODERN_DOCUMENT,
  pageSize: { width: 960, height: 842 / .75 },
  marginTop: 50, marginBottom: 50, marginLeft: 50, marginRight: 50,
  marginHeader: 30, marginFooter: 30,
  defaultHeaderId: '', defaultFooterId: '', evenPageHeaderId: '', evenPageFooterId: '',
  firstPageHeaderId: '', firstPageFooterId: '', useFirstPageHeaderFooter: 0, evenAndOddHeaders: 0,
  autoHyphenation: 1, doNotHyphenateCaps: 0, consecutiveHyphenLimit: 2,
  defaultParagraphStyle: ENGINE_PARAGRAPH_DEFAULTS,
  renderConfig: { zeroWidthParagraphBreak: 0, vertexAngle: 0, centerAngle: 0, background: { rgb: '#ccc' } },
  textStyle: {},
}
const NAMED_STYLE_SPACING = {
  normal: [0, 12], title: [0, 7], heading1: [20, 10], heading2: [18, 10], heading3: [16, 10],
} as const satisfies Record<ParagraphStyle, readonly [number, number]>

const DOCUMENT_STRUCTURES = [
  'drawings', 'drawingsOrder', 'headerFooterDrawingsOrder', 'headers', 'footers', 'notes', 'noteSettings',
  'footnotes', 'endnotes', 'tableSource', 'lists', 'styles',
] as const satisfies readonly (keyof IDocumentData)[]
const BODY_STRUCTURES = [
  'tables', 'columnGroups', 'blockRanges', 'customRanges', 'customBlocks', 'customDecorations',
  'renderedPageBreaks', 'docxRawCustomBlocks', 'docxRawBlocks', 'docxExportExcludedRanges', 'payloads',
] as const satisfies readonly (keyof IDocumentBody)[]

// FDocument.save 收集已注册的资源，即使文档没有权限项、自定义样式或脚注。
const EMPTY_DOC_RESOURCES = new Map<string, string>([
  ['DOC_OBJECT_PERMISSION_PLUGIN', '[]'],
  ['DOC_WORD_STYLES_PLUGIN', ''],
  ['DOC_NOTE_PLUGIN', ''],
])

function unsupported(): never {
  throw new Error('无法保存当前文字文档。请撤销不支持的内容或格式后重试。')
}

function encodeInlineStyle(run: WordRun): ITextStyle {
  const ts: ITextStyle = {}
  if (run.bold !== undefined) ts.bl = run.bold ? 1 : 0
  if (run.italic !== undefined) ts.it = run.italic ? 1 : 0
  if (run.underline !== undefined) ts.ul = { s: run.underline ? 1 : 0 }
  if (run.strike !== undefined) ts.st = { s: run.strike ? 1 : 0 }
  if (run.color !== undefined) ts.cl = { rgb: run.color }
  if (run.fontSize !== undefined) ts.fs = run.fontSize
  return ts
}

function encodeParagraphStyle(paragraph: WordParagraph, index: number): IParagraphStyle {
  const namedStyleType = NAMED_STYLES[paragraph.style]
  const style: IParagraphStyle = { namedStyleType }
  if (paragraph.align !== undefined) style.horizontalAlign = ALIGNMENTS[paragraph.align]
  if (paragraph.style !== 'normal') style.headingId = `word-heading-${index + 1}`
  if (namedStyleType >= NAMED_STYLES.heading1) style.outlineLevel = namedStyleType - NAMED_STYLES.heading1
  return style
}

/**
 * 将段落写为可编辑的 Word 正文；段内换行保留行边界，统一为单个换行。
 * @param document 已验证的 Word 协议文档。
 * @param id 此编辑器实例的文档标识。
 * @param title 编辑器使用的文档标题。
 * @returns 独立快照，不持有输入对象的引用。
 * @throws 正文包含与编辑器保留标记冲突的控制字符时拒绝转换。
 */
export function toUniverDocument(document: WordDocument, id: string, title: string): IDocumentData {
  const parts: string[] = []
  const paragraphs: NonNullable<IDocumentBody['paragraphs']> = []
  const textRuns: ITextRun[] = []
  let offset = 0

  for (const paragraph of document.paragraphs.length ? document.paragraphs : [EMPTY_PARAGRAPH]) {
    for (const run of paragraph.runs) {
      if (run.text === '') continue
      const text = run.text.replace(/\r\n|\r|\n/g, SOFT_BREAK)
      if (hasReservedControl(text)) unsupported()
      parts.push(text)
      textRuns.push({ st: offset, ed: offset + text.length, ts: encodeInlineStyle(run) })
      offset += text.length
    }
    paragraphs.push({
      startIndex: offset,
      paragraphId: `word-paragraph-${paragraphs.length + 1}`,
      paragraphStyle: encodeParagraphStyle(paragraph, paragraphs.length),
    })
    parts.push(PARAGRAPH_BREAK)
    offset++
  }
  return {
    id,
    title,
    body: {
      dataStream: parts.join('') + SECTION_END,
      paragraphs,
      textRuns,
      sectionBreaks: [{ startIndex: offset, sectionId: 'word-section-1' }],
    },
    documentStyle: { documentFlavor: MODERN_DOCUMENT },
  }
}

function hasReservedControl(text: string): boolean {
  // 允许制表符；拒绝结构标记和不能写入 Word XML 的字符（含独立代理项）。
  return /[\u0000-\u0008\u000a-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text)
}

function checkKeys(source: object, allowed: readonly string[]): void {
  if (Object.entries(source).some(([key, value]) => value != null && !allowed.includes(key))) unsupported()
}

function checkEmpty(value: unknown): void {
  if (value != null && (typeof value !== 'object' || Object.keys(value).length !== 0)) unsupported()
}

function checkDefaults(source: object, defaults: object): void {
  const entries: [string, unknown][] = Object.entries(source)
  for (const [key, value] of entries) {
    if (value == null) continue
    const expected = Object.hasOwn(defaults, key) ? Reflect.get(defaults, key) as unknown : undefined
    if (value === expected) continue
    if (typeof value !== 'object' || Array.isArray(value) || expected == null || typeof expected !== 'object') unsupported()
    checkDefaults(value, expected)
  }
}

function checkDocument(snapshot: IDocumentData): IDocumentBody {
  checkKeys(snapshot, ['id', 'title', 'body', 'documentStyle', 'settings', 'locale', 'rev', 'disabled', 'resources', ...DOCUMENT_STRUCTURES])
  for (const key of DOCUMENT_STRUCTURES) checkEmpty(snapshot[key])
  for (const resource of snapshot.resources ?? []) {
    checkKeys(resource, ['name', 'data'])
    if (!EMPTY_DOC_RESOURCES.has(resource.name) || EMPTY_DOC_RESOURCES.get(resource.name) !== resource.data) unsupported()
  }
  checkDefaults(snapshot.documentStyle, ENGINE_DOCUMENT_DEFAULTS)
  if (snapshot.settings) checkKeys(snapshot.settings, ['zoomRatio'])

  const body = snapshot.body
  if (!body || !body.dataStream.endsWith(PARAGRAPH_BREAK + SECTION_END)) unsupported()
  checkKeys(body, ['dataStream', 'paragraphs', 'textRuns', 'sectionBreaks', ...BODY_STRUCTURES])
  for (const key of BODY_STRUCTURES) checkEmpty(body[key])
  if ((body.sectionBreaks?.length ?? 0) > 1) unsupported()
  const section = body.sectionBreaks?.[0]
  if (section) {
    checkKeys(section, ['startIndex', 'sectionId'])
    if (section.startIndex !== body.dataStream.length - 1) unsupported()
  }
  return body
}

function decodeNamedStyle(value: number | undefined): ParagraphStyle {
  switch (value) {
    case undefined: case 0: case NAMED_STYLES.normal: return 'normal'
    case NAMED_STYLES.title: return 'title'
    case NAMED_STYLES.heading1: return 'heading1'
    case NAMED_STYLES.heading2: return 'heading2'
    case NAMED_STYLES.heading3: return 'heading3'
    default: return unsupported()
  }
}

function decodeAlignment(value: number | undefined): ParagraphAlign | undefined {
  switch (value) {
    case undefined: case 0: return undefined
    case ALIGNMENTS.left: return 'left'
    case ALIGNMENTS.center: return 'center'
    case ALIGNMENTS.right: return 'right'
    case ALIGNMENTS.justify: case 5: return 'justify' // Univer 正文的 BOTH 同样是两端对齐。
    default: return unsupported()
  }
}

type EditorParagraph = NonNullable<IDocumentBody['paragraphs']>[number]

function decodeParagraph(paragraph: EditorParagraph | undefined): Omit<WordParagraph, 'runs'> {
  if (paragraph) checkKeys(paragraph, ['startIndex', 'paragraphId', 'paragraphStyle', 'headingCollapsed'])
  const { namedStyleType, horizontalAlign, headingId, outlineLevel, paragraphMarkTextStyle, ...extra } = paragraph?.paragraphStyle ?? {}
  const style = decodeNamedStyle(namedStyleType ?? undefined)
  const align = decodeAlignment(horizontalAlign ?? undefined)
  const [above, below] = NAMED_STYLE_SPACING[style]
  checkDefaults(extra, {
    lineSpacing: ENGINE_PARAGRAPH_DEFAULTS.lineSpacing,
    spaceAbove: { v: above },
    spaceBelow: { v: below },
    spacingRule: 0,
    textStyle: {},
  })
  if (outlineLevel != null) {
    const preset = NAMED_STYLES[style]
    const isHeadingLevel = preset >= NAMED_STYLES.heading1 && outlineLevel === preset - NAMED_STYLES.heading1
    // 对标题末尾按 Enter 后，编辑器清掉名称和 ID，但可能保留原自动生成的大纲级别。
    const isBodyLevel = style === 'normal' && !headingId && (outlineLevel === 9 || [0, 1, 2].includes(outlineLevel))
    if (!isHeadingLevel && !isBodyLevel) unsupported()
  }
  // 段尾上继承的输入样式不属于正文，但不能借此吞掉不支持的格式。
  decodeInlineStyle(paragraphMarkTextStyle)
  return align === undefined ? { style } : { style, align }
}

function decodeToggle(value: unknown): boolean {
  if (value === 0 || value === 1) return value === 1
  return unsupported()
}

function checkDefaultNumber(value: unknown, expected: number): void {
  if (value != null && value !== expected) unsupported()
}

function decodeDecoration(value: NonNullable<ITextStyle['ul']>): boolean {
  checkKeys(value, ['s', 't', 'c', 'cl'])
  const shown = decodeToggle(value.s)
  if (!shown) return false
  // 单线随文字颜色是 Word 协议可表达的唯一开启样式。
  checkDefaultNumber(value.t, 12)
  checkDefaultNumber(value.c, 1)
  return true
}

function decodeColor(value: IColorStyle): string | undefined {
  checkKeys(value, ['rgb'])
  const rgb = value.rgb
  if (rgb == null) return undefined // 清除颜色命令写入 { rgb: null }。
  if (/^#[\da-f]{6}$/i.test(rgb)) return rgb
  if (/^#[\da-f]{3}$/i.test(rgb)) return rgb.replace(/[\da-f]/gi, '$&$&')
  const channels = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(rgb)
  if (channels) {
    const numbers = channels.slice(1).map(Number)
    if (numbers.every(num => num <= 255)) return `#${numbers.map(num => num.toString(16).padStart(2, '0')).join('')}`
  }
  return unsupported()
}

function decodeInlineStyle(value: ITextStyle | undefined): Omit<WordRun, 'text'> {
  if (!value) return {}
  const { bl, it, ul, st, cl, fs, ff, va, ...extra } = value
  checkKeys(extra, [])
  // 输入时可以带上默认字体，重置上标或下标后也会留下普通基线。
  if (ff != null && ff !== 'Arial') unsupported()
  checkDefaultNumber(va, 1)
  const color = cl ? decodeColor(cl) : undefined
  if (fs != null && (!Number.isFinite(fs) || fs <= 0)) unsupported()
  return {
    ...(bl != null && { bold: decodeToggle(bl) }),
    ...(it != null && { italic: decodeToggle(it) }),
    ...(ul != null && { underline: decodeDecoration(ul) }),
    ...(st != null && { strike: decodeDecoration(st) }),
    ...(color !== undefined && { color }),
    ...(fs != null && { fontSize: fs }),
  }
}

type DecodedTextRange = { st: number; ed: number; style: Omit<WordRun, 'text'> }

function decodeTextRanges(body: IDocumentBody): DecodedTextRange[] {
  const sorted = body.textRuns?.slice().sort((a, b) => a.st - b.st || a.ed - b.ed) ?? []
  const ranges: DecodedTextRange[] = []
  let previousEnd = 0
  for (const range of sorted) {
    checkKeys(range, ['st', 'ed', 'ts'])
    const { st, ed } = range
    if (!Number.isInteger(st) || !Number.isInteger(ed) || st < 0 || ed < st || ed > body.dataStream.length) unsupported()
    const style = decodeInlineStyle(range.ts)
    if (st === ed) continue
    if (st < previousEnd) unsupported()
    ranges.push({ st, ed, style })
    previousEnd = ed
  }
  return ranges
}

function appendText(
  runs: WordRun[], stream: string, start: number, end: number, style: Omit<WordRun, 'text'> = {},
): void {
  while (start < end) {
    let limit = Math.min(end, start + MAX_RUN_LENGTH)
    // 编辑器可能把同格式文本合为一段；拆长 run 时不拆开 UTF-16 代理对。
    if (limit < end && (stream.charCodeAt(limit) & 0xfc00) === 0xdc00
      && (stream.charCodeAt(limit - 1) & 0xfc00) === 0xd800) limit--
    const text = stream.slice(start, limit)
    if (hasReservedControl(text)) unsupported()
    runs.push({ text: text.replaceAll(SOFT_BREAK, '\n'), ...style })
    start = limit
  }
}

/**
 * 读回可保存的 Word 正文，忽略编辑器生成的标识、选区继承样式和显示设置。
 * @param snapshot 编辑器的完整文档快照。
 * @returns 独立的 Word 协议文档，始终至少有一段。
 * @throws 发现不可无损保存的结构、格式或非法偏移时拒绝转换；调用方不得覆盖已保存的文档。
 */
export function fromUniverDocument(snapshot: IDocumentData): WordDocument {
  const body = checkDocument(snapshot)
  const stream = body.dataStream
  const ranges = decodeTextRanges(body)
  const metadata = body.paragraphs ?? []
  const paragraphs: WordParagraph[] = []
  let metadataIndex = 0
  let rangeIndex = 0
  let range = ranges[rangeIndex]
  for (let start = 0; start < stream.length - 1;) {
    const end = stream.indexOf(PARAGRAPH_BREAK, start)
    const paragraph = metadata[metadataIndex]
    if (paragraph && paragraph.startIndex < end) unsupported()
    const matched = paragraph?.startIndex === end
    if (matched) metadataIndex++
    const properties = decodeParagraph(matched ? paragraph : undefined)
    const runs: WordRun[] = []
    let cursor = start
    while (range && range.st <= end) {
      const from = Math.max(cursor, range.st)
      const to = Math.min(end, range.ed)
      appendText(runs, stream, cursor, from)
      appendText(runs, stream, from, to, range.style)
      cursor = Math.max(from, to)
      // 样式区间可跨过段尾；结束标记只供编辑器使用，不写进 Word 正文。
      if (range.ed > end + 1) break
      range = ranges[++rangeIndex]
    }
    appendText(runs, stream, cursor, end)
    paragraphs.push({ ...properties, runs })
    start = end + 1
  }
  if (metadataIndex !== metadata.length) unsupported()
  return { version: 1, kind: 'word', paragraphs }
}
