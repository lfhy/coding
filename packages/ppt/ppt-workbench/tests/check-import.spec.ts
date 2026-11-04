import { describe, expect, it } from 'vitest'
import { buildPptx } from '../src/export/pptx.ts'
import { checkDeck, contrastRatio, estimateLines } from '../src/check.ts'
import { importPptx, PptImportError } from '../src/import.ts'
import type { PptDeck } from 'coding-ppt-model'

const deck: PptDeck = {
  format: 1,
  title: '质检',
  size: '16:9',
  theme: 'ink',
  pages: [{
    id: 'p1', name: '封面', background: null, transition: 'none',
    elements: [
      {
        id: 't1', kind: 'text', x: 96, y: 100, w: 900, h: 120,
        text: { content: '标题', size: 56, color: '#f5f7fa', bold: true, align: 'left', valign: 'middle' },
      },
      { id: 'r1', kind: 'rect', x: 96, y: 300, w: 200, h: 8, fill: '#4f8cff' },
    ],
  }],
}

describe('规则质检', () => {
  it('干净的工程没有 error', () => {
    const result = checkDeck(deck)
    expect(result.ok).toBe(true)
    expect(result.issues.filter(issue => issue.severity === 'error')).toHaveLength(0)
  })

  it('出界与零尺寸是阻断导出的错误', () => {
    const broken: PptDeck = {
      ...deck,
      pages: [{
        ...deck.pages[0]!,
        elements: [
          { id: 'r1', kind: 'rect', x: 1200, y: 100, w: 200, h: 100, fill: '#4f8cff' },
          { id: 'r2', kind: 'rect', x: 100, y: 100, w: 0, h: 100, fill: '#4f8cff' },
        ],
      }],
    }
    const result = checkDeck(broken)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['out-of-bounds', 'zero-size']),
    )
  })

  it('文字溢出与低对比度只给 warning', () => {
    const warned: PptDeck = {
      ...deck,
      pages: [{
        ...deck.pages[0]!,
        elements: [{
          id: 't1', kind: 'text', x: 96, y: 100, w: 300, h: 60,
          text: {
            content: '这一段文字明显放不进这个又窄又矮的文本框里，需要拆成两页或者缩小字号',
            size: 40, color: '#1a1a1a', bold: false, align: 'left', valign: 'top',
          },
        }],
      }],
    }
    const result = checkDeck(warned)
    expect(result.ok).toBe(true)
    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['text-overflow', 'low-contrast']),
    )
  })

  it('对比度按 WCAG 公式计算', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('行数估算随宽度与字号变化', () => {
    expect(estimateLines('一二三四五六七八', 400, 40)).toBe(1)
    expect(estimateLines('一二三四五六七八', 100, 40)).toBeGreaterThan(1)
  })
})

describe('.pptx 导入', () => {
  it('把自己的导出重新读回工程', () => {
    const imported = importPptx(buildPptx(deck), { title: '回读' })
    expect(imported.deck.title).toBe('回读')
    expect(imported.deck.size).toBe('16:9')
    expect(imported.deck.pages).toHaveLength(1)
    const texts = imported.deck.pages[0]?.elements.filter(element => element.kind === 'text') ?? []
    expect(texts).toHaveLength(1)
    expect(texts[0]?.kind === 'text' ? texts[0].text.content : '').toBe('标题')
    expect(imported.deck.pages[0]?.elements.some(element => element.kind === 'rect')).toBe(true)
  })

  it('图片写回 media 列表', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const withImage: PptDeck = {
      ...deck,
      pages: [{
        ...deck.pages[0]!,
        elements: [{ id: 'i1', kind: 'image', x: 10, y: 10, w: 100, h: 100, source: 'media/logo.png', fit: 'cover' }],
      }],
    }
    const imported = importPptx(
      buildPptx(withImage, { media: () => png }),
      { title: '带图' },
    )
    expect(imported.media).toHaveLength(1)
    expect(imported.media[0]?.part).toBe('media/image1.png')
    expect(Buffer.from(imported.media[0]?.bytes ?? []).equals(png)).toBe(true)
    const image = imported.deck.pages[0]?.elements.find(element => element.kind === 'image')
    expect(image?.kind === 'image' ? image.source : '').toBe('media/image1.png')
  })

  it('不是 .pptx 时给出可读诊断', () => {
    expect(() => importPptx(new TextEncoder().encode('not a zip'), { title: 'x' }))
      .toThrow(PptImportError)
  })
})
