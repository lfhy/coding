/** 浏览器拥有的笔记文档协议；不从 Host 运行时导入类型或值。 */

/** 支持编辑的原生笔记类型。 */
export type OfficeKind = 'word' | 'excel'

/** 可保存的段落样式与对齐。 */
export type ParagraphStyle = 'normal' | 'title' | 'heading1' | 'heading2' | 'heading3'
export type ParagraphAlign = 'left' | 'center' | 'right' | 'justify'

/** 一段使用相同字符样式的文字；字号单位为 pt。 */
export interface WordRun {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  readonly color?: string
  readonly fontSize?: number
}

/** 段落顺序和其中文字顺序即文档顺序。 */
export interface WordParagraph {
  readonly style: ParagraphStyle
  readonly align?: ParagraphAlign
  readonly runs: readonly WordRun[]
}

/** 引擎文档快照的正文；表格、图片、链接等结构随快照原样保存。 */
export interface WordSnapshotData {
  readonly body: { readonly dataStream: string; readonly [key: string]: unknown }
  readonly [key: string]: unknown
}

/** Word 笔记保存引擎快照，因此引擎能表达的块都能落盘。 */
export type WordDocument = { readonly version: 2; readonly kind: 'word'; readonly snapshot: WordSnapshotData }

/** 单元格可保存的格式；颜色使用六位十六进制。 */
export interface ExcelStyle {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  readonly color?: string
  readonly background?: string
  readonly numberFormat?: string
}

/** 行列零基；公式值是可选的计算缓存，缺省以 null 表示。 */
export interface ExcelCell {
  readonly row: number
  readonly column: number
  readonly value: string | number | boolean | null
  readonly formula?: string
  readonly style?: ExcelStyle
}

/** 合并区域包含首尾端点。 */
export interface ExcelMerge {
  readonly startRow: number
  readonly startColumn: number
  readonly endRow: number
  readonly endColumn: number
}

/** 同一工作簿内工作表标识稳定；单元格坐标不重复。 */
export interface ExcelSheet {
  readonly id: string
  readonly name: string
  readonly cells: readonly ExcelCell[]
  readonly merges?: readonly ExcelMerge[]
}

/** 工作表按显示顺序保存。 */
export type ExcelDocument = { readonly version: 1; readonly kind: 'excel'; readonly sheets: readonly ExcelSheet[] }

/** 浏览器读写的完整文档。 */
export type OfficeDocument = WordDocument | ExcelDocument

/** 修订号与路径绑定，仅从成功的 Host 响应获得。 */
export interface OfficeSnapshot {
  readonly path: string
  readonly revision: string
  readonly document: OfficeDocument
}

const COLOR = /^#[0-9a-f]{6}$/i
const NON_XML_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u
const EMPHASIS = ['bold', 'italic', 'underline', 'strike'] as const
const MAX_TEXT = 32_767
const MAX_SHEETS = 32
const MAX_CELLS = 50_000
const MAX_MERGES = 2_048
const MAX_ROWS = 100_000
const MAX_COLUMNS = 1_024
const MAX_FORMULA = 8_192

function hasKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => fields.includes(key))
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNativeText(value: unknown, limit: number): value is string {
  return isString(value) && value.length <= limit && !NON_XML_TEXT.test(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isColor(value: unknown): boolean {
  return isString(value) && COLOR.test(value)
}

function isEmphasis(value: Record<string, unknown>): boolean {
  return EMPHASIS.every(key => value[key] === undefined || typeof value[key] === 'boolean')
}

function isArrayOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value)) return false
  for (const item of value) if (!isItem(item)) return false
  return true
}

/** 只校验快照的最小结构：正文是引擎的字符串文档流，其余结构由引擎自己解释。 */
function isWordSnapshot(value: unknown): value is WordSnapshotData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const body = (value as Record<string, unknown>).body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const stream = (body as Record<string, unknown>).dataStream
  return isString(stream) && stream.length > 0 && stream.endsWith('\n')
}

function isExcelStyle(value: unknown): value is ExcelStyle {
  return hasKeys(value, [...EMPHASIS, 'color', 'background', 'numberFormat']) && isEmphasis(value)
    && (value.color === undefined || isColor(value.color))
    && (value.background === undefined || isColor(value.background))
    && (value.numberFormat === undefined || isNativeText(value.numberFormat, 255))
}

function isCoordinate(value: unknown, limit: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value < limit
}

function isExcelValue(value: unknown): boolean {
  return value === null || isNativeText(value, MAX_TEXT)
    || typeof value === 'boolean' || isFiniteNumber(value)
}

function isExcelCell(value: unknown): value is ExcelCell {
  return hasKeys(value, ['row', 'column', 'value', 'formula', 'style'])
    && isCoordinate(value.row, MAX_ROWS) && isCoordinate(value.column, MAX_COLUMNS) && isExcelValue(value.value)
    && (value.formula === undefined || (isNativeText(value.formula, MAX_FORMULA) && value.formula.length > 1 && value.formula.startsWith('=')))
    && (value.style === undefined || isExcelStyle(value.style))
}

function isExcelMerge(value: unknown): value is ExcelMerge {
  return hasKeys(value, ['startRow', 'startColumn', 'endRow', 'endColumn'])
    && isCoordinate(value.startRow, MAX_ROWS) && isCoordinate(value.endRow, MAX_ROWS) && value.endRow >= value.startRow
    && isCoordinate(value.startColumn, MAX_COLUMNS) && isCoordinate(value.endColumn, MAX_COLUMNS) && value.endColumn >= value.startColumn
    && (value.endColumn !== value.startColumn || value.endRow !== value.startRow)
}

function unique<T>(values: readonly T[], key: (value: T) => string): boolean {
  const seen = new Set<string>()
  for (const value of values) {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}

function isExcelSheet(value: unknown): value is ExcelSheet {
  return hasKeys(value, ['id', 'name', 'cells', 'merges']) && isNativeText(value.id, 128) && value.id.trim() !== ''
    && !/[\r\n\t]/u.test(value.id) && !Object.hasOwn(Object.prototype, value.id)
    && isNativeText(value.name, 31) && value.name.trim() !== '' && value.name.toLowerCase() !== 'history'
    && !/[\[\]:*?/\\\t\r\n]|^'|'$/u.test(value.name)
    && isArrayOf(value.cells, isExcelCell) && unique(value.cells, cell => `${cell.row}:${cell.column}`)
    && (value.merges === undefined || isArrayOf(value.merges, isExcelMerge))
}

/**
 * 校验版本、文档类型与完整字段集合；不能识别的格式不进入编辑器或覆盖原文件。
 * @param value - 待校验的协议数据。
 * @param kind - 当前正文的唯一类型。
 * @returns 是否为可无损传输的该类型文档。
 */
export function isOfficeDocument(value: unknown, kind: OfficeKind): value is OfficeDocument {
  if (kind === 'word') {
    return hasKeys(value, ['version', 'kind', 'snapshot']) && value.version === 2 && value.kind === kind
      && isWordSnapshot(value.snapshot)
  }
  return hasKeys(value, ['version', 'kind', 'sheets']) && value.version === 1 && value.kind === kind
    && isArrayOf(value.sheets, isExcelSheet) && value.sheets.length > 0 && unique(value.sheets, sheet => sheet.id)
    && unique(value.sheets, sheet => sheet.name.toUpperCase())
    && value.sheets.length <= MAX_SHEETS
    && value.sheets.reduce((total, sheet) => total + sheet.cells.length, 0) <= MAX_CELLS
    && value.sheets.reduce((total, sheet) => total + (sheet.merges?.length ?? 0), 0) <= MAX_MERGES
}

/**
 * 校验完整回执，防止错路径、错类型或不识别的结构进入编辑器。
 * @param value - 尚未验证的响应。
 * @param path - 发起请求时绑定的笔记路径。
 * @param kind - 该路径在当前插槽声明的类型。
 * @returns 是否可用作读取快照和下一次写入的条件。
 */
export function isOfficeSnapshot(value: unknown, path: string, kind: OfficeKind): value is OfficeSnapshot {
  return hasKeys(value, ['path', 'revision', 'document']) && value.path === path
    && typeof value.revision === 'string' && value.revision.length > 0 && isOfficeDocument(value.document, kind)
}
