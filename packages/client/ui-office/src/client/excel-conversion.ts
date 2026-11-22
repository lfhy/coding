/** 在笔记文档与编辑器快照之间转换；不加载编辑器，也不保留无法写回的编辑。 */
import type {
  BorderStyleTypes, CellValueType, DateSystem, ICellData, IStyleData, IWorkbookData, IWorksheetData, LocaleType, TextDecoration,
} from '@univerjs/presets'
import type { ExcelCell, ExcelDocument, ExcelMerge, ExcelSheet, ExcelStyle } from './office-document.ts'

type WorkbookStyles = IWorkbookData['styles']
type MutableStyle = { -readonly [Key in keyof ExcelStyle]: ExcelStyle[Key] }
type CellDocument = Exclude<ICellData['p'], null | void>
type SheetMerge = IWorksheetData['mergeData'][number]

// 行列和内容上限与笔记保存协议一致；空白网格采用编辑器 1.5.0 的默认大小。
const MAX_ROWS = 100_000
const MAX_COLUMNS = 1_024
const MAX_SHEETS = 32
const MAX_CELLS = 50_000
const MAX_MERGES = 2_048
const MAX_TEXT_LENGTH = 32_767
const MAX_FORMULA_LENGTH = 8_192
const MAX_FORMAT_LENGTH = 255
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_ROWS = 1_000
const DEFAULT_COLUMNS = 20
const DEFAULT_ROW_HEIGHT = 24
const DEFAULT_COLUMN_WIDTH = 88
const LOCALE = 'zhCN' as LocaleType.ZH_CN
const DEFAULT_DATE_SYSTEM = 'date1900' as DateSystem.Date1900
const CELL_TYPE: Readonly<Record<'text' | 'number' | 'boolean' | 'forcedText', CellValueType>> = {
  text: 1, number: 2, boolean: 3, forcedText: 4,
}
const NO_BORDER = 0 as BorderStyleTypes.NONE
const SINGLE_LINE = 12 as TextDecoration.SINGLE
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u
const HEX_COLOR = /^#[\da-f]{6}$/iu
const TEXT_FLAGS = ['bold', 'italic', 'underline', 'strike'] as const
const BORDER_SIDES = ['t', 'r', 'b', 'l', 'tl_br', 'tl_bc', 'tl_mr', 'bl_tr', 'ml_tr', 'bc_tr'] as const

function requireSupported(condition: unknown): asserts condition {
  if (!condition) throw new Error('表格包含无法保存的内容。')
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !INVALID_TEXT.test(value)
}

function checkSheetId(id: unknown): asserts id is string {
  requireSupported(isText(id, 128) && id.trim() !== '' && !/[\t\r\n]/u.test(id) && !Object.hasOwn(Object.prototype, id))
}

function checkSheetName(name: unknown): asserts name is string {
  requireSupported(isText(name, 31) && name.trim() !== '' && !/[\[\]:*?/\\\t\r\n]|^'|'$/u.test(name))
  requireSupported(name.toLowerCase() !== 'history')
}

function checkPosition(row: number, column: number): void {
  requireSupported(Number.isInteger(row) && row >= 0 && row < MAX_ROWS)
  requireSupported(Number.isInteger(column) && column >= 0 && column < MAX_COLUMNS)
}

function checkFormula(formula: string): void {
  requireSupported(isText(formula, MAX_FORMULA_LENGTH) && formula.startsWith('='))
}

function copyMerge(merge: ExcelMerge): ExcelMerge {
  const { startRow, startColumn, endRow, endColumn } = merge
  checkPosition(startRow, startColumn)
  checkPosition(endRow, endColumn)
  requireSupported(endRow >= startRow && endColumn >= startColumn && (endRow > startRow || endColumn > startColumn))
  return { startRow, startColumn, endRow, endColumn }
}

function copyMerges<T extends ExcelMerge>(merges: readonly T[], check: (raw: T) => void): ExcelMerge[] {
  const result: ExcelMerge[] = []
  for (const merge of merges) {
    check(merge)
    const range = copyMerge(merge)
    requireSupported(!result.some(other => range.startRow <= other.endRow && range.endRow >= other.startRow
      && range.startColumn <= other.endColumn && range.endColumn >= other.startColumn))
    result.push(range)
  }
  return result
}

function toStyle(style: ExcelStyle): IStyleData {
  const result: IStyleData = {}
  if (style.bold !== undefined) result.bl = style.bold ? 1 : 0
  if (style.italic !== undefined) result.it = style.italic ? 1 : 0
  if (style.underline !== undefined) result.ul = { s: style.underline ? 1 : 0 }
  if (style.strike !== undefined) result.st = { s: style.strike ? 1 : 0 }
  if (style.color !== undefined) {
    requireSupported(HEX_COLOR.test(style.color))
    result.cl = { rgb: style.color }
  }
  if (style.background !== undefined) {
    requireSupported(HEX_COLOR.test(style.background))
    result.bg = { rgb: style.background }
  }
  if (style.numberFormat !== undefined) {
    requireSupported(isText(style.numberFormat, MAX_FORMAT_LENGTH))
    result.n = { pattern: style.numberFormat }
  }
  return result
}

function toCellDocument(value: string, style: IStyleData | undefined): CellDocument {
  // 普通值中的 LF 不会生成可见段落；内嵌文本用 CR 拆段，以 CRLF 结束。
  const text = value.replace(/\r\n?|\n/gu, '\r')
  const paragraphs = Array.from(`${text}\r`.matchAll(/\r/gu), ({ index }) => ({
    startIndex: index,
    paragraphId: `para_${index}`,
  }))
  const { bg: _background, n: _numberFormat, ...textStyle } = structuredClone(style ?? {})
  return {
    id: 'd',
    body: {
      dataStream: `${text}\r\n`,
      paragraphs,
      sectionBreaks: [{ startIndex: text.length + 1, sectionId: 'section_0' }],
      textRuns: [{ st: 0, ed: text.length, ts: structuredClone(textStyle) }],
    },
    documentStyle: { textStyle },
  }
}

function toCell(cell: ExcelCell): ICellData {
  const { value, formula, style } = cell
  const result: ICellData = { v: value }
  if (typeof value === 'string') {
    requireSupported(isText(value, MAX_TEXT_LENGTH))
    // 普通字符串中的公式或文本前缀不是计算指令。
    result.t = formula === undefined && (value.startsWith('=') || value.startsWith("'")) ? CELL_TYPE.forcedText : CELL_TYPE.text
  } else if (typeof value === 'number') {
    requireSupported(Number.isFinite(value))
    result.t = CELL_TYPE.number
  } else if (typeof value === 'boolean') {
    // 布尔值在快照中是带布尔类型标记的 0/1，与数值 0/1 区分。
    result.v = value ? 1 : 0
    result.t = CELL_TYPE.boolean
  }
  if (formula !== undefined) {
    checkFormula(formula)
    result.f = formula
  }
  const styleData = style === undefined ? undefined : toStyle(style)
  if (styleData !== undefined) result.s = styleData
  if (formula === undefined && typeof value === 'string' && /[\r\n]/u.test(value)) {
    result.p = toCellDocument(value, styleData)
  }
  return result
}

function toSheet(sheet: ExcelSheet): Partial<IWorksheetData> {
  const { id, name } = sheet
  checkSheetId(id)
  checkSheetName(name)
  const cellData: IWorksheetData['cellData'] = {}
  let rowCount = DEFAULT_ROWS
  let columnCount = DEFAULT_COLUMNS
  for (const cell of sheet.cells) {
    const { row, column } = cell
    checkPosition(row, column)
    const rowData = cellData[row] ??= {}
    requireSupported(!Object.hasOwn(rowData, column))
    rowData[column] = toCell(cell)
    rowCount = Math.max(rowCount, row + 1)
    columnCount = Math.max(columnCount, column + 1)
  }
  const mergeData = sheet.merges && copyMerges(sheet.merges, (range) => {
    rowCount = Math.max(rowCount, range.endRow + 1)
    columnCount = Math.max(columnCount, range.endColumn + 1)
  })
  return { id, name, cellData, rowCount, columnCount, ...(mergeData && { mergeData }) }
}

/**
 * 为编辑器生成独立的工作簿快照；超出笔记内容上限或重复使用坐标时拒绝转换。
 * @param document - 已校验的笔记表格正文。
 * @param id - 当前工作簿的编辑器标识。
 * @param name - 当前工作簿的显示名称。
 * @returns 可交给编辑器加载的工作簿快照。
 */
export function toUniverWorkbook(document: ExcelDocument, id: string, name: string): IWorkbookData {
  requireSupported(document.sheets.length > 0 && document.sheets.length <= MAX_SHEETS)
  let cellCount = 0
  let mergeCount = 0
  const names = new Set<string>()
  const sheetOrder: string[] = []
  const sheets = Object.fromEntries(document.sheets.map((sheet) => {
    cellCount += sheet.cells.length
    mergeCount += sheet.merges?.length ?? 0
    requireSupported(cellCount <= MAX_CELLS && mergeCount <= MAX_MERGES)
    const data = toSheet(sheet)
    const nameKey = sheet.name.toUpperCase()
    requireSupported(!names.has(nameKey))
    names.add(nameKey)
    sheetOrder.push(sheet.id)
    return [sheet.id, data]
  }))
  requireSupported(Object.keys(sheets).length === sheetOrder.length)
  return { id, name, appVersion: '1.5.0', locale: LOCALE, styles: {}, sheetOrder, sheets }
}

function checkFields(data: object, fields: readonly string[]): void {
  for (const [key, value] of Object.entries(data)) requireSupported(value == null || fields.includes(key))
}

function isEmptyData(data: unknown): boolean {
  if (data == null) return true
  return typeof data === 'object' && Object.keys(data).length === 0
}

function checkDefaults(data: object | null | undefined, defaults: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data ?? {})) {
    requireSupported(value == null || Object.hasOwn(defaults, key) && value === defaults[key])
  }
}

function resolveStyle(style: ICellData['s'], styles: WorkbookStyles): IStyleData | undefined {
  if (typeof style !== 'string') return style ?? undefined
  if (style === '') return
  requireSupported(Object.hasOwn(styles, style) && styles[style] != null)
  return styles[style]
}

function fromFlag(flag: unknown): boolean | undefined {
  if (flag == null) return
  requireSupported(flag === 0 || flag === 1)
  return flag === 1
}

function fromDecoration(decoration: IStyleData['ul']): boolean | undefined {
  if (decoration == null) return
  checkFields(decoration, ['s', 'c', 'cl', 't'])
  const show = fromFlag(decoration.s)
  if (show !== false) {
    requireSupported(show === true)
    requireSupported(decoration.t == null || decoration.t === SINGLE_LINE)
    requireSupported(fromFlag(decoration.c) !== false) // 跟随文字颜色
  }
  return show
}

function rgbHex(color: string): string {
  if (HEX_COLOR.test(color)) return color
  if (/^#[\da-f]{3}$/iu.test(color)) return `#${color.slice(1).split('').map(digit => digit + digit).join('')}`
  if (/^#[\da-f]{6}ff$/iu.test(color)) return color.slice(0, 7)
  if (/^#[\da-f]{3}f$/iu.test(color)) return rgbHex(color.slice(0, 4))
  // 调色板的颜色也可能是 CSS rgb/rgba；只有不透明的颜色能写回。
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/iu.exec(color)
  requireSupported(match && ((match[1]?.toLowerCase() === 'rgba') === (match[5] !== undefined)))
  const rgb = match.slice(2, 5).map(Number)
  requireSupported(rgb.every(channel => channel <= 255))
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function fromColor(color: IStyleData['cl']): string | undefined {
  if (color == null) return
  checkFields(color, ['rgb'])
  if (color.rgb) return rgbHex(color.rgb)
}

function fromStyle(style: IStyleData | undefined): ExcelStyle | undefined {
  if (!style) return
  checkFields(style, ['bl', 'it', 'ul', 'st', 'cl', 'bg', 'n', 'ff', 'fs', 'va', 'td', 'ht', 'vt', 'tb', 'stf',
    'tr', 'pd', 'bd', 'ol', 'bbl'])
  // 仅放行明确等同于未设格式的值；其它字体、对齐、换行、边框等无法写回。
  const { ff, fs, va, td, ht, vt, tb, stf, tr, pd, bd, ol, bbl } = style
  checkDefaults({ ff, fs, va, td, ht, vt, tb, stf }, { ff: 'Arial', fs: 11, va: 1, td: 0, ht: 0, vt: 0, tb: 0, stf: 0 })
  checkDefaults(tr ?? undefined, { a: 0, v: 0 })
  requireSupported(isEmptyData(pd) && !fromDecoration(ol) && !fromDecoration(bbl))
  if (bd) {
    checkFields(bd, BORDER_SIDES)
    for (const key of BORDER_SIDES) {
      const side = bd[key]
      if (!side) continue
      checkFields(side, ['s', 'cl'])
      requireSupported(side.s === NO_BORDER)
    }
  }

  const result: MutableStyle = {}
  const flags = {
    bold: fromFlag(style.bl), italic: fromFlag(style.it),
    underline: fromDecoration(style.ul), strike: fromDecoration(style.st),
  }
  for (const key of TEXT_FLAGS) {
    const flag = flags[key]
    if (flag !== undefined) result[key] = flag
  }
  const color = fromColor(style.cl)
  const background = fromColor(style.bg)
  if (color !== undefined) result.color = color
  if (background !== undefined) result.background = background
  if (style.n != null) {
    checkFields(style.n, ['pattern'])
    requireSupported(isText(style.n.pattern, MAX_FORMAT_LENGTH))
    result.numberFormat = style.n.pattern
  }
  if (Object.keys(result).length > 0) return result
}

function checkPlainTextStyle(actual: ExcelStyle | undefined, expected: ExcelStyle | undefined): void {
  requireSupported(TEXT_FLAGS.every(key => (actual?.[key] ?? false) === (expected?.[key] ?? false)))
  requireSupported((actual?.color ?? '#000000').toLowerCase() === (expected?.color ?? '#000000').toLowerCase())
}

function fromCellTextStyle(style: IStyleData | undefined): ExcelStyle | undefined {
  if (!style) return
  checkFields(style, ['bl', 'it', 'ul', 'st', 'cl', 'ff', 'fs', 'va', 'ol', 'bbl'])
  return fromStyle(style)
}

function fromCellDocument(document: CellDocument, cellStyle: ExcelStyle | undefined, carriedValue: string | null): string {
  const { body, documentStyle } = document
  requireSupported(body && typeof body.dataStream === 'string' && body.dataStream.endsWith('\r\n'))
  const { dataStream, paragraphs, textRuns, sectionBreaks } = body
  for (const [key, value] of Object.entries(document)) {
    requireSupported(['id', 'rev', 'locale', 'body', 'documentStyle'].includes(key) || value === '' || isEmptyData(value))
  }
  for (const [key, value] of Object.entries(body)) {
    requireSupported(['dataStream', 'paragraphs', 'textRuns', 'sectionBreaks'].includes(key) || isEmptyData(value))
  }
  const { textStyle, defaultParagraphStyle, renderConfig, pageSize, ...documentDefaults } = documentStyle
  // 公式栏和单元格编辑器会写入自身的布局；单元格渲染时会用工作表布局覆盖它们。
  const { marginTop: _top, marginRight: _right, marginBottom: _bottom, marginLeft: _left, ...remainingDefaults } = documentDefaults
  checkDefaults(remainingDefaults, {
    documentFlavor: 0, paragraphLineGapDefault: 0, autoHyphenation: 1, doNotHyphenateCaps: 0, consecutiveHyphenLimit: 2,
    defaultHeaderId: '', defaultFooterId: '', evenPageHeaderId: '', evenPageFooterId: '',
    firstPageHeaderId: '', firstPageFooterId: '', evenAndOddHeaders: 0, useFirstPageHeaderFooter: 0, marginHeader: 30, marginFooter: 30,
  })
  checkDefaults(defaultParagraphStyle, { horizontalAlign: 0 })
  if (pageSize) checkFields(pageSize, ['width', 'height'])
  if (renderConfig) checkFields(renderConfig, ['horizontalAlign', 'verticalAlign', 'centerAngle', 'vertexAngle',
    'wrapStrategy', 'cellValueType', 'isRenderStyle', 'zeroWidthParagraphBreak'])
  for (const paragraph of paragraphs ?? []) {
    checkFields(paragraph, ['startIndex', 'paragraphId', 'paragraphStyle'])
    checkDefaults(paragraph.paragraphStyle, { horizontalAlign: 0 })
    requireSupported(dataStream[paragraph.startIndex] === '\r')
  }
  requireSupported((sectionBreaks?.length ?? 0) <= 1)
  for (const section of sectionBreaks ?? []) {
    checkFields(section, ['startIndex', 'sectionId'])
    requireSupported(section.startIndex === dataStream.length - 1)
  }
  const textEnd = dataStream.length - 2
  const text = dataStream.slice(0, textEnd).replace(/\r\n?/gu, '\n')
  requireSupported(isText(text, MAX_TEXT_LENGTH))
  const base = fromCellTextStyle(textStyle)
  let offset = 0
  for (const run of textRuns ?? []) {
    checkFields(run, ['st', 'ed', 'ts'])
    requireSupported(Number.isInteger(run.st) && Number.isInteger(run.ed)
      && run.st >= offset && run.ed >= run.st && run.ed <= dataStream.length)
    if (offset < Math.min(run.st, textEnd)) checkPlainTextStyle(base, cellStyle)
    if (run.st < Math.min(run.ed, textEnd)) checkPlainTextStyle({ ...base, ...fromCellTextStyle(run.ts) }, cellStyle)
    offset = run.ed
  }
  if (offset < textEnd) checkPlainTextStyle(base, cellStyle)
  // 原生文本可能混用换行符。读取自己写入的单元格时，只有段落一致才沿用原值。
  requireSupported(carriedValue === null || carriedValue.replace(/\r\n?/gu, '\n') === text)
  return carriedValue ?? text
}

// 值类型来自编辑器；undefined 区分无法作为计算缓存的值与普通空格。
function fromValue({ v, t }: ICellData): ExcelCell['value'] | undefined {
  if (v == null) return null
  if (t === CELL_TYPE.boolean) {
    if (v === 1 || v === true || typeof v === 'string' && /^true$/iu.test(v)) return true
    if (v === 0 || v === false || typeof v === 'string' && /^false$/iu.test(v)) return false
    return
  }
  if (typeof v === 'string' && (t == null || t === CELL_TYPE.text || t === CELL_TYPE.forcedText) && isText(v, MAX_TEXT_LENGTH)) return v
  if (typeof v === 'number' && (t == null || t === CELL_TYPE.number) && Number.isFinite(v)) return v
  if (typeof v === 'boolean' && t == null) return v
}

function fromCell(cell: ICellData, row: number, column: number, styles: WorkbookStyles, shared: Set<string>): ExcelCell | undefined {
  checkFields(cell, ['v', 't', 'f', 's', 'p', 'ft', 'fd', 'ref', 'xf', 'si', 'custom'])
  requireSupported(isEmptyData(cell.custom))
  checkDefaults({ ft: cell.ft, fd: cell.fd, ref: cell.ref, xf: cell.xf }, { ft: 0, fd: 0, ref: '', xf: '' })
  const formula = cell.f || undefined
  if (formula !== undefined) checkFormula(formula)
  if (cell.si) {
    // 只有一个独立公式的共享标识是冗余的；省略了原式的共享格不能当常量保存。
    requireSupported(formula !== undefined && !shared.has(cell.si))
    shared.add(cell.si)
  }
  const style = fromStyle(resolveStyle(cell.s, styles))
  let value = fromValue(cell)
  if (cell.p != null) {
    requireSupported(formula === undefined && (typeof value === 'string' || value === null))
    value = fromCellDocument(cell.p, style, value)
  }
  requireSupported(formula !== undefined || value !== undefined)
  if (cell.v === undefined && cell.p == null && formula === undefined && style === undefined) return
  return { row, column, value: value ?? null, ...(formula !== undefined && { formula }), ...(style !== undefined && { style }) }
}

const EMPTY_RESOURCES = new Set([
  'SHEET_RANGE_PROTECTION_PLUGIN',
  'SHEET_AuthzIoMockService_PLUGIN',
  'SHEET_WORKSHEET_PROTECTION_PLUGIN',
  'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
  'SHEET_DEFINED_NAME_PLUGIN',
  'SHEET_RANGE_THEME_MODEL_PLUGIN',
])

function checkWorkbook(workbook: IWorkbookData): void {
  checkFields(workbook, ['id', 'name', 'appVersion', 'locale', 'rev', 'sheetOrder', 'sheets', 'styles',
    'dateSystem', 'calculationSettings', 'defaultStyle', 'resources', 'custom'])
  requireSupported(isEmptyData(workbook.custom) && isEmptyData(resolveStyle(workbook.defaultStyle, workbook.styles)))
  requireSupported(workbook.dateSystem == null || workbook.dateSystem === DEFAULT_DATE_SYSTEM)
  checkDefaults(workbook.calculationSettings, { iterativeCalculation: false, maxIterations: 100, maxChange: 0.001 })
  // 保存时会列出预设注册的插件，即使这些插件没有持久内容。
  for (const resource of workbook.resources ?? []) {
    checkFields(resource, ['name', 'data'])
    requireSupported(EMPTY_RESOURCES.has(resource.name) && (resource.data === '' || resource.data === '{}'))
  }
}

function checkWorksheet(sheet: Partial<IWorksheetData>, styles: WorkbookStyles): void {
  checkFields(sheet, ['id', 'name', 'type', 'cellData', 'mergeData', 'rowCount', 'columnCount',
    'rowData', 'columnData', 'defaultStyle', 'tabColor', 'hidden', 'freeze', 'defaultColumnWidth', 'defaultRowHeight',
    'rowHeader', 'columnHeader', 'showGridlines', 'gridlinesColor', 'rightToLeft', 'backgroundImage', 'custom',
    'zoomRatio', 'zoomToFit', 'scrollTop', 'scrollLeft'])
  const { type, hidden, tabColor, showGridlines, gridlinesColor, rightToLeft, zoomToFit, defaultRowHeight, defaultColumnWidth } = sheet
  checkDefaults({ type, hidden, tabColor, showGridlines, gridlinesColor, rightToLeft, zoomToFit, defaultRowHeight, defaultColumnWidth }, {
    type: 0, hidden: 0, tabColor: '', showGridlines: 1, gridlinesColor: '', rightToLeft: 0, zoomToFit: 0,
    defaultRowHeight: DEFAULT_ROW_HEIGHT, defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
  })
  checkDefaults(sheet.freeze, { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 })
  checkDefaults(sheet.rowHeader, { width: 46, hidden: 0 })
  checkDefaults(sheet.columnHeader, { height: 20, hidden: 0 })
  requireSupported(sheet.backgroundImage == null && isEmptyData(sheet.custom) && isEmptyData(resolveStyle(sheet.defaultStyle, styles)))
  // 网格容量和滚动缩放不属于单元格样式；只检查容量没有超过笔记可编辑范围。
  const { rowCount, columnCount, rowData, columnData } = sheet
  if (rowCount !== undefined) requireSupported(Number.isInteger(rowCount) && rowCount > 0 && rowCount <= MAX_ROWS)
  if (columnCount !== undefined) requireSupported(Number.isInteger(columnCount) && columnCount > 0 && columnCount <= MAX_COLUMNS)
  for (const key of Object.keys(rowData ?? {})) {
    const row = rowData?.[matrixIndex(key, MAX_ROWS)]
    if (!row) continue
    checkFields(row, ['h', 'hd', 'ia', 'ah', 's', 'custom'])
    checkDefaults({ h: row.h, hd: row.hd, ia: row.ia }, { h: DEFAULT_ROW_HEIGHT, hd: 0, ia: 1 })
    // ah 由文字布局重算；h、ia 和 hd 则会保存用户的尺寸或隐藏设置。
    requireSupported(isEmptyData(resolveStyle(row.s, styles)) && isEmptyData(row.custom))
  }
  for (const key of Object.keys(columnData ?? {})) {
    const column = columnData?.[matrixIndex(key, MAX_COLUMNS)]
    if (!column) continue
    checkFields(column, ['w', 'hd', 's', 'custom'])
    checkDefaults({ w: column.w, hd: column.hd }, { w: DEFAULT_COLUMN_WIDTH, hd: 0 })
    requireSupported(isEmptyData(resolveStyle(column.s, styles)) && isEmptyData(column.custom))
  }
}

function checkMergeFields(raw: SheetMerge, unitId: string, sheetId: string): void {
  const { startRow: _row, startColumn: _column, endRow: _endRow, endColumn: _endColumn, ...metadata } = raw
  checkDefaults(metadata, { rangeType: 0, startAbsoluteRefType: 0, endAbsoluteRefType: 0, unitId, sheetId })
}

function matrixIndex(key: string, limit: number): number {
  const index = Number(key)
  requireSupported(Number.isInteger(index) && index >= 0 && index < limit && String(index) === key)
  return index
}

/**
 * 将当前工作簿转换为可写回的笔记正文；遇到不能保存的编辑时抛出不含原始数据的错误。
 * @param workbook - 编辑器保存的工作簿快照。
 * @returns 独立的笔记正文，保留表顺序、公式和有效缓存；无可用的公式缓存时填 null。
 */
export function fromUniverWorkbook(workbook: IWorkbookData): ExcelDocument {
  checkWorkbook(workbook)
  const { sheetOrder, sheets, styles } = workbook
  requireSupported(sheetOrder.length > 0 && sheetOrder.length <= MAX_SHEETS
    && new Set(sheetOrder).size === sheetOrder.length && Object.keys(sheets).length === sheetOrder.length)
  const names = new Set<string>()
  let cellCount = 0
  let mergeCount = 0
  let textLength = 0
  const document: ExcelDocument = { version: 1, kind: 'excel', sheets: sheetOrder.map((id) => {
    checkSheetId(id)
    requireSupported(Object.hasOwn(sheets, id))
    const sheet = sheets[id]
    requireSupported(sheet && (sheet.id === undefined || sheet.id === id))
    const { name } = sheet
    checkSheetName(name)
    const nameKey = name.toUpperCase()
    requireSupported(!names.has(nameKey))
    names.add(nameKey)
    checkWorksheet(sheet, styles)

    const cells: ExcelCell[] = []
    const shared = new Set<string>()
    for (const rowKey of Object.keys(sheet.cellData ?? {})) {
      const rowIndex = matrixIndex(rowKey, MAX_ROWS)
      const row = sheet.cellData?.[rowIndex]
      for (const columnKey of Object.keys(row ?? {})) {
        const columnIndex = matrixIndex(columnKey, MAX_COLUMNS)
        const cell = row?.[columnIndex]
        if (cell == null) continue
        const next = fromCell(cell, rowIndex, columnIndex, styles, shared)
        if (!next) continue
        cellCount += 1
        textLength += (typeof next.value === 'string' ? next.value.length : 0)
          + (next.formula?.length ?? 0) + (next.style?.numberFormat?.length ?? 0)
        requireSupported(cellCount <= MAX_CELLS && textLength <= MAX_DOCUMENT_BYTES)
        cells.push(next)
      }
    }
    mergeCount += sheet.mergeData?.length ?? 0
    requireSupported(mergeCount <= MAX_MERGES)
    const merges = sheet.mergeData && copyMerges(sheet.mergeData, (range) => {
      checkMergeFields(range, workbook.id, id)
    })
    return { id, name, cells, ...(merges?.length ? { merges } : {}) }
  }) }
  requireSupported(new TextEncoder().encode(JSON.stringify(document)).byteLength <= MAX_DOCUMENT_BYTES)
  return document
}
