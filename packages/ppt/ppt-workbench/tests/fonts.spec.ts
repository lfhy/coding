import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { licenceOf, readFontFace, systemFontDirs, usedFamilies, wrapEot } from '../src/fonts.ts'

/** 找一个真实的 .ttf 用来验证封装；没有系统字体时这些用例跳过。 */
function firstSystemTtf(): string | null {
  for (const dir of systemFontDirs()) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find(name => name.toLowerCase().endsWith('.ttf'))
    if (hit !== undefined) return join(dir, hit)
  }
  return null
}

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

describe('EOT 封装（真实字体）', () => {
  const path = firstSystemTtf()
  it.skipIf(path === null)('写出与声明长度一致的 EOT 头', async () => {
    const face = await readFontFace(path as string)
    expect(face).not.toBeNull()
    if (face === null) return
    const eot = wrapEot(face)
    expect(eot).not.toBeNull()
    if (eot === null) return
    const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength)
    expect(view.getUint32(0, true)).toBe(eot.length)
    expect(view.getUint32(4, true)).toBe(face.bytes.length)
    expect(view.getUint32(8, true)).toBe(0x00020001)
  })
})
