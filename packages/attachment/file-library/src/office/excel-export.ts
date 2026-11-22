/** 生成只含文件库可表示内容的 SpreadsheetML ZIP，不复制来源部件。 */
import { zipSync } from 'fflate'
import type { ExcelCell, ExcelSheet, OfficeDocument } from '../types.ts'
import { ExcelStyleWriter } from './excel-styles.ts'
import { escapeExcelString, excelAddress } from './excel-xml.ts'
import { CONTENT_TYPES_NS, escapeXml, EXCEL_NS, OFFICE_REL_NS, PACKAGE_REL_NS } from './xml.ts'

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const encoder = new TextEncoder()

function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${OFFICE_REL_NS}/${type}" Target="${target}"/>`
}

function relationships(entries: string[]): string {
  return `<Relationships xmlns="${PACKAGE_REL_NS}">${entries.join('')}</Relationships>`
}

function contentType(part: string, type: string): string {
  return `<Override PartName="/${part}" ContentType="${EXCEL_CONTENT_TYPE}.${type}+xml"/>`
}

function cellXml(cell: ExcelCell, styles: ExcelStyleWriter): string {
  const styleId = styles.id(cell.style)
  const address = excelAddress(cell.row, cell.column)
  const head = `<c r="${address}"${styleId ? ` s="${styleId}"` : ''}`
  const { value } = cell
  const formula = cell.formula === undefined ? '' : `<f>${escapeXml(cell.formula.slice(1))}</f>`
  if (value === null) return formula ? `${head}>${formula}</c>` : `${head}/>`
  if (typeof value === 'boolean') return `${head} t="b">${formula}<v>${value ? 1 : 0}</v></c>`
  if (typeof value === 'number') return `${head}>${formula}<v>${Object.is(value, -0) ? '-0' : value}</v></c>`
  const text = escapeExcelString(value)
  if (formula) return `${head} t="str">${formula}<v>${text}</v></c>`
  // 用显式字符串表示所有文本，包括以等号开头的文本。
  return `${head} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`
}

function worksheetXml(sheet: ExcelSheet, styles: ExcelStyleWriter): string {
  const cells = [...sheet.cells].sort((a, b) => a.row - b.row || a.column - b.column)
  const content = [`<worksheet xmlns="${EXCEL_NS}"><sheetData>`]
  let row = -1
  for (const cell of cells) {
    if (row !== cell.row) {
      if (row >= 0) content.push('</row>')
      row = cell.row
      content.push(`<row r="${row + 1}">`)
    }
    content.push(cellXml(cell, styles))
  }
  if (row >= 0) content.push('</row>')
  content.push('</sheetData>')
  if (sheet.merges?.length) {
    content.push(`<mergeCells count="${sheet.merges.length}">`)
    for (const merge of sheet.merges) {
      const start = excelAddress(merge.startRow, merge.startColumn)
      const end = excelAddress(merge.endRow, merge.endColumn)
      content.push(`<mergeCell ref="${start}:${end}"/>`)
    }
    content.push('</mergeCells>')
  }
  content.push('</worksheet>')
  return content.join('')
}

/**
 * 将已校验的工作簿写成真实 XLSX；不计算公式或把普通文本解释为公式。
 * @param document 已通过原生文档校验的 Excel 工作簿；不修改传入对象。
 * @returns 可直接下载的 XLSX 字节；再次导入仍受文件库的大小和格式限制。
 */
export function exportExcel(document: Extract<OfficeDocument, { kind: 'excel' }>): Uint8Array {
  const parts: Record<string, Uint8Array> = {}
  const addPart = (path: string, body: string) => { parts[path] = encoder.encode(XML_HEADER + body) }
  const workbook = 'xl/workbook.xml'
  const types = [contentType(workbook, 'sheet.main'), contentType('xl/styles.xml', 'styles')]
  const workbookRelationships = [relationship('rIdStyles', 'styles', 'styles.xml')]
  const sheetEntries: string[] = []
  const styles = new ExcelStyleWriter()
  for (const [index, sheet] of document.sheets.entries()) {
    const sheetId = index + 1
    const id = `rId${sheetId}`
    const target = `worksheets/sheet${sheetId}.xml`
    sheetEntries.push(`<sheet name="${escapeExcelString(sheet.name)}" sheetId="${sheetId}" r:id="${id}"/>`)
    workbookRelationships.push(relationship(id, 'worksheet', target))
    types.push(contentType(`xl/${target}`, 'worksheet'))
    addPart(`xl/${target}`, worksheetXml(sheet, styles))
  }
  addPart('[Content_Types].xml', `<Types xmlns="${CONTENT_TYPES_NS}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${types.join('')}</Types>`)
  addPart('_rels/.rels', relationships([relationship('rId1', 'officeDocument', workbook)]))
  addPart(workbook, `<workbook xmlns="${EXCEL_NS}" xmlns:r="${OFFICE_REL_NS}"><sheets>${sheetEntries.join('')}</sheets>`
    + '<calcPr calcMode="auto" fullCalcOnLoad="1"/></workbook>')
  addPart('xl/_rels/workbook.xml.rels', relationships(workbookRelationships))
  addPart('xl/styles.xml', styles.xml())
  return zipSync(parts)
}
