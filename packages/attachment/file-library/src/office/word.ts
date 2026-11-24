/** 在已预检的 Word 包与可编辑段落之间转换；不执行域、不访问文件系统或网络。 */
import {
  AlignmentType, BuilderElement, Document, HeadingLevel, ImageRun, ImportedXmlComponent, Packer, Paragraph, Tab, Table,
  TableCell, TableRow, TextRun, UnderlineType,
} from 'docx'
import type { OfficeDocument, WordParagraph, WordRun } from '../types.ts'
import { blankWordParagraph, OfficeBudget, OFFICE_MAX_PARAGRAPHS, OFFICE_MAX_RUNS, OFFICE_MAX_TEXT } from './document.ts'
import type { OfficePackage } from './package.ts'
import { WORD_NS, WORD_STRICT_NS, type XmlElement, xmlAttr, xmlChild, xmlChildren } from './xml.ts'
import { buildWordSnapshot, readWordBlocks, readWordImages, type WordBlock } from './word-snapshot.ts'

type WordStyle = WordParagraph['style']
type WordAlign = NonNullable<WordParagraph['align']>
type RunFormat = Omit<WordRun, 'text'>
type StyleType = 'paragraph' | 'character'

const HEADING = {
  title: HeadingLevel.TITLE,
  heading1: HeadingLevel.HEADING_1,
  heading2: HeadingLevel.HEADING_2,
  heading3: HeadingLevel.HEADING_3,
} as const

const ALIGNMENT = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.BOTH,
} as const satisfies Record<WordAlign, string>

const CONTENT_WRAPPERS = new Set(['customXml', 'fldSimple', 'hyperlink', 'ins', 'moveTo', 'smartTag'])

function wordChild(element: XmlElement | undefined, local: string): XmlElement | undefined {
  return element && xmlChild(element, local, element.uri)
}

function wordValue(element: XmlElement | undefined, attr = 'val'): string | undefined {
  return element && xmlAttr(element, attr, element.uri)
}

function property(element: XmlElement | undefined, local: string): string | undefined {
  return wordValue(wordChild(element, local))
}

function onOff(element: XmlElement | undefined): boolean | undefined {
  if (!element) return undefined
  switch (wordValue(element)) {
    case '0': case 'false': case 'off': return false
    case undefined: case '1': case 'true': case 'on': return true
    default: return undefined
  }
}

function namedStyle(value: string | undefined): WordStyle | undefined {
  switch (value?.toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'normal': return 'normal'
    case 'title': case '标题': case '標題': return 'title'
    case 'heading1': case '标题1': case '標題1': return 'heading1'
    case 'heading2': case '标题2': case '標題2': return 'heading2'
    case 'heading3': case '标题3': case '標題3': return 'heading3'
    default: return undefined
  }
}

function outlineStyle(properties: XmlElement | undefined): WordStyle | undefined {
  switch (property(properties, 'outlineLvl')) {
    case '0': return 'heading1'
    case '1': return 'heading2'
    case '2': return 'heading3'
    default: return undefined
  }
}

function alignment(value: string | undefined, rtl: boolean | undefined): WordAlign | undefined {
  switch (value) {
    case 'left': case 'center': case 'right': return value
    case 'start': return rtl ? 'right' : 'left'
    case 'end': return rtl ? 'left' : 'right'
    case 'both': case 'distribute': return 'justify'
    default: return undefined
  }
}

function runFormat(properties: XmlElement | undefined): RunFormat {
  const bold = onOff(wordChild(properties, 'b')) ?? onOff(wordChild(properties, 'bCs'))
  const italic = onOff(wordChild(properties, 'i')) ?? onOff(wordChild(properties, 'iCs'))
  const strike = onOff(wordChild(properties, 'strike')) ?? onOff(wordChild(properties, 'dstrike'))
  const underline = wordChild(properties, 'u')
  const color = property(properties, 'color')
  const size = property(properties, 'sz') ?? property(properties, 'szCs')
  const fontSize = size && /^\d+(?:\.\d+)?pt$/.test(size) ? Number(size.slice(0, -2))
    : size && /^\d+$/.test(size) ? Number(size) / 2 : 0
  return {
    ...(bold === undefined ? {} : { bold }),
    ...(italic === undefined ? {} : { italic }),
    ...(strike === undefined ? {} : { strike }),
    ...(underline ? { underline: wordValue(underline) !== 'none' } : {}),
    ...(color && /^[0-9a-f]{6}$/i.test(color) ? { color: `#${color.toUpperCase()}` } : {}),
    ...(Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {}),
  }
}

interface ResolvedStyle {
  readonly kind?: WordStyle
  readonly justification?: string
  readonly rtl?: boolean
  readonly format?: RunFormat
}

function readStyles(packageFile: OfficePackage, uri: string): (id: string | undefined, type: StyleType) => ResolvedStyle {
  const path = packageFile.related(packageFile.main, 'styles')
  const styles = new Map<string, XmlElement>()
  let defaultParagraph: string | undefined
  if (path) {
    const root = packageFile.xml(path)
    if (root.local === 'styles' && root.uri === uri) {
      for (const element of xmlChildren(root, 'style', uri)) {
        const id = wordValue(element, 'styleId')
        if (!id) continue
        styles.set(id, element)
        const type = wordValue(element, 'type') ?? 'paragraph'
        if (type === 'paragraph' && ['1', 'true', 'on'].includes(wordValue(element, 'default') ?? '')) defaultParagraph = id
      }
    }
  }

  const cache = new Map<string, ResolvedStyle>()
  return (id, type) => {
    // OOXML 样式是可循环引用的输入；迭代合并并记忆结果，避免长链递归或反复扫描。
    const chain: [string, XmlElement][] = []
    const visited = new Set<string>()
    let result: ResolvedStyle = {}
    for (let key = id ?? (type === 'paragraph' ? defaultParagraph : undefined); key && !visited.has(key);) {
      const element: XmlElement | undefined = styles.get(key)
      if (!element || (wordValue(element, 'type') ?? 'paragraph') !== type) break
      const cached = cache.get(key)
      if (cached) {
        result = cached
        break
      }
      chain.push([key, element])
      visited.add(key)
      key = property(element, 'basedOn')
    }
    for (const [key, element] of chain.reverse()) {
      const properties = wordChild(element, 'pPr')
      const kind = namedStyle(key) ?? namedStyle(property(element, 'name')) ?? outlineStyle(properties)
      const justification = property(properties, 'jc')
      const rtl = onOff(wordChild(properties, 'bidi'))
      result = {
        ...result,
        ...(kind === undefined ? {} : { kind }),
        ...(justification === undefined ? {} : { justification }),
        ...(rtl === undefined ? {} : { rtl }),
        ...(type === 'character' ? { format: { ...result.format, ...runFormat(wordChild(element, 'rPr')) } } : {}),
      }
      cache.set(key, result)
    }
    return result
  }
}

/** 只展开正文容器；不把修订删除、绘图、属性或域指令当成正文。 */
function* wordContent(parent: XmlElement): Generator<XmlElement> {
  for (const child of xmlChildren(parent, undefined, parent.uri)) {
    if (child.local === 'sdt') {
      const content = wordChild(child, 'sdtContent')
      if (content) yield* wordContent(content)
    } else if (CONTENT_WRAPPERS.has(child.local)) {
      yield* wordContent(child)
    } else {
      yield child
    }
  }
}

function runText(run: XmlElement): string | undefined {
  const parts: string[] = []
  let length = 0
  for (const child of xmlChildren(run, undefined, run.uri)) {
    let text: string
    switch (child.local) {
      case 't': text = child.children.filter((part): part is string => typeof part === 'string').join(''); break
      case 'br': case 'cr': text = '\n'; break
      case 'tab': case 'ptab': text = '\t'; break
      case 'noBreakHyphen': text = '\u2011'; break
      case 'softHyphen': text = '\u00ad'; break
      default: continue
    }
    length += text.length
    if (length > OFFICE_MAX_TEXT) throw new TypeError('Word 文字片段过长')
    if (text.length || parts.length === 0) parts.push(text)
  }
  return parts.length ? parts.join('') : undefined
}

type FindStyle = ReturnType<typeof readStyles>

function* paragraphRuns(paragraph: XmlElement, findStyle: FindStyle): Generator<WordRun> {
  for (const child of wordContent(paragraph)) {
    if (child.local !== 'r') continue
    const text = runText(child)
    if (text === undefined) continue
    const properties = wordChild(child, 'rPr')
    const character = findStyle(property(properties, 'rStyle'), 'character')
    yield { text, ...character.format, ...runFormat(properties) }
  }
}

function* tableRows(table: XmlElement): Generator<XmlElement> {
  for (const row of wordContent(table)) if (row.local === 'tr') yield row
}

/** 以制表符分隔单元格，单元格内以换行分隔段落和嵌套表格行。 */
function* tableRowRuns(row: XmlElement, findStyle: FindStyle): Generator<WordRun> {
  let firstCell = true
  for (const cell of wordContent(row)) {
    if (cell.local !== 'tc') continue
    if (!firstCell) yield { text: '\t' }
    firstCell = false
    let firstBlock = true
    for (const block of wordContent(cell)) {
      if (block.local === 'p') {
        if (!firstBlock) yield { text: '\n' }
        firstBlock = false
        yield* paragraphRuns(block, findStyle)
      } else if (block.local === 'tbl') {
        for (const nested of tableRows(block)) {
          if (!firstBlock) yield { text: '\n' }
          firstBlock = false
          yield* tableRowRuns(nested, findStyle)
        }
      }
    }
  }
}

/**
 * 提取 Word 正文的段落和字符格式，将表格折叠为逐行文本。图片、页眉页脚和分页布局不保留。
 * @param packageFile - 已完成 ZIP、XML 和关系预检的文件包。
 * @returns 新建的 Word 快照；主部件缺失正文或转换结果超限时抛出 `TypeError`。
 */
export function importWord(packageFile: OfficePackage): Extract<OfficeDocument, { kind: 'word' }> {
  const root = packageFile.xml(packageFile.main)
  const body = root.local === 'document' && (root.uri === WORD_NS || root.uri === WORD_STRICT_NS)
    ? wordChild(root, 'body') : undefined
  if (!body) throw new TypeError('Word 文件缺少有效的正文')

  const findStyle = readStyles(packageFile, root.uri)
  const paragraphs: WordParagraph[] = []
  const budget = new OfficeBudget()
  const append = (style: WordStyle, align: WordAlign | undefined, source: Iterable<WordRun>) => {
    if (paragraphs.length >= OFFICE_MAX_PARAGRAPHS) throw new TypeError('Word 段落过多')
    const runs: WordRun[] = []
    for (const run of source) {
      if (++budget.runs > OFFICE_MAX_RUNS) throw new TypeError('Word 文字片段过多')
      budget.wordText(run.text)
      runs.push(run)
    }
    paragraphs.push({ style, ...(align === undefined ? {} : { align }), runs })
  }

  for (const block of wordContent(body)) {
    if (block.local === 'p') {
      const properties = wordChild(block, 'pPr')
      const id = property(properties, 'pStyle')
      const inherited = findStyle(id, 'paragraph')
      const style = namedStyle(id) ?? outlineStyle(properties) ?? inherited.kind ?? 'normal'
      const align = alignment(property(properties, 'jc') ?? inherited.justification,
        onOff(wordChild(properties, 'bidi')) ?? inherited.rtl)
      append(style, align, paragraphRuns(block, findStyle))
    } else if (block.local === 'tbl') {
      for (const row of tableRows(block)) append('normal', undefined, tableRowRuns(row, findStyle))
    }
  }
  if (!paragraphs.length) paragraphs.push(blankWordParagraph())
  return { version: 2, kind: 'word', snapshot: buildWordSnapshot(paragraphs) }
}

function exportRun(run: WordRun): TextRun {
  const format = {
    ...(run.bold === undefined ? {} : { bold: run.bold }),
    ...(run.italic === undefined ? {} : { italics: run.italic }),
    ...(run.underline === undefined ? {} : { underline: { type: run.underline ? UnderlineType.SINGLE : UnderlineType.NONE } }),
    ...(run.strike === undefined ? {} : { strike: run.strike }),
    ...(run.color === undefined ? {} : { color: run.color.slice(1) }),
    ...(run.fontSize === undefined ? {} : { size: Math.round(run.fontSize * 2) }),
  }
  if (!/[\r\n\t]/.test(run.text)) return new TextRun({ ...format, text: run.text })
  const children = run.text.split(/(\r\n|\r|\n|\t)/).filter(Boolean).map((part) => {
    if (part === '\t') return new Tab()
    if (part.startsWith('\n') || part.startsWith('\r')) return new BuilderElement({ name: 'w:br' })
    // docx 会把某些裸字符串解释成页码域；文字节点明确将它们作为字面文本处理。
    const text = new ImportedXmlComponent('w:t', { 'xml:space': 'preserve' })
    text.push(part)
    return text
  })
  return new TextRun({ ...format, children })
}

/**
 * 将已校验的可编辑 Word 快照打包为新文档；字号四舍五入到半磅，回车统一为换行。
 * 不复制输入文件的 OOXML 部件。
 * @param document - 领域校验后的 Word 快照；段落、表格与图片都会写进 `.docx`。
 * @returns `.docx` 文件字节；打包器出错时拒绝。
 */
export async function exportWord(document: Extract<OfficeDocument, { kind: 'word' }>): Promise<Uint8Array> {
  const paragraphOf = (paragraph: WordParagraph) => new Paragraph({
    ...(paragraph.style === 'normal' ? {} : { heading: HEADING[paragraph.style] }),
    ...(paragraph.align === undefined ? {} : { alignment: ALIGNMENT[paragraph.align] }),
    children: paragraph.runs.map(exportRun),
  })
  const blockOf = (block: WordBlock): Paragraph | Table | undefined => {
    if (block.kind === 'paragraph') return paragraphOf(block.paragraph)
    // 图片占位不进正文；图片本身在末尾按 `drawings` 写入。
    if (block.kind === 'image') return undefined
    return new Table({
      rows: block.table.rows.map(row => new TableRow({
        children: row.cells.map(cell => new TableCell({
          children: (cell.length > 0 ? cell : [blankWordParagraph()]).map(paragraphOf),
        })),
      })),
    })
  }
  const children = readWordBlocks(document.snapshot)
    .flatMap((block) => { const built = blockOf(block); return built === undefined ? [] : [built] })
  for (const image of readWordImages(document.snapshot)) {
    children.push(new Paragraph({
      children: [new ImageRun({
        type: image.type, data: image.data, transformation: { width: image.width, height: image.height },
      })],
    }))
  }
  return new Uint8Array(await Packer.toArrayBuffer(new Document({ sections: [{ children }] })))
}
