import { describe, expect, it } from 'vitest'
import { PPT_FORMAT, parseDeck, type PptDeck } from 'coding-ppt-model'
import { extractTemplateDesign } from '../src/extract-template.ts'
import { createDefaultDeck } from '../src/default-template.ts'
import { buildPptx } from '../src/export/pptx.ts'
import { importPptx } from '../src/import.ts'
import { checkDeck } from '../src/check.ts'

const source: PptDeck = parseDeck({
  format: PPT_FORMAT, title: '隐私内容', size: '16:9', theme: 'paper', pages: [{
    id: 'source', name: '机密章节', background: '#ffffff', transition: 'none', elements: [
      { id: 'title', kind: 'text', x: 100, y: 100, w: 600, h: 80,
        text: { content: '产品营收', size: 44, color: '#16181d', bold: true, align: 'left', valign: 'middle', font: 'Arial' } },
      { id: 'number', kind: 'text', x: 100, y: 300, w: 600, h: 80,
        text: { content: '5700万元', size: 42, color: '#1d4ed8', bold: true, align: 'left', valign: 'middle', font: 'Arial' } },
      { id: 'table', kind: 'table', x: 100, y: 420, w: 600, h: 100,
        rows: 2, columns: 2, columnWeights: [1, 1], header: true,
        cells: [[{ content: '客户' }, { content: '金额' }], [{ content: '秘密公司' }, { content: '100万' }]],
        headerFill: '#f4f3ef', borderColor: '#e2e0d9',
        text: { size: 18, color: '#16181d', bold: false, align: 'left', font: '' } },
      { id: 'bar', kind: 'rect', x: 100, y: 580, w: 200, h: 8, fill: '#c2410c' },
      { id: 'chart', kind: 'chart', x: 720, y: 420, w: 400, h: 150, chart: 'bar',
        categories: ['秘密产品', '关键营收'], series: [
          { name: '真实交易', values: [10, 20], color: '#1d4ed8' },
        ], showValues: true, stacked: false, textColor: '#16181d' },
      { id: 'photo', kind: 'image', x: 900, y: 220, w: 200, h: 200, source: 'media/photo.png', fit: 'contain' },
    ],
  }],
})

describe('可复用模板设计提取', () => {
  it('默认整稿拥有独立可编辑元素和可导出配色', () => {
    const first = parseDeck(createDefaultDeck('季度业务'))
    const second = parseDeck(createDefaultDeck('年度业务'))
    expect(first.pages).toHaveLength(6)
    expect(first.theme).toBe('inference')
    expect(first.pages[0]?.elements.some(element => element.kind === 'text' && element.text.content === '季度业务')).toBe(true)
    const cover = first.pages[0]?.elements ?? []
    expect(cover.filter(element => element.kind === 'rect')).toHaveLength(0)
    expect(cover.filter(element => element.kind === 'line')).toMatchObject([
      { x: 96, y: 414, w: 1088, color: '#16181d', width: 2 },
    ])
    expect(cover.find(element => element.kind === 'text' && element.text.content === '季度业务'))
      .toMatchObject({ x: 94, y: 231, h: 110, text: { size: 72, align: 'left', valign: 'top' } })
    for (const page of first.pages.slice(1)) {
      expect(page.elements.slice(0, 3)).toMatchObject([
        { kind: 'text', x: 95, y: 55, text: { size: 18, align: 'left' } },
        { kind: 'text', x: 94, y: 81, h: 68, text: { size: 44, align: 'left', valign: 'top' } },
        { kind: 'line', x: 96, y: 150, w: 1088, color: '#16181d' },
      ])
      expect(page.elements.filter(element => element.kind === 'line' && element.y === 668)).toEqual([])
    }
    expect(first.pages.flatMap(page => page.elements).every(element => element.kind !== 'image')).toBe(true)
    expect(first.pages[0]?.id).not.toBe(second.pages[0]?.id)
    expect(first.pages[0]?.elements[0]?.id).not.toBe(second.pages[0]?.elements[0]?.id)
    // 默认整稿的每个文本元素都显式带默认字体，导出不必依赖目标机装了它。
    expect(first.pages.flatMap(page => page.elements)
      .every(element => element.kind !== 'text' || element.text.font === 'HarmonyOS Sans SC')).toBe(true)
    expect(checkDeck(first).issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(buildPptx(first).length).toBeGreaterThan(2000)
  })

  it('提取时保留坐标颜色与表格，但从所有文字容器去掉正文和图片', () => {
    const extracted = extractTemplateDesign(source, '通用模板')
    expect(extracted.pages).toHaveLength(1)
    expect(extracted.title).toBe('通用模板')
    expect(extracted.pages[0]?.name).toBe('封面版式')
    expect(extracted.pages[0]?.elements).toHaveLength(5)
    expect(extracted.pages[0]?.elements[0]).toMatchObject({ x: 100, y: 100, text: { color: '#16181d', size: 44 } })
    expect(extracted.pages[0]?.elements[3]).toMatchObject({ fill: '#c2410c', x: 100, y: 580 })
    expect(extracted.pages[0]?.elements[2]).toMatchObject({ kind: 'table', cells: [
      [{ content: '字段 1' }, { content: '字段 2' }], [{ content: '填写数据' }, { content: '填写数据' }],
    ] })
    expect(extracted.pages[0]?.elements[4]).toMatchObject({ kind: 'chart', categories: ['类别 1', '类别 2'],
      series: [{ name: '系列 1', values: [1, 1], color: '#1d4ed8' }] })
    expect(JSON.stringify(extracted)).not.toMatch(/产品营收|5700万元|秘密公司|100万|photo.png|机密章节|秘密产品|真实交易|关键营收/u)
    expect(parseDeck(extracted)).toEqual(extracted)
    expect(buildPptx(extracted).length).toBeGreaterThan(1000)
  })

  it('源文件的主题配色和字体用于设计提取而不改变普通导入路径', () => {
    const bytes = buildPptx(source)
    const editable = importPptx(bytes, { title: '可编辑原稿' })
    const design = importPptx(bytes, { title: '设计提取', design: true })
    expect(editable.deck.theme).toBe('ink')
    expect(design.deck.theme).toBe('inference')
    expect(design.deck.pages[0]?.background).toBe('#ffffff')
    const extracted = extractTemplateDesign(design.deck, '抽取结果')
    expect(JSON.stringify(extracted)).not.toMatch(/产品营收|5700万元|秘密公司|100万|秘密产品|真实交易|关键营收/u)
  })
})
