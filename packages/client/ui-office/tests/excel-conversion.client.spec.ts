/** 固定笔记快照与编辑器快照间的保真行为；测试本身不加载编辑器。 */
import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from '@univerjs/presets'
import { describe, expect, it } from 'vitest'
import { fromUniverWorkbook, toUniverWorkbook } from '../src/client/excel-conversion.ts'
import type { ExcelCell, ExcelDocument, ExcelSheet } from '../src/client/office-document.ts'

const ERROR = '表格包含无法保存的内容。'

function documentWith(cells: readonly ExcelCell[], options: Partial<ExcelSheet> = {}): ExcelDocument {
  return { version: 1, kind: 'excel', sheets: [{ id: 'sheet', name: '数据', cells, ...options }] }
}

function snapshot(overrides: Partial<IWorksheetData> = {}): IWorkbookData {
  const workbook = toUniverWorkbook(documentWith([]), 'workbook', '测试')
  workbook.sheets.sheet = { ...workbook.sheets.sheet, ...overrides }
  return workbook
}

describe('表格快照转换', () => {
  it('保留工作表顺序、稀疏坐标、显式空值、样式、公式和合并范围', () => {
    const document: ExcelDocument = {
      version: 1,
      kind: 'excel',
      sheets: [{
        id: '9',
        name: '数据',
        cells: [
          { row: 0, column: 0, value: '00123' },
          { row: 0, column: 2, value: '=1+2' },
          { row: 0, column: 4, value: false },
          { row: 7, column: 9, value: null },
          { row: 9, column: 5, value: 0.25, formula: '=1/4', style: {
            bold: true, italic: false, underline: true, strike: true,
            color: '#12Ab34', background: '#EEDDCC', numberFormat: '0.00%',
          } },
          { row: 10, column: 5, value: null, formula: '=D9' },
        ],
        merges: [{ startRow: 9, startColumn: 5, endRow: 9, endColumn: 8 }],
      }, { id: '2', name: '空表', cells: [] }],
    }
    const original = structuredClone(document)
    const workbook = toUniverWorkbook(document, 'workbook', '账簿')
    expect(workbook).toMatchObject({
      id: 'workbook', name: '账簿', sheetOrder: ['9', '2'],
      sheets: {
        '9': {
          cellData: {
            0: { 0: { v: '00123', t: 1 }, 2: { v: '=1+2', t: 4 }, 4: { v: 0, t: 3 } },
            7: { 9: { v: null } },
            9: { 5: {
              v: 0.25, t: 2, f: '=1/4',
              s: { bl: 1, it: 0, ul: { s: 1 }, st: { s: 1 }, cl: { rgb: '#12Ab34' }, bg: { rgb: '#EEDDCC' }, n: { pattern: '0.00%' } },
            } },
          },
        },
      },
    })
    expect(workbook.sheets['9']?.cellData?.[0]?.[2]?.f).toBeUndefined()
    const before = structuredClone(workbook)
    const roundTrip = fromUniverWorkbook(workbook)
    expect(roundTrip).toEqual(document)
    expect(roundTrip.sheets[0]?.merges?.[0]).not.toBe(document.sheets[0]?.merges?.[0])
    expect(roundTrip.sheets[0]?.cells[4]?.style).not.toBe(document.sheets[0]?.cells[4]?.style)
    expect(workbook).toEqual(before)
    expect(document).toEqual(original)
  })

  it('根据最远的单元格或合并区域扩展初始网格', () => {
    const document = documentWith([{ row: 99_998, column: 1_023, value: 0 }], {
      merges: [{ startRow: 99_998, startColumn: 0, endRow: 99_999, endColumn: 0 }],
    })
    const workbook = toUniverWorkbook(document, 'w', '表格')
    expect(workbook.sheets.sheet).toMatchObject({ rowCount: 100_000, columnCount: 1_024 })
    expect(fromUniverWorkbook(workbook)).toEqual(document)
  })

  it('读取注册样式和空白格式格，只保留合法的公式缓存', () => {
    const workbook = snapshot({ cellData: {
      0: {
        0: { f: '=1', si: 'single', v: 0, t: 2 },
        1: { f: '=TRUE()', v: 1, t: 3 },
        2: { f: '=FALSE()', v: 0, t: 3 },
        3: { f: '=""', v: '', t: 1 },
        4: { f: '=A1+1' },
        5: { f: '=A1+2', v: Number.POSITIVE_INFINITY, t: 2 },
        6: { f: '=A1+3', v: 2, t: 3 },
        7: { v: '文本', t: 4 },
        8: { v: true },
        9: { t: null, s: 'display' },
        10: { p: null, f: '', t: null, s: null, si: null, ft: 0, fd: 0 },
        11: { v: false, t: 3 },
      },
    } })
    workbook.styles = {
      unused: { ff: '未引用字体', bd: { b: { s: 1, cl: { rgb: '#234567' } } } },
      display: { bl: 0, it: 1, ul: { s: 1, t: 12, c: 1 }, st: { s: 0 }, cl: { rgb: 'rgb(1, 2, 10)' },
        bg: { rgb: '#CDFf' }, n: { pattern: '0.0%' }, fs: 11, ff: 'Arial', ht: 0, tr: { a: 0 }, bd: { t: null, b: { s: 0, cl: {} } } },
    }
    expect(fromUniverWorkbook(workbook)).toEqual(documentWith([
      { row: 0, column: 0, value: 0, formula: '=1' },
      { row: 0, column: 1, value: true, formula: '=TRUE()' },
      { row: 0, column: 2, value: false, formula: '=FALSE()' },
      { row: 0, column: 3, value: '', formula: '=""' },
      { row: 0, column: 4, value: null, formula: '=A1+1' },
      { row: 0, column: 5, value: null, formula: '=A1+2' },
      { row: 0, column: 6, value: null, formula: '=A1+3' },
      { row: 0, column: 7, value: '文本' },
      { row: 0, column: 8, value: true },
      { row: 0, column: 9, value: null, style: {
        bold: false, italic: true, underline: true, strike: false, color: '#01020a', background: '#CCDDFF', numberFormat: '0.0%',
      } },
      { row: 0, column: 11, value: false },
    ]))
  })

  it('忽略实际保存产生的默认资源、视口设置和自动行高', () => {
    const workbook = snapshot({
      type: 0, tabColor: '', hidden: 0,
      freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
      rowCount: 2500, columnCount: 43, scrollTop: 80, scrollLeft: 42, zoomRatio: 1.4,
      defaultRowHeight: 24, defaultColumnWidth: 88, showGridlines: 1, rightToLeft: 0,
      rowHeader: { width: 46, hidden: 0 }, columnHeader: { height: 20, hidden: 0 },
      rowData: { 1: { ah: 32 }, 2: { h: 24, ah: 45, ia: 1, hd: 0, s: null } }, columnData: { 2: { w: 88, hd: 0 } },
      mergeData: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0, rangeType: 0 }],
    })
    workbook.calculationSettings = { iterativeCalculation: false, maxIterations: 100, maxChange: 0.001 }
    workbook.resources = [
      { name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '' },
      { name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{}' },
      { name: 'SHEET_WORKSHEET_PROTECTION_PLUGIN', data: '{}' },
      { name: 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN', data: '{}' },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: '' },
      { name: 'SHEET_RANGE_THEME_MODEL_PLUGIN', data: '{}' },
    ]
    expect(fromUniverWorkbook(workbook)).toEqual(documentWith([], {
      merges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }],
    }))
  })

  it('保留导入的换行符，并从编辑器的普通多段文本读取新换行', () => {
    const document = documentWith([
      { row: 0, column: 0, value: '甲\r\n乙\n丙\r', style: { bold: true, color: '#234567', background: '#ffffff' } },
    ])
    const workbook = toUniverWorkbook(document, 'w', '表格')
    expect(workbook.sheets.sheet?.cellData?.[0]?.[0]?.p).toMatchObject({
      body: { dataStream: '甲\r乙\r丙\r\r\n', paragraphs: [
        { startIndex: 1 }, { startIndex: 3 }, { startIndex: 5 }, { startIndex: 6 },
      ] },
    })
    expect(fromUniverWorkbook(workbook)).toEqual(document)
    const edited = snapshot({
      cellData: { 0: { 0: { v: null, p: {
        id: 'editor', drawings: {}, drawingsOrder: [],
        body: {
          dataStream: '首行\r后行\r\n',
          paragraphs: [{ startIndex: 2, paragraphId: 'p0' }, { startIndex: 5, paragraphId: 'p1', paragraphStyle: { horizontalAlign: 0 } }],
          textRuns: [{ st: 0, ed: 5, ts: {} }],
          sectionBreaks: [{ startIndex: 6, sectionId: 'section' }],
        },
        documentStyle: { renderConfig: { isRenderStyle: 1 }, pageSize: { width: 210, height: Infinity }, marginTop: 3 },
      } } } },
    })
    expect(fromUniverWorkbook(edited)).toEqual(documentWith([{ row: 0, column: 0, value: '首行\n后行' }]))
  })
})

describe('拒绝无法写回的编辑', () => {
  const worksheetEdits: [string, Partial<IWorksheetData>][] = [
    ['行高', { rowData: { 0: { h: 38, ia: 0, ah: 40 } } }],
    ['关闭自动行高', { rowData: { 0: { h: 24, ia: 0 } } }],
    ['列宽', { columnData: { 0: { w: 100 } } }],
    ['隐藏行', { rowData: { 0: { hd: 1 } } }],
    ['隐藏列', { columnData: { 0: { hd: 1 } } }],
    ['行样式', { rowData: { 0: { s: { bl: 1 } } } }],
    ['表默认样式', { defaultStyle: { it: 1 } }],
    ['默认列宽', { defaultColumnWidth: 89 }],
    ['冻结区域', { freeze: { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 } }],
    ['隐藏工作表', { hidden: 1 }],
    ['工作表颜色', { tabColor: '#012345' }],
    ['自定义表头', { rowHeader: { width: 30, hidden: 0 } }],
    ['关闭网格线', { showGridlines: 0 }],
    ['图表工作表', { type: 3 }],
    ['表自定义数据', { custom: { record: '私有字段' } }],
  ]

  it.each(worksheetEdits)('拒绝%s，而不是保存缺少该编辑的文件', (_, edit) => {
    expect(() => fromUniverWorkbook(snapshot(edit))).toThrow(ERROR)
  })

  const unsupportedStyles: [string, IStyleData][] = [
    ['边框', { bd: { t: { s: 2, cl: { rgb: '#234567' } } } }],
    ['字号', { fs: 16 }],
    ['字体', { ff: '另一款字体' }],
    ['对齐', { ht: 2 }],
    ['自动换行', { tb: 3 }],
    ['旋转', { tr: { a: 15 } }],
    ['填充透明度', { bg: { rgb: 'rgba(1, 2, 3, 0.4)' } }],
    ['下划线线型', { ul: { s: 1, t: 10 } }],
    ['下划线独立颜色', { ul: { s: 1, c: 0, cl: { rgb: '#234567' } } }],
  ]

  it.each(unsupportedStyles)('拒绝不能表示的单元格%s', (_, style) => {
    const workbook = snapshot({ cellData: { 0: { 0: { v: '原始值不进入错误', s: 'actual' } } } })
    workbook.styles.actual = style
    expect(() => fromUniverWorkbook(workbook)).toThrow(ERROR)
  })

  it('拒绝共享公式跟随格、数组公式元数据和实际富文本', () => {
    const reject = (cell: ICellData) => {
      expect(() => fromUniverWorkbook(snapshot({ cellData: { 0: { 0: cell } } }))).toThrow(ERROR)
    }
    reject({ si: 'shared', v: 2, t: 2 })
    reject({ f: '=A2', ft: 2, fd: 1, ref: 'A1:B2' })
    reject({ s: '不存在的样式' })
    reject({ v: '值类型不一致', t: 2 })
    reject({ f: 'SUM(A1)' })
    reject({ p: { id: 'd', documentStyle: {}, body: {
      dataStream: '部分加粗\r\n',
      textRuns: [{ st: 0, ed: 2, ts: { bl: 1 } }],
    } } })
  })

  it('拒绝不可表示的真实插件数据、工作簿默认样式及不同日期系统', () => {
    expect(() => fromUniverWorkbook({
      ...snapshot(),
      resources: [{ name: 'SHEET_DEFINED_NAME_PLUGIN', data: '{"私有名称":"A1"}' }],
    })).toThrow(ERROR)
    expect(() => fromUniverWorkbook({ ...snapshot(), defaultStyle: { bl: 1 } })).toThrow(ERROR)
    expect(() => fromUniverWorkbook({ ...snapshot(), dateSystem: 'date1904' as NonNullable<IWorkbookData['dateSystem']> })).toThrow(ERROR)
    expect(() => fromUniverWorkbook({
      ...snapshot(),
      calculationSettings: { iterativeCalculation: true, maxIterations: 100, maxChange: 0.001 },
    })).toThrow(ERROR)
  })

  it('拒绝会被悄悄丢弃的工作表、非法坐标和重叠合并', () => {
    const workbook = snapshot()
    workbook.sheets.extra = { id: 'extra', name: '未排序表' }
    expect(() => fromUniverWorkbook(workbook)).toThrow(ERROR)
    expect(() => fromUniverWorkbook(snapshot({ cellData: { 0: { 1_024: { v: 1 } } } }))).toThrow(ERROR)
    expect(() => fromUniverWorkbook(snapshot({ mergeData: [
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
      { startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 },
    ] }))).toThrow(ERROR)
    expect(() => toUniverWorkbook(documentWith([{ row: 100_000, column: 0, value: 1 }]), 'w', '表格')).toThrow(ERROR)
  })

  it('用完整的 UTF-8 结果限制保存大小，避免只按字符计数', () => {
    const value = '表'.repeat(30_000)
    const cellData = Object.fromEntries(Array.from({ length: 100 }, (_, row) => [row, { 0: { v: value } }]))
    expect(() => fromUniverWorkbook(snapshot({ cellData }))).toThrow(ERROR)
  })
})
