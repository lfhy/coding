/** 用实际 OOXML 包验证 Excel 导入、导出与原生字节预算。 */
import { strFromU8, strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { OFFICE_MAX_CELLS, OFFICE_MAX_SHEETS, parseOfficeDocument } from '../src/office/document.ts'
import { exportExcel, importExcel } from '../src/office/excel.ts'
import { openOfficePackage } from '../src/office/package.ts'
import { CONTENT_TYPES_NS, EXCEL_NS, EXCEL_STRICT_NS, OFFICE_REL_NS, OFFICE_STRICT_REL_NS, PACKAGE_REL_NS } from '../src/office/xml.ts'
import { readOfficeZip } from '../src/office/zip.ts'
import type { OfficeDocument } from '../src/types.ts'

interface FixtureOptions {
  strict?: boolean
  firstName?: string
  styles?: string
  strings?: string
}

function fixture(sheets: string[], options: FixtureOptions = {}): Uint8Array {
  const rel = options.strict ? OFFICE_STRICT_REL_NS : OFFICE_REL_NS
  const ns = options.strict ? EXCEL_STRICT_NS : EXCEL_NS
  const names = sheets.map((_, index) => `<sheet sheetId="${index + 1}" q:id="tab${index}" name="${(index === 0 ? options.firstName : undefined) ?? `页 ${index + 1}`}"/>`)
  // 故意不使用通常的 xl/worksheets/sheetN.xml，且部件编号顺序与工作表顺序相反。
  const targets = sheets.map((_, index) => `tables/data-${sheets.length - index}.xml`)
  const relationships = targets.map((target, index) => `<Relationship Id="tab${index}" Type="${rel}/worksheet" Target="${target}"/>`)
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="xml" ContentType="application/xml"/>`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Override PartName="/book/entry.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="main" Type="${rel}/officeDocument" Target="book/entry.xml"/></Relationships>`,
    'book/entry.xml': `<workbook xmlns="${ns}" xmlns:q="${rel}"><sheets>${names.join('')}</sheets></workbook>`,
  }
  if (options.styles) {
    relationships.push(`<Relationship Id="style" Type="${rel}/styles" Target="formats.xml"/>`)
    parts['book/formats.xml'] = `<styleSheet xmlns="${ns}">${options.styles}</styleSheet>`
  }
  if (options.strings) {
    relationships.push(`<Relationship Id="strings" Type="${rel}/sharedStrings" Target="strings.xml"/>`)
    parts['book/strings.xml'] = `<sst xmlns="${ns}">${options.strings}</sst>`
  }
  for (const [index, target] of targets.entries()) parts[`book/${target}`] = `<worksheet xmlns="${ns}">${sheets[index]}</worksheet>`
  parts['book/_rels/entry.xml.rels'] = `<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join('')}</Relationships>`
  return zipSync(Object.fromEntries(Object.entries(parts).map(([path, text]) => [path, strToU8(text)])))
}

function fromXlsx(bytes: Uint8Array) {
  return importExcel(openOfficePackage(bytes, 'excel'))
}

function partText(parts: ReadonlyMap<string, Uint8Array>, path: string): string {
  const bytes = parts.get(path)
  if (bytes === undefined) throw new Error(`缺少测试部件 ${path}`)
  return strFromU8(bytes)
}

const empty = '<sheetData/>'

function sheetData(cells: string): string {
  return `<sheetData><row r="1">${cells}</row></sheetData>`
}

describe('Excel OOXML', () => {
  it('按工作簿关系读取严格 OOXML 的稀疏行列、共享和行内文本、样式、值与合并', () => {
    const format = '0.000 "个" _x0041_'
    const document = fromXlsx(fixture([
      '<sheetData><row r="2"><c r="B2" s="1" t="s"><v>0</v></c>'
      + '<c t="inlineStr"><is><r><t>_x00</t></r><r><t>41_</t></r></is></c>'
      + '<c r="AA2" t="s"><v>1</v></c><c r="AB2" t="s"><v>2</v></c></row>'
      + '<row><c r="AA9" s="2"><v>+1.25E-3</v></c><c t="b"><v>false</v></c><c t="b"><v>1</v></c></row></sheetData>'
      + '<mergeCells><mergeCell ref="$B$4:$C$5"/></mergeCells>',
      empty,
    ], {
      strict: true,
      firstName: '收支 &amp; _x005F_x0041_',
      strings: '<si><r><t> 起_x000D_</t></r><rPh><t>忽略注音</t></rPh><r><t>_x005F_x0041_ &amp; 收 </t></r></si>'
        + '<si><t>=1+1</t></si><si><t>_xD83D__xDE00_</t></si>',
      styles: '<numFmts><numFmt numFmtId="165" formatCode="0.000 &quot;个&quot; _x005F_x0041_"/></numFmts>'
        + '<fonts><font/><font><b/><i val="0"/><u val="double"/><strike/><color rgb="8012aBcF"/></font></fonts>'
        + '<fills><fill/><fill><patternFill patternType="solid"><fgColor indexed="0"/></patternFill></fill></fills>'
        + '<cellStyleXfs><xf numFmtId="9" fontId="1" fillId="1"/></cellStyleXfs>'
        + '<cellXfs><xf/><xf xfId="0" numFmtId="165" fontId="0" fillId="0" applyFont="0" applyFill="false"/>'
        + '<xf numFmtId="9"/></cellXfs><colors><indexedColors><rgbColor rgb="FF00AA00"/></indexedColors></colors>',
    }))
    expect(document.sheets.map(sheet => sheet.name)).toEqual(['收支 & _x0041_', '页 2'])
    expect(new Set(document.sheets.map(sheet => sheet.id)).size).toBe(2)
    expect(document.sheets[0]?.cells).toEqual([
      { row: 1, column: 1, value: ' 起\r_x0041_ & 收 ', style: {
        bold: true, italic: false, underline: true, strike: true, color: '#12ABCF', background: '#00AA00', numberFormat: format,
      } },
      { row: 1, column: 2, value: '_x0041_' },
      { row: 1, column: 26, value: '=1+1' },
      { row: 1, column: 27, value: '😀' },
      { row: 8, column: 26, value: 0.00125, style: { numberFormat: '0%' } },
      { row: 8, column: 27, value: false },
      { row: 8, column: 28, value: true },
    ])
    expect(document.sheets[0]?.merges).toEqual([{ startRow: 3, startColumn: 1, endRow: 4, endColumn: 2 }])
    expect(document.sheets[1]?.cells).toEqual([])
    expect(parseOfficeDocument(document, 'excel')).toEqual(document)
  })

  it('展开同表共享公式，保留相对和绝对引用、不同类型的缓存及缺省缓存', () => {
    const document = fromXlsx(fixture([
      '<sheetData><row r="2"><c r="D2"><f t="shared" si="7"/><v>12</v></c></row>'
      + '<row r="1"><c r="B1" t="b"><f t="shared" si="7" ref="B1:D2">SUM(A1,$A$1,A$1,$A1)</f><v>1</v></c>'
      + '<c r="C1" t="str"><f>"值"</f><v> 值_x000D_ </v></c>'
      + '<c r="D1"><f>1+1</f><v/></c><c r="E1" t="str"><f>""</f><v/></c></row></sheetData>',
      sheetData('<c><f t="shared" si="7">2+2</f></c><c><f t="shared" si="7"/></c>'),
    ]))
    expect(document.sheets[0]?.cells).toEqual([
      { row: 1, column: 3, value: 12, formula: '=SUM(C2,$A$1,C$1,$A2)' },
      { row: 0, column: 1, value: true, formula: '=SUM(A1,$A$1,A$1,$A1)' },
      { row: 0, column: 2, value: ' 值\r ', formula: '="值"' },
      { row: 0, column: 3, value: null, formula: '=1+1' },
      { row: 0, column: 4, value: '', formula: '=""' },
    ])
    expect(document.sheets[1]?.cells.map(cell => cell.formula)).toEqual(['=2+2', '=2+2'])
    expect(() => fromXlsx(fixture([sheetData('<c><f t="shared" si="9"/></c>')]))).toThrow(/共享公式缺少锚点/u)
  })

  it('生成真实 XLSX，工作表排序、字面等号文本、公式缓存和基础样式可再次导入', () => {
    const literal = '=1+1\t清\r\n_x0041_x0042_ 😀 &<>" '
    const style = { bold: true, italic: false, underline: false, strike: true, color: '#123ABC', background: '#FFEEDD',
      numberFormat: '0.000 "元&项" _x0041_' }
    const document: Extract<OfficeDocument, { kind: 'excel' }> = {
      version: 1, kind: 'excel', sheets: [
        { id: 'budget', name: '预算 & _x0041_', cells: [
          { row: 99_999, column: 1_023, value: null, formula: '=2+2' },
          { row: 0, column: 1, value: true, formula: '=1<2' },
          { row: 1, column: 0, value: -12.5, formula: '=-25/2', style },
          { row: 0, column: 0, value: literal },
          { row: 1, column: 1, value: ' 清\r ', formula: '="清"' },
          { row: 2, column: 0, value: '' },
        ], merges: [{ startRow: 2, startColumn: 0, endRow: 2, endColumn: 1 }] },
        { id: 'expenses', name: '支出', cells: [{ row: 0, column: 0, value: null, style }] },
      ],
    }
    const bytes = exportExcel(document)
    const parts = readOfficeZip(bytes)
    const firstSheet = partText(parts, 'xl/worksheets/sheet1.xml')
    expect(firstSheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">=1+1')
    expect(firstSheet).toContain('<c r="B1" t="b"><f>1&lt;2</f><v>1</v></c>')
    expect(firstSheet).toContain('<c r="B2" t="str"><f>&quot;清&quot;</f><v> 清&#13; </v></c>')
    expect(firstSheet).toContain('<c r="AMJ100000"><f>2+2</f></c>')
    expect(firstSheet).toContain('<mergeCell ref="A3:B3"/>')
    expect(partText(parts, 'xl/styles.xml')).toContain('<cellXfs count="2">')
    expect(document.sheets[0]?.cells[0]?.row).toBe(99_999)
    const expected = document.sheets.map(({ id: _id, cells, ...rest }) => ({
      ...rest, cells: [...cells].sort((a, b) => a.row - b.row || a.column - b.column),
    }))
    expect(fromXlsx(bytes).sheets.map(({ id: _id, ...sheet }) => sheet)).toEqual(expected)
  })

  it('按整份工作簿限制显式工作表和单元格，不按稀疏矩形分配', () => {
    expect(() => fromXlsx(fixture(Array.from({ length: OFFICE_MAX_SHEETS + 1 }, () => empty)))).toThrow(/工作表数/u)
    const half = OFFICE_MAX_CELLS / 2
    const rows = '<row>' + '<c/>'.repeat(500) + '</row>'
    const first = `<sheetData>${rows.repeat(half / 500)}</sheetData>`
    const second = `<sheetData>${rows.repeat(half / 500)}<row><c/></row></sheetData>`
    expect(() => fromXlsx(fixture([first, second]))).toThrow(/单元格数/u)
  })

  it('共享字符串按每个引用格展开，不设总字节上限', () => {
    const value = '长'.repeat(32_000)
    const repeated = '<c t="s"><v>0</v></c>'.repeat(44)
    const options = { strings: `<si><t>${value}</t></si>` }
    expect(fromXlsx(fixture([sheetData(repeated)], options)).sheets[0]?.cells).toHaveLength(44)
    // 原生笔记不再限制文件大小，重复引用会真的展开成两份单元格。
    expect(fromXlsx(fixture([sheetData(repeated), sheetData(repeated)], options)).sheets).toHaveLength(2)
  })

  it('不把无效数字或不一致的坐标解释成其他有效值', () => {
    expect(() => fromXlsx(fixture([sheetData('<c><v>0x10</v></c>')]))).toThrow(/数值无效/u)
    expect(() => fromXlsx(fixture([sheetData('<c r="A2"/>')]))).toThrow(/所属行不一致/u)
    expect(() => fromXlsx(fixture([sheetData('<c r="AMK1"/>')]))).toThrow(/超出笔记行列范围/u)
    expect(() => fromXlsx(fixture([sheetData('<c t="s"><v>1</v></c>')], { strings: '<si><t>唯一</t></si>' }))).toThrow(/共享字符串索引/u)
  })
})
