import { describe, expect, it } from 'vitest'
import { licenceOf, readFontFace, usedFamilies, wrapEot } from '../src/fonts.ts'

describe('字体嵌入许可', () => {
  it('Installable 与 Editable 可嵌入，Preview 只读嵌入', () => {
    expect(licenceOf(0x0000)).toEqual({ embeddable: true, readonly: false })
    expect(licenceOf(0x0008)).toEqual({ embeddable: true, readonly: false })
    expect(licenceOf(0x0004)).toEqual({ embeddable: true, readonly: true })
  })

  it('Restricted、BitmapOnly 与读不到 OS/2 一律跳过', () => {
    expect(licenceOf(0x0002)).toMatchObject({ embeddable: false })
    expect(licenceOf(0x0004 | 0x0200)).toMatchObject({ embeddable: false })
    expect(licenceOf(0x0200)).toMatchObject({ embeddable: false })
    expect(licenceOf(null)).toMatchObject({ embeddable: false })
  })
})

describe('字体族收集', () => {
  it('只收非空的文本与表格字体', () => {
    const deck = {
      pages: [{
        elements: [
          { kind: 'text', text: { font: 'Inter' } },
          { kind: 'text', text: { font: '' } },
          { kind: 'table', text: { font: 'Noto Sans' } },
          { kind: 'rect' },
        ],
      }],
    }
    expect(usedFamilies(deck).sort()).toEqual(['Inter', 'Noto Sans'])
  })
})

describe('EOT 封装', () => {
  it('非 glyf TrueType 直接返回 null', async () => {
    expect(wrapEot({
      path: 'x.ttf', family: 'X', fsType: 0, weight: 400,
      bytes: new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0, 0, 0, 0, 0]),
    })).toBeNull()
    expect(await readFontFace('/does/not/exist.ttf')).toBeNull()
  })
})
