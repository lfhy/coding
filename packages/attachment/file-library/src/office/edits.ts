/** Office 编辑批次先验证所有操作，在独立快照中应用，磁盘提交由笔记存储负责。 */
import type { ExcelSheet, OfficeDocument, OfficeEdit } from '../types.ts'
import {
  blankWordParagraph, excelSheetId, excelSheetName, newExcelSheet, OfficeBudget, officeArray, officeCellKey,
  officeInteger, officeRecord, officeText, OFFICE_MAX_COLUMNS, OFFICE_MAX_PARAGRAPHS, OFFICE_MAX_ROWS,
  OFFICE_MAX_SHEETS, OFFICE_MAX_TEXT, parseExcelCells, parseOfficeDocument, parseWordParagraph,
} from './document.ts'
import { readWordBlocks, setWordTableCells, writeWordBlocks, type WordBlock } from './word-snapshot.ts'

/** 编辑批次与一次单元格替换的上限，不接受空批次。 */
const MAX_EDITS = 32
const MAX_SET_CELLS = 256

/** 校验模型编辑载荷；拒绝未知操作、额外字段和重复坐标。 */
export function parseOfficeEdits(value: unknown): OfficeEdit[] {
  const source = officeArray(value, MAX_EDITS, '办公笔记编辑批次')
  if (source.length === 0) throw new TypeError('办公笔记编辑批次不能为空')
  const budget = new OfficeBudget()
  return Array.from(source, (item) => {
    const keys = ['op', 'index', 'paragraph', 'sheetId', 'cells', 'name', 'tableId']
    const { op } = officeRecord(item, keys, '办公笔记编辑')
    switch (op) {
      case 'replace_paragraph':
      case 'insert_paragraph': {
        const { index, paragraph } = officeRecord(item, ['op', 'index', 'paragraph'], '段落编辑')
        return { op, index: officeInteger(index, OFFICE_MAX_PARAGRAPHS, '段落位置'), paragraph: parseWordParagraph(paragraph, budget) }
      }
      case 'delete_paragraph': {
        const { index } = officeRecord(item, ['op', 'index'], '段落编辑')
        return { op, index: officeInteger(index, OFFICE_MAX_PARAGRAPHS, '段落位置') }
      }
      case 'set_table_cells': {
        const { tableId, cells } = officeRecord(item, ['op', 'tableId', 'cells'], '表格单元格编辑')
        const list = officeArray(cells, MAX_SET_CELLS, '表格单元格数')
        return {
          op,
          tableId: budget.text(officeText(tableId, 128, '表格标识')),
          cells: Array.from(list, (raw) => {
            const cell = officeRecord(raw, ['row', 'column', 'text'], '表格单元格')
            return {
              row: officeInteger(cell.row, OFFICE_MAX_ROWS - 1, '行坐标'),
              column: officeInteger(cell.column, OFFICE_MAX_COLUMNS - 1, '列坐标'),
              text: budget.wordText(officeText(cell.text, OFFICE_MAX_TEXT, '单元格文字')),
            }
          }),
        }
      }
      case 'set_cells': {
        const { sheetId, cells } = officeRecord(item, ['op', 'sheetId', 'cells'], '单元格编辑')
        return { op, sheetId: excelSheetId(sheetId), cells: parseExcelCells(cells, MAX_SET_CELLS, budget) }
      }
      case 'add_sheet': {
        const { name } = officeRecord(item, ['op', 'name'], '新建工作表编辑')
        return { op, name: excelSheetName(name) }
      }
      case 'rename_sheet': {
        const { sheetId, name } = officeRecord(item, ['op', 'sheetId', 'name'], '工作表改名编辑')
        return { op, sheetId: excelSheetId(sheetId), name: excelSheetName(name) }
      }
      case 'delete_sheet': {
        const { sheetId } = officeRecord(item, ['op', 'sheetId'], '删除工作表编辑')
        return { op, sheetId: excelSheetId(sheetId) }
      }
      default: throw new TypeError('办公笔记编辑操作无效')
    }
  })
}

/** 段落索引只在段落块之间计数；表格与图片块原地保留，编辑后仍有完整正文。 */
function applyWordEdits(blocks: WordBlock[], edits: readonly OfficeEdit[]): void {
  const paragraphs = (): number[] => blocks.flatMap((block, index) => (block.kind === 'paragraph' ? [index] : []))
  for (const edit of edits) {
    const positions = paragraphs()
    switch (edit.op) {
      case 'replace_paragraph': {
        const target = positions[edit.index]
        if (target === undefined) throw new TypeError('Word 段落不存在')
        blocks[target] = { kind: 'paragraph', paragraph: edit.paragraph }
        break
      }
      case 'insert_paragraph': {
        if (edit.index > positions.length || positions.length >= OFFICE_MAX_PARAGRAPHS) {
          throw new TypeError('Word 段落位置或数量无效')
        }
        const previous = positions[edit.index - 1]
        const at = previous === undefined ? (positions[0] ?? blocks.length) : previous + 1
        blocks.splice(at, 0, { kind: 'paragraph', paragraph: edit.paragraph })
        break
      }
      case 'delete_paragraph': {
        const target = positions[edit.index]
        if (target === undefined) throw new TypeError('Word 段落不存在')
        blocks.splice(target, 1)
        break
      }
      default: throw new TypeError('Excel 编辑不能应用于 Word 笔记')
    }
  }
  if (!blocks.some(block => block.kind === 'paragraph')) {
    blocks.push({ kind: 'paragraph', paragraph: blankWordParagraph() })
  }
}

function assertUniqueName(sheets: readonly ExcelSheet[], name: string, exceptId?: string): void {
  if (sheets.some(sheet => sheet.id !== exceptId && sheet.name.toUpperCase() === name.toUpperCase())) {
    throw new TypeError('工作表名称重复')
  }
}

function applyExcelEdits(sheets: ExcelSheet[], edits: readonly OfficeEdit[]): void {
  for (const edit of edits) {
    if (edit.op === 'add_sheet') {
      if (sheets.length >= OFFICE_MAX_SHEETS) throw new TypeError('Excel 工作表过多')
      assertUniqueName(sheets, edit.name)
      sheets.push(newExcelSheet(edit.name))
      continue
    }
    if (edit.op !== 'set_cells' && edit.op !== 'rename_sheet' && edit.op !== 'delete_sheet') {
      throw new TypeError('Word 编辑不能应用于 Excel 笔记')
    }
    const index = sheets.findIndex(sheet => sheet.id === edit.sheetId)
    const sheet = sheets[index]
    if (sheet === undefined) throw new TypeError('Excel 工作表不存在')
    if (edit.op === 'delete_sheet') {
      if (sheets.length === 1) throw new TypeError('Excel 工作簿必须至少保留一张工作表')
      sheets.splice(index, 1)
    } else if (edit.op === 'rename_sheet') {
      assertUniqueName(sheets, edit.name, sheet.id)
      sheets[index] = { ...sheet, name: edit.name }
    } else {
      const cells = new Map(sheet.cells.map(cell => [officeCellKey(cell), cell]))
      for (const cell of edit.cells) {
        const key = officeCellKey(cell)
        if (cell.value === null && cell.formula === undefined && cell.style === undefined) cells.delete(key)
        else cells.set(key, cell)
      }
      sheets[index] = { ...sheet, cells: [...cells.values()] }
    }
  }
}

/** 按顺序应用编辑并重新检查整篇文档的预算；失败不改动传入快照。 */
export function applyOfficeEdits(document: OfficeDocument, edits: readonly OfficeEdit[]): OfficeDocument {
  if (document.kind === 'word') {
    const paragraphs = edits.filter(edit => edit.op !== 'set_table_cells')
    const cells = edits.filter(edit => edit.op === 'set_table_cells')
    const blocks = readWordBlocks(document.snapshot)
    applyWordEdits(blocks, paragraphs)
    let snapshot = writeWordBlocks(blocks, document.snapshot)
    for (const edit of cells) snapshot = setWordTableCells(snapshot, edit.tableId, edit.cells)
    return parseOfficeDocument({ ...document, snapshot }, document.kind)
  }
  const sheets = [...document.sheets]
  applyExcelEdits(sheets, edits)
  return parseOfficeDocument({ ...document, sheets }, document.kind)
}
