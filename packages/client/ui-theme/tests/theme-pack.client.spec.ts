/** 主题包：校验、导出格式与分享链接的往返。 */
import { describe, expect, it } from 'vitest'
import {
  parseThemePack, serializeThemePack, themePackFromHash, themePackShareUrl,
} from '../src/client/theme-pack.ts'

const TOKENS = { '--dsw-alias-bg-base': '#101014', '--dsw-alias-label-primary': '#f2f2f5' }
const PALETTES = { light: { '--dsw-alias-bg-base': '#fafafa' }, dark: { '--dsw-alias-bg-base': '#101014' } }

describe('theme packs', () => {
  it('accepts a single-scheme pack and derives an id from the name', () => {
    const parsed = parseThemePack({ version: 1, name: 'Nord Night', scheme: 'dark', tokens: TOKENS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pack.id).toBe('imported-nord-night')
    expect(parsed.pack.englishName).toBe('Nord Night')
    expect(parsed.pack.tokens).toEqual(TOKENS)
  })

  it('accepts a scheme-following pack and english names', () => {
    const parsed = parseThemePack({ name: '双色', englishName: 'Dual', scheme: 'auto', palettes: PALETTES })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pack.englishName).toBe('Dual')
    expect(parsed.pack.palettes).toEqual(PALETTES)
  })

  it('avoids colliding with existing ids', () => {
    const parsed = parseThemePack({ name: 'Nord Night', scheme: 'dark', tokens: TOKENS }, ['imported-nord-night'])
    expect(parsed.ok && parsed.pack.id).toBe('imported-nord-night-2')
  })

  it('rejects malformed packs with a concrete reason', () => {
    const reason = (raw: unknown): string => {
      const parsed = parseThemePack(raw)
      return parsed.ok ? '' : parsed.reason
    }
    expect(reason('nope')).toContain('JSON 对象')
    expect(reason({ name: '', scheme: 'dark', tokens: TOKENS })).toContain('name')
    expect(reason({ version: 9, name: 'x', scheme: 'dark', tokens: TOKENS })).toContain('版本')
    expect(reason({ name: 'x', scheme: 'sepia', tokens: TOKENS })).toContain('scheme')
    expect(reason({ name: 'x', scheme: 'auto', tokens: TOKENS })).toContain('palettes')
    expect(reason({ name: 'x', scheme: 'dark', tokens: {} })).toContain('不能为空')
    expect(reason({ name: 'x', scheme: 'dark', tokens: { color: 'red' } })).toContain('应以 -- 开头')
    expect(reason({ name: 'x', scheme: 'dark', tokens: { '--a': '' } })).toContain('非空字符串')
    expect(reason({ name: 'x'.repeat(60), scheme: 'dark', tokens: TOKENS })).toContain('40')
  })

  it('round-trips through the exported file format', () => {
    const parsed = parseThemePack({ name: 'Nord Night', scheme: 'dark', tokens: TOKENS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const reparsed = parseThemePack(JSON.parse(serializeThemePack(parsed.pack)))
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.pack).toEqual(parsed.pack)
  })

  it('round-trips through a share link hash', () => {
    const parsed = parseThemePack({ name: '双色 主题', scheme: 'auto', palettes: PALETTES })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const url = themePackShareUrl(parsed.pack, 'http://localhost:5173/')
    expect(url.startsWith('http://localhost:5173/#theme-pack=')).toBe(true)
    const text = themePackFromHash(new URL(url).hash)
    expect(text).toBeDefined()
    const reparsed = parseThemePack(JSON.parse(text ?? 'null'))
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.pack.name).toBe('双色 主题')
    expect(reparsed.pack.palettes).toEqual(PALETTES)
  })

  it('ignores hashes without a pack and unreadable payloads', () => {
    expect(themePackShareUrl({
      id: 'imported-x', name: 'x', englishName: 'x', scheme: 'dark', tokens: TOKENS,
    }, '')).toBe('')
    expect(themePackFromHash('#other=1')).toBeUndefined()
    expect(themePackFromHash('theme-pack=%%%')).toBeUndefined()
  })
})
