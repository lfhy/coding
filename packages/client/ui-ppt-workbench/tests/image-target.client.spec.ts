/** 图片替换目标识别：占位文字与普通文字的边界由画布同一份有序元素决定。 */

import type { PptElement, PptPage } from 'coding-ppt-model'
import { describe, expect, it } from 'vitest'
import { imageReplacementTarget } from '../src/client/image-target.ts'

const rect: PptElement = { id: 'frame', kind: 'rect', x: 96, y: 188, w: 254, h: 143, fill: '#dddddd' }
const hint: PptElement = { id: 'hint', kind: 'text', x: 96, y: 188, w: 254, h: 143,
  text: { content: '代码截图', size: 18, color: '#333333', bold: false, align: 'center', valign: 'middle', font: '' } }
const ordinary: PptElement = { ...hint, id: 'ordinary', text: { ...hint.text, content: '业务说明' } }
const image: PptElement = { id: 'image', kind: 'image', x: 500, y: 200, w: 320, h: 200,
  source: 'media/old.png', fit: 'contain' }
const other: PptElement = { id: 'line', kind: 'line', x: 0, y: 0, w: 100, h: 0, color: '#444444', width: 2 }
const page = (elements: PptElement[]): PptPage => ({
  id: 'page', name: '演示', background: null, transition: 'none', elements,
})

describe('图片替换目标', () => {
  it('图片与矩形可替换；覆盖矩形的居中截图文字指向矩形并一起移除', () => {
    const slide = page([rect, hint, image])
    expect(imageReplacementTarget(slide, rect.id)).toEqual({ id: rect.id, label: hint.id })
    expect(imageReplacementTarget(slide, hint.id)).toEqual({ id: rect.id, label: hint.id })
    expect(imageReplacementTarget(slide, image.id)).toEqual({ id: image.id })
  })

  it('普通图形和普通文字不被误识别为占位，矩形仍可单独替换', () => {
    const plain = page([rect, ordinary, other])
    expect(imageReplacementTarget(plain, rect.id)).toEqual({ id: rect.id })
    expect(imageReplacementTarget(plain, ordinary.id)).toBeNull()
    expect(imageReplacementTarget(plain, other.id)).toBeNull()
    expect(imageReplacementTarget(plain, 'missing')).toBeNull()
  })

  it('内容、相邻关系、对齐或尺寸不一致时保留原文字', () => {
    for (const label of [
      { ...hint, text: { ...hint.text, content: '正文' } },
      { ...hint, text: { ...hint.text, align: 'left' as const } },
      { ...hint, text: { ...hint.text, valign: 'top' as const } },
      { ...hint, w: 200 },
      { ...hint, x: 97 },
      { ...hint, y: 189 },
      { ...hint, h: 142 },
    ]) {
      const slide = page([rect, label])
      expect(imageReplacementTarget(slide, rect.id)).toEqual({ id: rect.id })
      expect(imageReplacementTarget(slide, hint.id)).toBeNull()
    }
    const slide = page([rect, other, hint])
    expect(imageReplacementTarget(slide, rect.id)).toEqual({ id: rect.id })
    expect(imageReplacementTarget(slide, hint.id)).toBeNull()
  })
})
