/** Excel 进出 OOXML 时共用的坐标和字符串表示。 */
import type { ExcelCell } from '../types.ts'
import { OFFICE_MAX_COLUMNS, OFFICE_MAX_ROWS } from './document.ts'
import { escapeXml, EXCEL_NS, EXCEL_STRICT_NS, type XmlElement } from './xml.ts'

/**
 * 校验部件根元素，并保留其命名空间供子元素查找使用。
 * @param element 已通过 XML 预检的部件根元素。
 * @param local 部件预期的根元素名称。
 * @returns 普通或严格 SpreadsheetML 命名空间；不匹配时抛出 TypeError。
 */
export function excelNamespace(element: XmlElement, local: string): string {
  if (element.local !== local || (element.uri !== EXCEL_NS && element.uri !== EXCEL_STRICT_NS)) {
    throw new TypeError(`Excel 部件缺少有效的 ${local} 根元素`)
  }
  return element.uri
}

/**
 * 解析 XML 中的索引或序号，不会把缺省值误读为零。
 * @param raw XML 属性或文本。
 * @param subject 出错时标识该数值的名称。
 * @returns 非负安全整数；非法数值抛出 TypeError。
 */
export function excelUnsigned(raw: string, subject: string): number {
  const value = raw.trim()
  const number = Number(value)
  if (!/^\+?[0-9]+$/u.test(value) || !Number.isSafeInteger(number)) {
    throw new TypeError(`Excel ${subject}必须是非负整数`)
  }
  return number
}

/**
 * 将 A1 引用转换为笔记的零基坐标。
 * @param address 不含工作表名称的单格引用。
 * @returns 零基坐标；格式非法或超出笔记行列范围时抛出 TypeError。
 */
export function parseExcelAddress(address: string): Pick<ExcelCell, 'row' | 'column'> {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/u.exec(address)
  if (!match?.[1] || !match[2]) throw new TypeError('Excel 单元格引用无效')
  const row = Number(match[2]) - 1
  let column = 0
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64
  if (row >= OFFICE_MAX_ROWS || column > OFFICE_MAX_COLUMNS) throw new TypeError('Excel 单元格引用超出笔记行列范围')
  return { row, column: column - 1 }
}

/**
 * 将已校验的笔记坐标写成不带绝对标记的 A1 引用。
 * @param row 零基行号。
 * @param column 零基列号。
 * @returns XLSX 单元格引用。
 */
export function excelAddress(row: number, column: number): string {
  let letters = ''
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters
  }
  return `${letters}${row + 1}`
}

/**
 * 解码一次 ST_Xstring；转义下划线之后的字面文本不再重新解码。
 * @param value XML 实体已还原的字符串。
 * @returns Excel 字符串原文。
 */
export function decodeExcelString(value: string): string {
  return value.replace(/_x([0-9A-Fa-f]{4})_/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * 将 ST_Xstring 字面文本写入 XML，避免 Excel 把其中形似转义的文本解释成字符。
 * @param value 笔记中的字符串原文。
 * @returns 可嵌入 XML 文本或属性的 Excel 字符串。
 */
export function escapeExcelString(value: string): string {
  // 前瞻只消耗起始下划线，也能保护与前一段共用下划线的序列。
  const literal = value.replace(/_(?=x[0-9A-Fa-f]{4}_)/gu, '_x005F_')
  return escapeXml(literal.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/gu,
    char => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`))
}
