import { describe, expect, it } from 'vitest'
import { extractPptxPageEvidence, importPptx, readPptxPageEvidence, slicePptxPageEvidence } from '../src/import.ts'
import { zip, type ZipEntry } from '../src/export/zip.ts'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const entry = (path: string, value: string): ZipEntry => ({ path, data: encode(value) })
const slide = (content = ''): string => `<p:sld><p:cSld><p:spTree>${content}</p:spTree></p:cSld></p:sld>`
const text = (value: string): string => '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/>'
  + `<a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:sp>`
const chart = '<p:graphicFrame><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
  + '<c:chart r:id="rChart"/></a:graphicData></p:graphicFrame>'
const image = '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/>'
  + '</a:xfrm></p:spPr><a:blip r:embed="rImage"/></p:pic>'
const relation = (id: string, type: string, target: string): string =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
const rels = (items: string): string => `<Relationships>${items}</Relationships>`
const source = (first: string, second = ''): ZipEntry[] => [
  entry('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rSecond"/>'
    + '<p:sldId r:id="rFirst"/></p:sldIdLst></p:presentation>'),
  entry('ppt/_rels/presentation.xml.rels', rels(relation('rFirst', 'slide', 'slides/slide1.xml')
    + relation('rSecond', 'slide', 'slides/slide2.xml'))),
  entry('ppt/slides/slide1.xml', slide(first)),
  entry('ppt/slides/slide2.xml', slide(second)),
]
const read = (members: readonly ZipEntry[]) => importPptx(zip(members), { title: '诊断' })

describe('PPTX 逐页导入报告', () => {
  it('源顺序、页 ID、文本与图表逐页对照；图表加标题不能误报为完整', () => {
    const members = source(text('末页'), text('标题') + chart)
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(relation('rChart', 'chart', 'charts/chart1.xml'))))
    members.push(entry('ppt/slides/charts/chart1.xml', '<c:chartSpace><c:numCache><c:v>42</c:v></c:numCache></c:chartSpace>'))
    const result = read(members)
    expect(result.report.sourceSlides).toBe(2)
    expect(result.report.importedPages).toBe(2)
    expect(result.report.pages.map(page => page.slidePart)).toEqual(['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
    expect(result.report.pages.map((page, i) => page.pageId === result.deck.pages[i]?.id)).toEqual([true, true])
    expect(result.report.pages[0]).toMatchObject({ sourceIndex: 1, source: { text: 1, chart: 1 },
      imported: { text: 1, chart: 0 }, status: 'partial', losses: ['chart'], textPreview: ['标题'] })
    expect(result.report.pages[1]).toMatchObject({ sourceIndex: 2, status: 'no_known_loss', textPreview: ['末页'] })
  })

  it('区分整页图片、空白源页、未导入内容和未知组', () => {
    const picture = source('', image)
    picture.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(relation('rImage', 'image', '../media/image.png'))))
    picture.push({ path: 'ppt/media/image.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })
    expect(read(picture).report.pages.map(page => page.status)).toEqual(['image_only', 'empty_source'])

    const unsupported = source('', chart)
    expect(read(unsupported).report.pages[0]).toMatchObject({ status: 'empty_import', losses: ['chart'] })
    const grouped = source('', '<p:grpSp>' + text('组内文字') + '</p:grpSp><p:contentPart/>')
    expect(read(grouped).report.pages[0]).toMatchObject({ status: 'partial', source: { text: 1, other: 2 } })
    expect(read(grouped).report.pages[0]?.losses).toEqual(expect.arrayContaining(['group', 'object']))
  })

  it('保留带 xml:space 属性的文字，不把可见文字误判为空页', () => {
    const members = source('', text('占位').replace('<a:t>占位</a:t>', '<a:t xml:space="preserve"> 原文 </a:t>'))
    const result = read(members)
    expect(result.report.pages[0]).toMatchObject({ source: { text: 1 }, imported: { text: 1 }, status: 'no_known_loss' })
    expect(result.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'text', text: { content: '原文' } })
  })

  it('把实际引用的背景图片铺成首个可见元素，缺失时也不能误判空源', () => {
    const members = source('', '')
    members[3] = entry('ppt/slides/slide2.xml', '<p:sld><p:cSld><p:bg><p:bgPr><a:blipFill>'
      + '<a:blip r:embed="rBg"/></a:blipFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>')
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(relation('rBg', 'image', '../media/background.png'))))
    const reportWithMissingMedia = read(members).report.pages[0]
    expect(reportWithMissingMedia).toMatchObject({ source: { image: 1 }, imported: { image: 0 },
      status: 'empty_import', losses: ['image'] })
    members.push({ path: 'ppt/media/background.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })
    const result = read(members)
    expect(result.report.pages[0]).toMatchObject({ source: { image: 1 }, imported: { image: 1 }, status: 'image_only' })
    expect(result.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'image', x: 0, y: 0, w: 960, h: 720 })
  })

  it('注释中的假形状和假文字不进入来源统计或预览', () => {
    const members = source('', text('真实'))
    members[3] = entry('ppt/slides/slide2.xml', '<p:sld><!-- <p:grpSp><a:t>FAKE</a:t> -->'
      + '<p:cSld><p:spTree>' + text('真实') + '</p:spTree></p:cSld></p:sld>')
    const page = read(members).report.pages[0]
    expect(page).toMatchObject({ source: { text: 1, other: 0 }, status: 'no_known_loss', textPreview: ['真实'] })
    expect(page?.losses).toEqual([])
  })

  it('证据以源页序号分片读取真实 XML 和图表缓存，缺失缓存即失败', () => {
    const members = source('', text('甲'.repeat(4000)) + text('乙'.repeat(4000)) + chart)
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(relation('rChart', 'chart', 'charts/chart1.xml'))))
    members.push(entry('ppt/slides/charts/chart1.xml', '<c:chartSpace><c:numCache><c:v>42</c:v></c:numCache></c:chartSpace>'))
    const bytes = zip(members)
    const report = importPptx(bytes, { title: '证据' }).report.pages[0]!
    expect(report.truncated).toBe(true)
    expect(report.textPreview.join('').length).toBeLessThanOrEqual(600)
    let offset = 0
    let full = ''
    let totalChars = 0
    while (true) {
      const chunk = readPptxPageEvidence(bytes, { sourceIndex: 1, offset, limit: 1600 })
      full += chunk.content
      totalChars = chunk.totalChars
      if (chunk.nextOffset === null) break
      offset = chunk.nextOffset
    }
    expect(full.length).toBe(totalChars)
    const parsed = JSON.parse(full) as { slidePart: string; slideXml: string; charts: { xml: string }[] }
    expect(parsed.slidePart).toBe('ppt/slides/slide2.xml')
    expect(parsed.slideXml).toContain('甲'.repeat(4000))
    expect(parsed.charts[0]?.xml).toContain('<c:v>42</c:v>')
    expect(() => readPptxPageEvidence(bytes, { sourceIndex: 3 })).toThrow('页码超出')
    expect(() => readPptxPageEvidence(bytes, { sourceIndex: 1, limit: 16001 })).toThrow('片段上限')
    expect(() => readPptxPageEvidence(bytes, { sourceIndex: 1, offset: totalChars + 1 })).toThrow('偏移超出')
    expect(() => readPptxPageEvidence(zip(members.filter(item => !item.path.endsWith('chart1.xml'))),
      { sourceIndex: 1 })).toThrow('图表源内容缺失')
    members[members.length - 1] = entry('ppt/slides/charts/chart1.xml', '<c:chartSpace><c:plotArea/></c:chartSpace>')
    const withoutCache = readPptxPageEvidence(zip(members), { sourceIndex: 1, limit: 16000 })
    const actual = JSON.parse(withoutCache.content) as { charts: { xml: string }[] }
    expect(actual.charts[0]?.xml).toBe('<c:chartSpace><c:plotArea/></c:chartSpace>')
    expect(actual.charts[0]?.xml).not.toContain('<c:numCache>')
  })

  it('证据只带源页真正引用的图表关系，忽略未使用或缺失的缓存', () => {
    const members = source('', text('标题') + chart)
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(
      relation('unused', 'chart', 'charts/missing.xml') + relation('rChart', 'chart', 'charts/chart1.xml'),
    )))
    members.push(entry('ppt/slides/charts/chart1.xml', '<c:chartSpace><c:numCache><c:v>7</c:v></c:numCache></c:chartSpace>'))
    const bytes = zip(members)
    const content = extractPptxPageEvidence(bytes, 1)
    const data = JSON.parse(content) as { relationships: { id: string }[]; charts: { id: string; xml: string }[] }
    expect(data.relationships.map(item => item.id)).toEqual(['rChart'])
    expect(data.charts).toEqual([{ id: 'rChart', part: 'ppt/slides/charts/chart1.xml',
      xml: '<c:chartSpace><c:numCache><c:v>7</c:v></c:numCache></c:chartSpace>' }])
    expect(slicePptxPageEvidence(content, { sourceIndex: 1, limit: 4 })).toMatchObject({
      content: content.slice(0, 4), totalChars: content.length, nextOffset: 4,
    })
  })

  it('超过 1 MiB 的源页证据明确失败，不暗中截断', () => {
    const members = source('', chart)
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(relation('rChart', 'chart', 'charts/chart1.xml'))))
    members.push(entry('ppt/slides/charts/chart1.xml', `<c:chartSpace><c:v>${'7'.repeat(1024 * 1024)}</c:v></c:chartSpace>`))
    expect(() => extractPptxPageEvidence(zip(members), 1)).toThrow('1 MiB 字符上限')
  })

  it('只收集源页实际继承的布局、母版与主题，去重直达主题', () => {
    const members = source('', text('标题'))
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(
      relation('rLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml')
      + relation('rTheme', 'theme', '../theme/theme1.xml'),
    )))
    members.push(entry('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout><p:spTree/></p:sldLayout>'))
    members.push(entry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(
      relation('rMaster', 'slideMaster', '../slideMasters/slideMaster1.xml'),
    )))
    members.push(entry('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster><p:spTree/></p:sldMaster>'))
    members.push(entry('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(
      relation('rTheme', 'theme', '../theme/theme1.xml'),
    )))
    members.push(entry('ppt/theme/theme1.xml', '<a:theme><a:clrScheme name="实际主题"/></a:theme>'))
    members.push(entry('ppt/theme/unrelated.xml', '<a:theme><a:clrScheme name="无关主题"/></a:theme>'))
    const evidence = JSON.parse(extractPptxPageEvidence(zip(members), 1)) as {
      designParts: { kind: string; part: string; xml: string }[]
    }
    expect(evidence.designParts.map(item => [item.kind, item.part])).toEqual([
      ['layout', 'ppt/slideLayouts/slideLayout1.xml'],
      ['master', 'ppt/slideMasters/slideMaster1.xml'],
      ['theme', 'ppt/theme/theme1.xml'],
    ])
    expect(JSON.stringify(evidence)).not.toContain('无关主题')
    const missing = members.filter(item => item.path !== 'ppt/slideMasters/slideMaster1.xml')
    expect(() => extractPptxPageEvidence(zip(missing), 1)).toThrow('设计部件缺失')
  })

  it('拒绝设计关系循环，且设计 XML 也计入单页证据预算', () => {
    const members = source('', text('标题'))
    members.push(entry('ppt/slides/_rels/slide2.xml.rels', rels(
      relation('rLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
    )))
    members.push(entry('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>'))
    members.push(entry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(
      relation('rLoop', 'slideMaster', 'slideLayout1.xml'),
    )))
    expect(() => extractPptxPageEvidence(zip(members), 1)).toThrow('设计关系循环')
    members[members.length - 1] = entry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(
      relation('rMaster', 'slideMaster', '../slideMasters/slideMaster1.xml'),
    ))
    members.push(entry('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster><p:tx>${'字'.repeat(1024 * 1024)}</p:tx></p:sldMaster>`))
    expect(() => extractPptxPageEvidence(zip(members), 1)).toThrow('1 MiB 字符上限')
  })
})
