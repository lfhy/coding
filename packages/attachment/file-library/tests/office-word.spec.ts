/** 覆盖严格 Word 部件的投影，以及打包器可能把普通文字解释为域的情形。 */
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { OfficePackage } from '../src/office/package.ts'
import { exportWord, importWord } from '../src/office/word.ts'
import { buildWordSnapshot, readWordParagraphs } from '../src/office/word-snapshot.ts'
import { readOfficeXml, WORD_STRICT_NS } from '../src/office/xml.ts'

describe('Word OOXML', () => {
  it('按严格命名空间提取样式、可见内容和逐行单元格文本', () => {
    const main = 'word/document.xml'
    const styles = 'word/styles2.xml'
    const files = new Map([
      [main, `<x:document xmlns:x="${WORD_STRICT_NS}" xmlns:z="urn:ignored">
        <x:body>
          <x:p><x:pPr><x:pStyle x:val="Custom"/></x:pPr>
            <x:r><x:rPr><x:rStyle x:val="Mark"/><x:b x:val="off"/></x:rPr>
              <x:t> 甲 </x:t><x:tab/><x:t>乙</x:t><x:br/><x:instrText>PAGE</x:instrText><z:t>忽略</z:t><x:t>丙</x:t></x:r>
            <x:del><x:r><x:delText>已删除</x:delText></x:r></x:del>
          </x:p>
          <x:tbl><x:tr>
            <x:tc><x:p><x:r><x:t>A</x:t></x:r></x:p><x:p><x:r><x:t>B</x:t></x:r></x:p></x:tc>
            <x:tc><x:p/></x:tc><x:tc><x:p><x:r><x:t>C</x:t></x:r></x:p></x:tc>
          </x:tr><x:tr><x:tc><x:p><x:r><x:t>D</x:t></x:r></x:p></x:tc></x:tr></x:tbl>
        </x:body></x:document>`],
      [styles, `<x:styles xmlns:x="${WORD_STRICT_NS}">
        <x:style x:styleId="Base" x:type="paragraph"><x:pPr>
          <x:outlineLvl x:val="1"/><x:bidi/><x:jc x:val="start"/></x:pPr></x:style>
        <x:style x:styleId="Custom" x:type="paragraph"><x:basedOn x:val="Base"/></x:style>
        <x:style x:styleId="Mark" x:type="character"><x:rPr>
          <x:b/><x:u x:val="single"/><x:color x:val="abcd12"/><x:sz x:val="12.5pt"/></x:rPr></x:style>
      </x:styles>`],
    ])
    const packageFile: OfficePackage = {
      main,
      xml(path) { return readOfficeXml(strToU8(files.get(path)!)) },
      related(owner, type) { return owner === main && type === 'styles' ? styles : undefined },
      relation() { throw new Error('该文档的正文无需通过关系标识查找') },
    }

    const imported = importWord(packageFile)
    expect(readWordParagraphs(imported.snapshot)).toEqual([
      { style: 'heading2', align: 'right', runs: [{ text: ' 甲 \t乙\n丙', bold: false, underline: true, color: '#ABCD12', fontSize: 12.5 }] },
      { style: 'normal', runs: ['A', '\n', 'B', '\t', '\t', 'C'].map(text => ({ text })) },
      { style: 'normal', runs: [{ text: 'D' }] },
    ])
  })

  it('将页码域同名文字原样写入，换行和制表符使用真正的 Word 元素', async () => {
    const bytes = await exportWord({
      version: 2,
      kind: 'word',
      snapshot: buildWordSnapshot([
        {
          style: 'title',
          align: 'justify',
          runs: [{
            text: 'CURRENT\tTOTAL_PAGES\r\n<&>',
            bold: false,
            italic: true,
            underline: false,
            strike: true,
            color: '#123ABC',
            fontSize: 12.5,
          }],
        },
      ]),
    })

    const body = unzipSync(bytes)['word/document.xml']
    expect(body).toBeDefined()
    const xml = strFromU8(body!)
    expect(xml).toContain('<w:pStyle w:val="Title"/>')
    expect(xml).toContain('<w:jc w:val="both"/>')
    expect(xml).toContain('<w:b w:val="false"/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:u w:val="none"/>')
    expect(xml).toContain('<w:strike/>')
    expect(xml).toContain('<w:color w:val="123ABC"/>')
    expect(xml).toContain('<w:sz w:val="25"/>')
    expect(xml).toContain('<w:t xml:space="preserve">CURRENT</w:t><w:tab/>')
    expect(xml).toContain('<w:t xml:space="preserve">TOTAL_PAGES</w:t><w:br/>')
    expect(xml).toContain('&lt;&amp;&gt;')
    expect(xml).not.toMatch(/w:fldChar|w:instrText/)
  })
})

describe('导出含表格与图片的快照', () => {
  const snapshotOf = (stream: string, extra: Record<string, unknown> = {}) => ({
    version: 2 as const,
    kind: 'word' as const,
    snapshot: {
      body: {
        dataStream: stream,
        paragraphs: [],
        textRuns: [],
        tables: [{ startIndex: 1, endIndex: stream.indexOf('\u001f') + 1, tableId: 't1' }],
      },
      tableSource: { t1: { tableRows: [{ tableCells: [{}, {}] }, { tableCells: [{}, {}] }] } },
      ...extra,
    },
  })

  it('表格按行列写进 w:tbl，单元格内段落保留文字', async () => {
    const stream = '\r\u001a\u001b\u001c甲\r\u001d\u001c乙\r\u001d\u000e\u001b\u001c丙\r\u001d\u001c丁\r\u001d\u000e\u001f\r\n'
    const bytes = await exportWord(snapshotOf(stream))
    const xml = strFromU8(unzipSync(bytes)['word/document.xml']!)
    expect(xml).toContain('<w:tbl>')
    expect(xml.match(/<w:tr>/g)).toHaveLength(2)
    expect(xml.match(/<w:tc>/g)).toHaveLength(4)
    for (const text of ['甲', '乙', '丙', '丁']) expect(xml).toContain(`>${text}<`)
  })

  it('data URL 图片作为内嵌图片写入导出文件', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const document = snapshotOf('\r\n', {
      drawings: { d1: { source: png, imageSourceType: 2, docTransform: { width: 120, height: 80 } } },
    })
    const bytes = await exportWord(document)
    const parts = unzipSync(bytes)
    expect(Object.keys(parts).some(path => path.startsWith('word/media/'))).toBe(true)
    expect(strFromU8(parts['word/document.xml']!)).toContain('<w:drawing>')
  })
})
