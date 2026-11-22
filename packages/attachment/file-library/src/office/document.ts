/** Office 原生文档与编辑载荷的运行时校验；不依赖浏览器或文件格式转换器。 */
import { randomUUID } from 'node:crypto'
import type { ExcelCell, ExcelMerge, ExcelSheet, ExcelStyle, OfficeDocument, OfficeKind, WordParagraph, WordRun } from '../types.ts'
import { validateOfficeFormula } from './formula.ts'

/** 原生文件完整 JSON 字节上限，不含 HTTP 请求的外层字段。 */
export const OFFICE_NATIVE_MAX_BYTES = 8 * 1024 * 1024
/** Word 段落上限。 */
export const OFFICE_MAX_PARAGRAPHS = 10_000
/** Word 全文的文字片段上限。 */
export const OFFICE_MAX_RUNS = 50_000
const WORD_MAX_BREAKS = 100_000
/** Excel 工作表上限。 */
export const OFFICE_MAX_SHEETS = 32
/** Excel 整份工作簿的显式单元格上限。 */
export const OFFICE_MAX_CELLS = 50_000
/** Excel 整份工作簿的显式合并区域上限。 */
export const OFFICE_MAX_MERGES = 2_048
/** Excel 单表行数上限；坐标从零开始。 */
export const OFFICE_MAX_ROWS = 100_000
/** Excel 单表列数上限；坐标从零开始。 */
export const OFFICE_MAX_COLUMNS = 1_024
/** 单格或单个文字片段的文本上限，以 UTF-16 码元计。 */
export const OFFICE_MAX_TEXT = 32_767

const PARAGRAPH_STYLES = ['normal', 'title', 'heading1', 'heading2', 'heading3'] as const
const PARAGRAPH_ALIGN = ['left', 'center', 'right', 'justify'] as const
const TEXT_FLAGS = ['bold', 'italic', 'underline', 'strike'] as const
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** 校验跨边界传入的笔记类型。@param value - 请求中的类型。@returns 已识别的 Office 类型。 */
export function officeKind(value: unknown): OfficeKind {
  if (value !== 'word' && value !== 'excel') throw new TypeError('办公笔记类型无效')
  return value
}

/** 校验已知结构的自有字段，拒绝未声明的数据。 */
export function officeRecord(value: unknown, keys: readonly string[], subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${subject}无效或含有未知字段`)
  return value as Record<string, unknown>
}

/** 限制输入集合大小；随后逐索引验证，包括稀疏数组的空位。 */
export function officeArray(value: unknown, limit: number, subject: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError(`${subject}无效或超出上限`)
  return value
}

/** 校验包含端点的整数范围。 */
export function officeInteger(value: unknown, max: number, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${subject}超出允许的范围`)
  }
  return value
}

function officeText(value: unknown, max: number, subject: string): string {
  // 跨格式保留 XML 1.0 可表示的文本；孤立代理项会导致导出时静默替换字符。
  if (typeof value !== 'string' || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value)) {
    throw new TypeError(`${subject}无效或超出长度上限`)
  }
  return value
}

/** 校验 Excel 可保存的工作表名称，不改写原有大小写和空格。 */
export function excelSheetName(value: unknown): string {
  const name = officeText(value, 31, '工作表名称')
  if (name.trim() === '' || /[\[\]:*?/\\\t\r\n]|^'|'$/u.test(name) || name.toLowerCase() === 'history') {
    throw new TypeError('工作表名称无效')
  }
  return name
}

/** 校验笔记中用于寻址工作表的持久 ID。 */
export function excelSheetId(value: unknown): string {
  const id = officeText(value, 128, '工作表标识')
  if (id.trim() === '' || /[\t\r\n]/u.test(id)) throw new TypeError('工作表标识无效')
  return id
}

/** 为从未持久化的工作表分配 ID；读取和改名不重新分配。 */
export function newExcelSheet(name: string): ExcelSheet {
  return { id: randomUUID(), name: excelSheetName(name), cells: [] }
}

/** 返回没有文字和样式覆盖的普通段落。 */
export function blankWordParagraph(): WordParagraph {
  return { style: 'normal', runs: [] }
}

/** 生成满足非空段落或非空工作簿约束的新文档。 */
export function blankOfficeDocument(kind: OfficeKind): OfficeDocument {
  return kind === 'word'
    ? { version: 1, kind, paragraphs: [blankWordParagraph()] }
    : { version: 1, kind, sheets: [newExcelSheet('Sheet1')] }
}

/**
 * 在逐项复制时拒绝超大 Host 输入，避免序列化前累计远超原生文件限额的数据。
 * 最终仍以完整 JSON 字节为准，包括键名、容器和转义开销。
 */
export class OfficeBudget {
  private textBytes = 0
  private wordBreaks = 0
  runs = 0
  cells = 0
  merges = 0

  text(value: string): string {
    this.textBytes += Buffer.byteLength(value, 'utf8')
    if (this.textBytes > OFFICE_NATIVE_MAX_BYTES) throw new TypeError('办公笔记超过 8 MiB')
    return value
  }

  /** 限制换行与制表符展开为 Word 节点的成本，不能只按原生字符串字节判断。 */
  wordText(value: string): string {
    this.text(value)
    for (const _ of value.matchAll(/\r\n|[\r\n\t]/gu)) {
      if (++this.wordBreaks > WORD_MAX_BREAKS) throw new TypeError('Word 换行和制表符过多')
    }
    return value
  }
}

function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/iu.test(value)) throw new TypeError('办公笔记颜色必须为 #RRGGBB')
  return value
}

function textFlags(record: Record<string, unknown>): Partial<Record<typeof TEXT_FLAGS[number], boolean>> {
  const result: Partial<Record<typeof TEXT_FLAGS[number], boolean>> = {}
  for (const name of TEXT_FLAGS) {
    const value = record[name]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new TypeError('办公笔记文字样式无效')
    result[name] = value
  }
  return result
}

function wordRun(value: unknown, budget: OfficeBudget): WordRun {
  const run = officeRecord(value, ['text', ...TEXT_FLAGS, 'color', 'fontSize'], '文字片段')
  const result: WordRun = { text: budget.wordText(officeText(run.text, OFFICE_MAX_TEXT, '段落文字')), ...textFlags(run) }
  if (run.color !== undefined) result.color = color(run.color)
  if (run.fontSize !== undefined) {
    if (typeof run.fontSize !== 'number' || !Number.isFinite(run.fontSize) || run.fontSize < 1 || run.fontSize > 400) {
      throw new TypeError('Word 字号必须为 1 到 400 pt')
    }
    result.fontSize = run.fontSize
  }
  return result
}

function choice<const T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(message)
  return value as T
}

/** 校验并复制一个段落，同时计入整份输入的片段和文本预算。 */
export function parseWordParagraph(value: unknown, budget: OfficeBudget): WordParagraph {
  const paragraph = officeRecord(value, ['style', 'align', 'runs'], 'Word 段落')
  const style = choice(paragraph.style, PARAGRAPH_STYLES, 'Word 段落样式无效')
  const runs = officeArray(paragraph.runs, OFFICE_MAX_RUNS - budget.runs, 'Word 文字片段数')
  budget.runs += runs.length
  const result: WordParagraph = { style, runs: Array.from(runs, run => wordRun(run, budget)) }
  if (paragraph.align !== undefined) result.align = choice(paragraph.align, PARAGRAPH_ALIGN, 'Word 对齐方式无效')
  return result
}

function excelStyle(value: unknown, budget: OfficeBudget): ExcelStyle {
  const style = officeRecord(value, [...TEXT_FLAGS, 'color', 'background', 'numberFormat'], '单元格样式')
  const result: ExcelStyle = textFlags(style)
  if (style.color !== undefined) result.color = color(style.color)
  if (style.background !== undefined) result.background = color(style.background)
  if (style.numberFormat !== undefined) result.numberFormat = budget.text(officeText(style.numberFormat, 255, '数字格式'))
  return result
}

function excelCell(value: unknown, budget: OfficeBudget): ExcelCell {
  const cell = officeRecord(value, ['row', 'column', 'value', 'formula', 'style'], 'Excel 单元格')
  const row = officeInteger(cell.row, OFFICE_MAX_ROWS - 1, '行坐标')
  const column = officeInteger(cell.column, OFFICE_MAX_COLUMNS - 1, '列坐标')
  const raw = cell.value
  const content = typeof raw === 'string' ? budget.text(officeText(raw, OFFICE_MAX_TEXT, '单元格文字')) : raw
  if (!(content === null || typeof content === 'string' || typeof content === 'boolean'
    || typeof content === 'number' && Number.isFinite(content))) throw new TypeError('单元格值无效')
  const result: ExcelCell = { row, column, value: content }
  if (cell.formula !== undefined) {
    if (typeof cell.formula !== 'string') throw new TypeError('单元格公式无效')
    result.formula = budget.text(validateOfficeFormula(cell.formula))
  }
  if (cell.style !== undefined) result.style = excelStyle(cell.style, budget)
  return result
}

/** 在工作表范围内将零基坐标映射到唯一整数键。 */
export function officeCellKey(cell: Pick<ExcelCell, 'row' | 'column'>): number {
  return cell.row * OFFICE_MAX_COLUMNS + cell.column
}

/** 校验坐标、拒绝重复格，并复制接收的单元格。 */
export function parseExcelCells(value: unknown, max: number, budget: OfficeBudget): ExcelCell[] {
  const source = officeArray(value, Math.min(max, OFFICE_MAX_CELLS - budget.cells), 'Excel 单元格数')
  budget.cells += source.length
  const seen = new Set<number>()
  return Array.from(source, (raw) => {
    const cell = excelCell(raw, budget)
    const key = officeCellKey(cell)
    if (seen.has(key)) throw new TypeError('工作表内有重复的单元格坐标')
    seen.add(key)
    return cell
  })
}

function excelMerges(value: unknown, budget: OfficeBudget): ExcelMerge[] {
  const source = officeArray(value, OFFICE_MAX_MERGES - budget.merges, 'Excel 合并区域数')
  budget.merges += source.length
  const merges: ExcelMerge[] = []
  for (const item of source) {
    const raw = officeRecord(item, ['startRow', 'startColumn', 'endRow', 'endColumn'], '合并区域')
    const startRow = officeInteger(raw.startRow, OFFICE_MAX_ROWS - 1, '合并区域的起始行')
    const startColumn = officeInteger(raw.startColumn, OFFICE_MAX_COLUMNS - 1, '合并区域的起始列')
    const endRow = officeInteger(raw.endRow, OFFICE_MAX_ROWS - 1, '合并区域的结束行')
    const endColumn = officeInteger(raw.endColumn, OFFICE_MAX_COLUMNS - 1, '合并区域的结束列')
    if (startRow > endRow || startColumn > endColumn || startRow === endRow && startColumn === endColumn
      || merges.some(other => startRow <= other.endRow && endRow >= other.startRow
        && startColumn <= other.endColumn && endColumn >= other.startColumn)) throw new TypeError('合并区域无效或重叠')
    merges.push({ startRow, startColumn, endRow, endColumn })
  }
  return merges
}

/** 校验完整文档并返回独立的原生对象；仅允许文件后缀对应的类型。 */
export function parseOfficeDocument(value: unknown, kind: OfficeKind): OfficeDocument {
  const source = officeRecord(value, ['version', 'kind', kind === 'word' ? 'paragraphs' : 'sheets'], '办公笔记')
  if (source.version !== 1 || source.kind !== kind) throw new TypeError('办公笔记版本或类型不匹配')
  const budget = new OfficeBudget()
  if (kind === 'word') {
    const paragraphs = Array.from(officeArray(source.paragraphs, OFFICE_MAX_PARAGRAPHS, 'Word 段落数'),
      item => parseWordParagraph(item, budget))
    return { version: 1, kind, paragraphs: paragraphs.length === 0 ? [blankWordParagraph()] : paragraphs }
  }
  const rawSheets = officeArray(source.sheets, OFFICE_MAX_SHEETS, 'Excel 工作表数')
  if (rawSheets.length === 0) throw new TypeError('Excel 工作簿必须至少保留一张工作表')
  const ids = new Set<string>()
  const names = new Set<string>()
  const sheets = Array.from(rawSheets, (item) => {
    const raw = officeRecord(item, ['id', 'name', 'cells', 'merges'], 'Excel 工作表')
    const id = excelSheetId(raw.id)
    const name = excelSheetName(raw.name)
    const insensitive = name.toUpperCase()
    if (ids.has(id) || names.has(insensitive)) throw new TypeError('工作表标识或名称重复')
    ids.add(id)
    names.add(insensitive)
    const sheet: ExcelSheet = { id, name, cells: parseExcelCells(raw.cells, OFFICE_MAX_CELLS, budget) }
    if (raw.merges !== undefined) sheet.merges = excelMerges(raw.merges, budget)
    return sheet
  })
  return { version: 1, kind, sheets }
}

/** 序列化已校验文档，以完整 UTF-8 JSON 验证原生文件上限。 */
export function encodeOfficeDocument(document: OfficeDocument): Buffer {
  const data = Buffer.from(JSON.stringify(document), 'utf8')
  if (data.byteLength > OFFICE_NATIVE_MAX_BYTES) throw new TypeError('办公笔记超过 8 MiB')
  return data
}

/** 拒绝无效 UTF-8／JSON，并校验与真实路径类型匹配的原生文档。 */
export function decodeOfficeDocument(bytes: Uint8Array, kind: OfficeKind): OfficeDocument {
  if (bytes.byteLength > OFFICE_NATIVE_MAX_BYTES) throw new TypeError('办公笔记超过 8 MiB')
  let source: unknown
  try { source = JSON.parse(utf8.decode(bytes)) }
  catch { throw new TypeError('办公笔记不是有效的原生文档') }
  return parseOfficeDocument(source, kind)
}
