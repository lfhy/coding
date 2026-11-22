/** Office 包预检的独立输入：用最小 OPC 部件验证丢弃的内容也必须安全。 */
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { validateOfficeFormula } from '../src/office/formula.ts'
import { openOfficePackage } from '../src/office/package.ts'
import { CONTENT_TYPES_NS, EXCEL_NS, OFFICE_REL_NS, PACKAGE_REL_NS, WORD_NS } from '../src/office/xml.ts'
import { readOfficeZip } from '../src/office/zip.ts'

const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'

function archive(input: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(input).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])))
}

function rels(body: string): string { return `<Relationships xmlns="${PACKAGE_REL_NS}">${body}</Relationships>` }

function fixture(kind: 'word' | 'excel') {
  const word = kind === 'word'
  const path = word ? 'word/document.xml' : 'xl/workbook.xml'
  return {
    path,
    entries: {
      '[Content_Types].xml': `<Types xmlns="${CONTENT_TYPES_NS}">`
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + `<Override PartName="/${path}" ContentType="${word ? wordType : sheetType}"/></Types>`,
      '_rels/.rels': rels(`<Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="${path}"/>`),
      [path]: word ? `<w:document xmlns:w="${WORD_NS}"><w:body/></w:document>` : `<workbook xmlns="${EXCEL_NS}"/>`,
    } as Record<string, string | Uint8Array>,
  }
}

const documentXml = (body: string) => `<w:document xmlns:w="${WORD_NS}"><w:body>${body}</w:body></w:document>`

function patchSingleZipMember(data: Uint8Array, localOffset: number, centralOffset: number, value: number): Buffer {
  const bytes = Buffer.from(data)
  const central = bytes.readUInt32LE(bytes.length - 6)
  bytes.writeUInt32LE(value, localOffset)
  bytes.writeUInt32LE(value, central + centralOffset)
  return bytes
}

const unsafeFormulas = [
  '=WEBSERVICE("https://example.invalid")', '=SUM(1,_xlfn.WEBSERVICE("外部"))', '=IMAGE("外部")',
  '=HYPERLINK("外部")', '=INDIRECT("[xlsx]表!A1")', '=RTD("外部",,1)', '=未知函数(A1)',
  "='[工作簿.xlsx]Sheet1'!A1", '=cmd|topic!A1', "='cmd|topic'!A1", '=自定义名称',
]

describe('Office 安全预检', () => {
  it('只接受声明与真实主部件一致的普通 Office 包', () => {
    const { entries, path } = fixture('word')
    const bytes = archive(entries)
    expect(openOfficePackage(bytes, 'word').main).toBe(path)
    expect(() => openOfficePackage(bytes, 'excel')).toThrow(TypeError)
    expect(() => openOfficePackage(new Uint8Array(), 'word')).toThrow(TypeError)
  })

  it.each(['../另一个.xml', '/absolute.xml', 'word\\alternate.xml', 'word/%2e%2e/alternate.xml', 'word/Document.xml'])(
    '拒绝逃逸或重名的 ZIP 部件 %s', (name) => {
      const { entries } = fixture('word')
      expect(() => openOfficePackage(archive({ ...entries, [name]: '<empty/>' }), 'word')).toThrow(/压缩包无效/u)
    },
  )

  it('以解压器硬限额拒绝声明一字节却实际展开的 ZIP，并校验 CRC', () => {
    const source = archive({ 'sample.xml': new Uint8Array(512 * 1024) })
    expect(readOfficeZip(source).get('sample.xml')?.byteLength).toBe(512 * 1024)
    expect(() => readOfficeZip(patchSingleZipMember(source, 22, 24, 1))).toThrow(/解压失败/u)
    expect(() => readOfficeZip(patchSingleZipMember(source, 22, 24, 0xffffffff))).toThrow(/解压内容超过/u)
    expect(() => readOfficeZip(patchSingleZipMember(source, 14, 16, 1))).toThrow(/压缩包无效/u)
    expect(() => readOfficeZip(patchSingleZipMember(source, 22, 42, 0xffffffff))).toThrow(TypeError)
  })

  it.each([
    ['external', '<!DOCTYPE ignored SYSTEM "https://example.invalid/test.dtd"><ignored/>'],
    ['stylesheet', '<?xml-stylesheet href="https://example.invalid/test.xsl"?><ignored/>'],
    ['xinclude', '<ignored xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="outside"/></ignored>'],
    ['base', '<ignored xml:base="https://example.invalid/"/>'],
  ])('忽略的 XML 也不允许请求外部资源：%s', (_label, xml) => {
    const { entries } = fixture('word')
    expect(() => openOfficePackage(archive({ ...entries, 'word/ignored.xml': xml }), 'word')).toThrow(/外部 XML/u)
  })

  it('拒绝被忽略部件中的外部关系及宏，也拒绝编码、越界和缺失的目标', () => {
    const { entries } = fixture('word')
    const relation = (target: string, mode = '') => rels(`<Relationship Id="rIdOther" Type="${OFFICE_REL_NS}/hyperlink" Target="${target}"${mode}/>`)
    for (const [target, mode] of [
      ['https://example.invalid', ' TargetMode="External"'], ['https://example.invalid', ''],
      ['../../other.xml', ''], ['%2e%2e/other.xml', ''], ['/word%2fdocument.xml', ''], ['absent.xml', ''],
    ] as const) {
      const source = { ...entries, 'word/unused.xml': '<unused/>', 'word/_rels/unused.xml.rels': relation(target, mode) }
      expect(() => openOfficePackage(archive(source), 'word')).toThrow(TypeError)
    }
    const macro = { ...entries, 'word/vbaData.xml': '<unused/>' }
    expect(() => openOfficePackage(archive(macro), 'word')).toThrow(/宏/u)
  })

  it('Word 域的指令跨文字片段时仍按完整字段校验', () => {
    const { entries, path } = fixture('word')
    const text = (command: string) => `<w:r><w:instrText>${command}</w:instrText></w:r>`
    const field = (kind: string) => `<w:r><w:fldChar w:fldCharType="${kind}"/></w:r>`
    const source = (left: string, right: string) => archive({ ...entries, [path]: documentXml(
      `<w:p>${field('begin')}${text(left)}${text(right)}${field('separate')}<w:r><w:t>显示值</w:t></w:r>${field('end')}</w:p>`,
    ) })
    expect(openOfficePackage(source(' PA', 'GE '), 'word').main).toBe(path)
    expect(() => openOfficePackage(source(' DDE', 'AUTO '), 'word')).toThrow(/联网字段/u)
    expect(() => openOfficePackage(archive({ ...entries, [path]: documentXml('<w:fldSimple w:instr="INCLUDETEXT 外部"/>') }), 'word')).toThrow(TypeError)
  })

  it.each(unsafeFormulas)('原生 Excel 与未消费的 OOXML 公式一律拒绝 %s', (formula) => {
    expect(() => validateOfficeFormula(formula)).toThrow(/Excel 公式无效/u)
    const { entries } = fixture('excel')
    const xml = `<worksheet xmlns="${EXCEL_NS}"><sheetData><row><c><f>${formula.slice(1)}</f></c></row></sheetData></worksheet>`
    expect(() => openOfficePackage(archive({ ...entries, 'xl/unused.xml': xml }), 'excel')).toThrow(/Excel 公式无效/u)
  })

  it.each(['=IF(A1>0,SUM($A$1:B2),0)', "='本季 数据'!A1+Sheet2!$B2", '=SUM(A:A,2:3)', '=SUM(1E-3,5%)',
    '=IF(TRUE,"https://example.invalid/?x=|[file]","")', '=RAND()', '=_xlfn.XLOOKUP(A1,B1:B5,C1:C5)'])(
    '接受可在本地工作簿计算的公式 %s', (formula) => { expect(validateOfficeFormula(formula)).toBe(formula) },
  )
})
