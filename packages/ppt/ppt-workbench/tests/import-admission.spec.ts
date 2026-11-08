import { describe, expect, it } from 'vitest'
import { PptModelError, type PptDeck } from 'coding-ppt-model'
import { importPptx, PptImportError, PPT_IMPORT_MAX_BYTES } from '../src/import.ts'
import { buildPptx } from '../src/export/pptx.ts'
import { zip, type ZipEntry } from '../src/export/zip.ts'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const slide = (content = ''): string => `<p:sld><p:cSld><p:spTree>${content}</p:spTree></p:cSld></p:sld>`
const textShape = (value: string): string => '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/>'
  + `<a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:sp>`
const picture = '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr><a:blip r:embed="rId1"/></p:pic>'
const rels = (items: string): string => `<Relationships>${items}</Relationships>`
const relation = (id: string, type: string, target: string, mode = ''): string =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode}/>`
const entry = (path: string, text: string): ZipEntry => ({ path, data: encode(text) })
const base = (): ZipEntry[] => [
  entry('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'),
  entry('ppt/_rels/presentation.xml.rels', rels(relation('rId1', 'slide', 'slides/slide2.xml') + relation('rId2', 'slide', 'slides/slide1.xml'))),
  entry('ppt/slides/slide1.xml', slide()),
  entry('ppt/slides/slide2.xml', slide()),
]
const read = (entries: readonly ZipEntry[]) => importPptx(zip(entries), { title: '导入' })

describe('PPTX 导入准入', () => {
  it('按 presentation 关系顺序读取幻灯片，缺少关系文件时兼容编号顺序', () => {
    const entries = base()
    entries[2] = entry('ppt/slides/slide1.xml', slide(textShape('第一张')))
    entries[3] = entry('ppt/slides/slide2.xml', slide(textShape('第二张')))
    const result = read(entries)
    expect(result.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'text', text: { content: '第一张' } })
    expect(result.dropped).toContain('复杂母版与版式')
    expect(result.dropped).toContain('动画与高级转场')
    expect(read(entries.filter(item => !item.path.includes('_rels'))).deck.pages).toHaveLength(2)
  })

  it('限制输入、实际 XML 解压量、总解压量和条目数', () => {
    expect(() => importPptx(new Uint8Array(PPT_IMPORT_MAX_BYTES + 1), { title: 'x' })).toThrow('8 MiB')
    expect(() => read([...base(), entry('ppt/theme/huge.xml', ' '.repeat(4 * 1024 * 1024 + 1))])).toThrow('安全预算')
    const chunks = Array.from({ length: 17 }, (_, i) => entry(`ppt/extra${i}.xml`, ' '.repeat(4 * 1024 * 1024)))
    expect(() => read([...base(), ...chunks])).toThrow('安全预算')
    expect(() => read([...base(), { path: 'ppt/media/huge.png', data: new Uint8Array(8 * 1024 * 1024 + 1) }])).toThrow('安全预算')
    const many = Array.from({ length: 1001 }, (_, i) => entry(`ppt/other/${i}.bin`, ''))
    expect(() => read(many)).toThrow('1000')
  })

  it('拒绝非法路径、重复文件、非标准压缩和破损内容', () => {
    expect(() => read([...base(), entry('../evil.xml', '')])).toThrow('非法路径')
    expect(() => read([...base(), base()[2]!])).toThrow('重复条目')
    const compressed = zip(base())
    compressed[8] = 99 // 本地头的压缩方法。
    expect(() => importPptx(compressed, { title: 'x' })).toThrow(PptImportError)
    const corrupt = zip(base())
    corrupt[55] = (corrupt[55] ?? 0) ^ 1
    expect(() => importPptx(corrupt, { title: 'x' })).toThrow(PptImportError)
  })

  it('拒绝宏、外部关系和 DTD 声明', () => {
    expect(() => read([...base(), entry('ppt/vbaProject.bin', '')])).toThrow('宏')
    const external = base()
    external[1] = entry('ppt/_rels/presentation.xml.rels', rels(relation('rId1', 'slide', 'https://example.invalid/a', ' TargetMode="External"')))
    expect(() => read(external)).toThrow('外部')
    external[1] = entry('ppt/_rels/presentation.xml.rels', rels(relation('rId1', 'slide', 'slides/slide1.xml', " TargetMode='External'")))
    expect(() => read(external)).toThrow('外部')
    expect(() => read([...base(), entry('ppt/custom.xml', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>')])).toThrow('DTD')
    expect(() => read([...base(), entry('ppt/custom.xml', '<x>&unknown;</x>')])).toThrow('自定义实体')
  })

  it('只准许安全图片关系和可识别的媒体格式，重用图片仅写一次', () => {
    const entries = base()
    entries[2] = entry('ppt/slides/slide1.xml', slide(picture + picture))
    entries.push(entry('ppt/slides/_rels/slide1.xml.rels', rels(relation('rId1', 'image', '../media/photo.PNG'))))
    entries.push({ path: 'ppt/media/photo.PNG', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })
    const result = read(entries)
    expect(result.media).toHaveLength(1)
    expect(result.media[0]?.part).toBe('media/image1.png')
    entries[entries.length - 1] = { path: 'ppt/media/photo.PNG', data: encode('<svg/>') }
    expect(() => read(entries)).toThrow('图片内容')
    entries[entries.length - 1] = { path: 'ppt/media/photo.PNG', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }
    entries[entries.length - 2] = entry('ppt/slides/_rels/slide1.xml.rels', rels(relation('rId1', 'image', '../../evil.png')))
    expect(() => read(entries)).toThrow('图片关系格式')
  })

  it('模型页数限额经 parseDeck 返回可映射为 400 的错误', () => {
    const slides = [entry('ppt/presentation.xml', '<p:presentation/>'),
      ...Array.from({ length: 201 }, (_, i) => entry(`ppt/slides/slide${i + 1}.xml`, slide()))]
    expect(() => read(slides)).toThrow('不能超过 200 页')
    expect(() => read(slides)).toThrow(PptModelError)
  })

  it('拒绝未闭合的大量形状标签，并在第 201 个元素就停止扫描', () => {
    const malformed = base()
    malformed[2] = entry('ppt/slides/slide1.xml', '<p:sld>' + '<p:sp>'.repeat(20000))
    expect(() => read(malformed)).toThrow('元素不能嵌套')
    const many = base()
    many[2] = entry('ppt/slides/slide1.xml', slide('<p:sp></p:sp>'.repeat(201)))
    expect(() => read(many)).toThrow('单页不能超过 200')
    const selfClosing = base()
    selfClosing[2] = entry('ppt/slides/slide1.xml', slide('<p:sp>' + '<a:p/>'.repeat(20000) + '<a:p><a:t>x</a:t></a:p></p:sp>'))
    expect(read(selfClosing).deck.pages[0]?.elements[0]).toMatchObject({ kind: 'text', text: { content: 'x' } })
  })

  it('提早限制表格行列与文本，并可编辑导入连接线', () => {
    const connector = '<p:cxnSp><p:spPr><a:xfrm><a:off x="0" y="0"/>'
      + '<a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="straightConnector1"/></p:spPr></p:cxnSp>'
    const connected = base()
    connected[2] = entry('ppt/slides/slide1.xml', slide(connector))
    expect(read(connected).deck.pages[0]?.elements[0]).toMatchObject({ kind: 'line', w: 100, h: 100 })

    const table = (rows: string) => '<p:graphicFrame><a:graphicData '
      + 'uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
      + `<a:tblGrid><a:gridCol w="952500"/></a:tblGrid>${rows}</a:tbl></a:graphicData></p:graphicFrame>`
    const overRows = base()
    overRows[2] = entry('ppt/slides/slide1.xml', slide(table('<a:tr><a:tc/></a:tr>'.repeat(51))))
    expect(() => read(overRows)).toThrow('50 行')
    const overColumns = base()
    overColumns[2] = entry('ppt/slides/slide1.xml', slide(table('<a:gridCol w="952500"/>'.repeat(21) + '<a:tr><a:tc/></a:tr>')))
    expect(() => read(overColumns)).toThrow('20 列')
    const longText = base()
    longText[2] = entry('ppt/slides/slide1.xml', slide(textShape('x'.repeat(5001))))
    expect(() => read(longText)).toThrow('5000 字符')
  })

  it('标准连接线导出再导入保留 5px 笔宽', () => {
    const deck: PptDeck = {
      format: 1, title: '连接线', size: '16:9', theme: 'ink',
      pages: [{
        id: 'page', name: '连接线', background: null, transition: 'none',
        elements: [{ id: 'line', kind: 'line', x: 10, y: 10, w: 200, h: 100, color: '#123456', width: 5 }],
      }],
    }
    const imported = importPptx(buildPptx(deck), { title: '回读' })
    expect(imported.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'line', width: 5, color: '#123456' })
  })

  it('大量配对的空背景、形状属性与描边不会触发失败回溯', () => {
    const entries = base()
    const shape = '<p:sp><p:spPr/><p:spPr></p:spPr>'
      + '<p:spPr><a:prstGeom prst="line"/>' + '<a:ln/>'.repeat(8000)
      + '</p:spPr></p:sp>'
    entries[2] = entry('ppt/slides/slide1.xml', '<p:sld><p:cSld>'
      + '<p:bg></p:bg>'.repeat(8000) + `<p:spTree>${shape}</p:spTree></p:cSld></p:sld>`)
    expect(read(entries).deck.pages[0]?.elements).toHaveLength(1)
  })
})
