/** 将已安全预检的 SpreadsheetML 转换为文件库的稀疏工作簿。 */
import type { ExcelCell, ExcelMerge, ExcelSheet, OfficeDocument } from '../types.ts'
import { newExcelSheet, OfficeBudget, OFFICE_MAX_CELLS, OFFICE_MAX_COLUMNS, OFFICE_MAX_MERGES, OFFICE_MAX_ROWS, OFFICE_MAX_SHEETS, OFFICE_MAX_TEXT } from './document.ts'
import { readExcelStyles } from './excel-styles.ts'
import { decodeExcelString, excelNamespace, excelUnsigned, parseExcelAddress } from './excel-xml.ts'
import { shiftOfficeFormula, validateOfficeFormula } from './formula.ts'
import type { OfficePackage } from './package.ts'
import { OFFICE_REL_NS, OFFICE_STRICT_REL_NS, xmlAttr, xmlChild, xmlChildren, xmlText, type XmlElement } from './xml.ts'

export { exportExcel } from './excel-export.ts'

type SharedStrings = (index: number) => string

function* elements(parent: XmlElement | undefined, local: string, uri: string): IterableIterator<XmlElement> {
  for (const node of parent?.children ?? []) {
    if (typeof node !== 'string' && node.local === local && node.uri === uri) yield node
  }
}

function checkTextLength(length: number): void {
  if (length > OFFICE_MAX_TEXT) throw new TypeError('Excel 单元格文字超出长度上限')
}

function plainString(value: string): string {
  const text = decodeExcelString(value)
  checkTextLength(text.length)
  return text
}

function richString(node: XmlElement, uri: string): string {
  const pieces: string[] = []
  let length = 0
  for (const child of node.children) {
    if (typeof child === 'string' || child.uri !== uri) continue
    const text = child.local === 't' ? child : child.local === 'r' ? xmlChild(child, 't', uri) : undefined
    if (!text) continue
    // 转义按各个文本元素解释；拼接后的字面量不能再次解码。
    const piece = plainString(xmlText(text))
    if (!piece) continue
    length += piece.length
    checkTextLength(length)
    pieces.push(piece)
  }
  return pieces.join('')
}

function sharedStrings(packageFile: OfficePackage): SharedStrings {
  const path = packageFile.related(packageFile.main, 'sharedStrings')
  if (path === undefined) return () => { throw new TypeError('Excel 单元格引用了缺失的共享字符串部件') }
  const root = packageFile.xml(path)
  const uri = excelNamespace(root, 'sst')
  const entries = xmlChildren(root, 'si', uri)
  const decoded = new Map<number, string>()
  return (index) => {
    const cached = decoded.get(index)
    if (cached !== undefined) return cached
    const entry = entries[index]
    if (!entry) throw new TypeError('Excel 共享字符串索引超出范围')
    const text = richString(entry, uri)
    decoded.set(index, text)
    return text
  }
}

const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?$/u

function readValue(node: XmlElement, uri: string, shared: SharedStrings): ExcelCell['value'] {
  const type = xmlAttr(node, 't') ?? 'n'
  if (type === 'inlineStr') {
    const inline = xmlChild(node, 'is', uri)
    return inline ? richString(inline, uri) : null
  }
  const element = xmlChild(node, 'v', uri)
  if (!element) return null
  const raw = xmlText(element)
  // 原生模型没有日期或错误值类型；保留 ISO 日期和错误文本，不把它们转换为公式。
  if (type === 'str' || type === 'e' || type === 'd') return plainString(raw)
  const value = raw.trim()
  if (!value) return null
  if (type === 's') return shared(excelUnsigned(value, '共享字符串索引'))
  if (type === 'b') {
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false') return false
    throw new TypeError('Excel 布尔值无效')
  }
  if (type === 'n') {
    const number = Number(value)
    if (DECIMAL.test(value) && Number.isFinite(number)) return number
    throw new TypeError('Excel 数值无效或超出范围')
  }
  throw new TypeError('Excel 单元格值类型不受支持')
}

interface SharedFormula {
  cell: ExcelCell
  formula: string
}

class SheetFormulas {
  // 先收集锚点，允许来源文件中的共享公式从属格出现在锚点之前。
  private readonly anchors = new Map<number, SharedFormula>()
  private readonly followers: Array<{ cell: ExcelCell; index: number }> = []

  constructor(private readonly budget: OfficeBudget) {}

  read(cell: ExcelCell, node: XmlElement): void {
    const type = xmlAttr(node, 't') ?? 'normal'
    const text = xmlText(node).trim()
    if (type === 'shared') {
      const rawIndex = xmlAttr(node, 'si')
      if (rawIndex === undefined) throw new TypeError('Excel 共享公式缺少索引')
      const index = excelUnsigned(rawIndex, '共享公式索引')
      if (!text) {
        this.followers.push({ cell, index })
        return
      }
      if (this.anchors.has(index)) throw new TypeError('Excel 共享公式有重复锚点')
      const formula = this.readFormula(text)
      cell.formula = formula
      this.anchors.set(index, { cell, formula })
      return
    }
    if (type !== 'normal' && type !== 'array' && type !== 'dataTable') throw new TypeError('Excel 公式类型不受支持')
    // 数组公式和模拟运算表仅保留可表示的表达式和缓存，不重建区域语义。
    if (text) cell.formula = this.readFormula(text)
    else if (type === 'normal') throw new TypeError('Excel 单元格公式缺少表达式')
  }

  finish(): void {
    for (const { cell, index } of this.followers) {
      const anchor = this.anchors.get(index)
      if (!anchor) throw new TypeError('Excel 共享公式缺少锚点')
      const formula = shiftOfficeFormula(anchor.formula, cell.row - anchor.cell.row, cell.column - anchor.cell.column)
      cell.formula = this.budget.text(formula)
    }
  }

  private readFormula(text: string): string {
    return this.budget.text(validateOfficeFormula(text.startsWith('=') ? text : `=${text}`))
  }
}

function worksheetRow(node: XmlElement, previous: number, uri: string): number {
  const raw = xmlAttr(node, 'r')
  if (raw !== undefined) return excelUnsigned(raw, '行号') - 1
  for (const cell of elements(node, 'c', uri)) {
    const reference = xmlAttr(cell, 'r')
    if (reference !== undefined) return parseExcelAddress(reference).row
  }
  return previous + 1
}

function worksheetMerges(root: XmlElement, uri: string, budget: OfficeBudget): ExcelMerge[] {
  const merges: ExcelMerge[] = []
  for (const node of elements(xmlChild(root, 'mergeCells', uri), 'mergeCell', uri)) {
    if (++budget.merges > OFFICE_MAX_MERGES) throw new TypeError('Excel 合并区域数超出上限')
    const bounds = xmlAttr(node, 'ref')?.split(':', 3)
    if (bounds?.length !== 2 || !bounds[0] || !bounds[1]) throw new TypeError('Excel 合并区域引用无效')
    const start = parseExcelAddress(bounds[0])
    const end = parseExcelAddress(bounds[1])
    merges.push({ startRow: start.row, startColumn: start.column, endRow: end.row, endColumn: end.column })
  }
  return merges
}

interface WorkbookDecode {
  budget: OfficeBudget
  shared: SharedStrings
  style: ReturnType<typeof readExcelStyles>
}

function readWorksheet(sheet: ExcelSheet, root: XmlElement, decode: WorkbookDecode): ExcelSheet {
  const uri = excelNamespace(root, 'worksheet')
  const data = xmlChild(root, 'sheetData', uri)
  if (!data) throw new TypeError('Excel 工作表缺少单元格数据部件')
  const { budget, shared, style } = decode
  const formulas = new SheetFormulas(budget)
  let row = -1
  for (const rowNode of elements(data, 'row', uri)) {
    row = worksheetRow(rowNode, row, uri)
    if (row < 0 || row >= OFFICE_MAX_ROWS) throw new TypeError('Excel 行号超出笔记范围')
    let column = -1
    for (const node of elements(rowNode, 'c', uri)) {
      if (++budget.cells > OFFICE_MAX_CELLS) throw new TypeError('Excel 单元格数超出上限')
      const reference = xmlAttr(node, 'r')
      if (reference === undefined) column++
      else {
        const position = parseExcelAddress(reference)
        if (position.row !== row) throw new TypeError('Excel 单元格引用与所属行不一致')
        column = position.column
      }
      if (column >= OFFICE_MAX_COLUMNS) throw new TypeError('Excel 列号超出笔记范围')
      const value = readValue(node, uri, shared)
      // 共享字符串在 XLSX 只出现一次，在原生文件却要按每个引用格计算。
      const cell: ExcelCell = { row, column, value: typeof value === 'string' ? budget.text(value) : value }
      const format = style(xmlAttr(node, 's'))
      if (format !== undefined) cell.style = { ...format }
      const formula = xmlChild(node, 'f', uri)
      if (formula) formulas.read(cell, formula)
      sheet.cells.push(cell)
    }
  }
  formulas.finish()
  const merges = worksheetMerges(root, uri, budget)
  if (merges.length) sheet.merges = merges
  return sheet
}

/**
 * 导入按工作簿顺序排列的工作表，不计算公式，也不保留超出笔记模型的版式与对象。
 * @param packageFile 已完成 ZIP、XML 与关系安全预检的 Excel 包。
 * @returns 尚需外层校验并序列化的原生工作簿；部件无效、不受支持或超限时抛出 TypeError。
 */
export function importExcel(packageFile: OfficePackage): Extract<OfficeDocument, { kind: 'excel' }> {
  const root = packageFile.xml(packageFile.main)
  const uri = excelNamespace(root, 'workbook')
  const source: XmlElement[] = []
  for (const sheet of elements(xmlChild(root, 'sheets', uri), 'sheet', uri)) {
    if (source.length >= OFFICE_MAX_SHEETS) throw new TypeError('Excel 工作表数超出上限')
    source.push(sheet)
  }
  if (!source.length) throw new TypeError('Excel 工作簿没有工作表')
  const decode: WorkbookDecode = {
    budget: new OfficeBudget(), shared: sharedStrings(packageFile), style: readExcelStyles(packageFile),
  }
  const sheets = source.map((node) => {
    const name = xmlAttr(node, 'name')
    const id = xmlAttr(node, 'id', OFFICE_REL_NS) ?? xmlAttr(node, 'id', OFFICE_STRICT_REL_NS)
    if (name === undefined || !id) throw new TypeError('Excel 工作表缺少名称或包关系')
    const sheet = newExcelSheet(decodeExcelString(name))
    return readWorksheet(sheet, packageFile.xml(packageFile.relation(packageFile.main, id, 'worksheet')), decode)
  })
  return { version: 1, kind: 'excel', sheets }
}
