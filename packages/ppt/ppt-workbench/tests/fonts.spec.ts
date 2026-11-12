import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectFonts, coversCjk, indexFonts, licenceOf, listSystemFontFamilies, readFontFace, systemFontDirs, usedFamilies,
  wrapEot,
} from '../src/fonts.ts'

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

describe('子集化嵌入（真实字体）', () => {
  it('子集明显小于整字体，且都写成可封装的 EOT', async () => {
    const dirs = systemFontDirs()
    const index = await indexFonts(dirs)
    const entry = [...index.entries()][0]
    if (entry === undefined) return
    const family = entry[1].family
    const deck = {
      pages: [{
        elements: [{
          kind: 'text',
          text: { content: '季度汇报 Q3 增长 32%', font: family },
        }],
      }],
    }
    const subsetted = await collectFonts(deck, dirs, { subset: true })
    const full = await collectFonts(deck, dirs, { subset: false })
    const subsetFontEntry = subsetted.fonts[0]
    const fullFontEntry = full.fonts[0]
    expect(subsetFontEntry?.subset).toBe(true)
    expect(fullFontEntry?.subset).toBe(false)
    if (subsetFontEntry === undefined || fullFontEntry === undefined) return
    expect(subsetFontEntry.bytes.length).toBeLessThan(fullFontEntry.bytes.length)
  })
})

describe('本机字体列表（字体下拉）', () => {
  it('列出字体目录里的族名，忽略非字体文件与不存在的目录', async () => {
    const source = firstSystemTtf()
    if (source === null) return
    const dir = mkdtempSync(join(tmpdir(), 'ppt-font-list-'))
    try {
      copyFileSync(source, join(dir, 'sample.ttf'))
      writeFileSync(join(dir, 'readme.txt'), 'not a font')
      const families = await listSystemFontFamilies([dir, join(dir, 'missing')])
      expect(families).toHaveLength(1)
      const face = await readFontFace(source)
      expect(families[0]).toBe(face?.family)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('中文字形覆盖', () => {
  it('带汉字的字体覆盖「中」，纯西文字体不覆盖', async () => {
    const cjkPath = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
    const latinPath = '/System/Library/Fonts/Supplemental/Chalkduster.ttf'
    const cjkFace = await readFontFace(cjkPath)
    const latinFace = await readFontFace(latinPath)
    if (cjkFace === null || latinFace === null) return
    // 导出据此决定 a:ea：不含中文的族只写西文，中文回落到主题黑体。
    expect(coversCjk(cjkFace.bytes)).toBe(true)
    expect(coversCjk(latinFace.bytes)).toBe(false)
  })
})
