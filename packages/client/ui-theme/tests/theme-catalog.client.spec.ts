/** 内置主题目录：移植来的数据必须自洽，且只覆盖本项目真的有的令牌。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASE_THEME_CHOICES, THEME_GROUPS, THEME_PRESETS, THEME_SOURCES, findThemePreset, themeGroupOf,
} from '../src/themes/catalog.ts'

const SHEETS = [
  'base.css',
  'design-platform.css',
  'scrollbar.css',
  'gradient-shadow-text.css',
  'shiki.css',
  'wallpaper.css',
]

/** 本包全部样式表里出现过的自定义属性名。 */
function sheetTokens(): Set<string> {
  const names = new Set<string>()
  for (const sheet of SHEETS) {
    const text = readFileSync(new URL(`../src/styles/${sheet}`, import.meta.url), 'utf8')
    for (const match of text.matchAll(/--[a-z0-9-]+/g)) names.add(match[0])
  }
  return names
}

describe('theme catalog', () => {
  it('ships the three ported sources plus the built-in choices', () => {
    const counts = new Map<string, number>()
    for (const preset of THEME_PRESETS) counts.set(preset.source, (counts.get(preset.source) ?? 0) + 1)
    expect(counts.get('dream-skin')).toBe(8)
    expect(counts.get('joi')).toBe(2)
    expect(counts.get('opencode')).toBe(37)
    expect(BASE_THEME_CHOICES.map(choice => choice.id)).toEqual(['system', 'light', 'dark'])
    expect(THEME_SOURCES.map(source => source.id)).toEqual(['builtin', 'dream-skin', 'joi', 'opencode', 'imported'])
  })

  it('keeps ids unique, resolvable, and distinct from the built-in preferences', () => {
    const ids = THEME_PRESETS.map(preset => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of THEME_PRESETS) {
      expect(preset.id).not.toBe('system')
      expect(findThemePreset(preset.id)).toBe(preset)
    }
    expect(findThemePreset('system')).toBeUndefined()
  })

  it('gives every preset the palettes its scheme promises', () => {
    for (const preset of THEME_PRESETS) {
      if (preset.scheme === 'auto') {
        expect(Object.keys(preset.palettes.light ?? {}).length).toBeGreaterThan(10)
        expect(Object.keys(preset.palettes.dark ?? {}).length).toBeGreaterThan(10)
      } else {
        expect(Object.keys(preset.palettes[preset.scheme] ?? {}).length).toBeGreaterThan(10)
        expect(preset.palettes[preset.scheme === 'light' ? 'dark' : 'light']).toBeUndefined()
      }
      expect(preset.preview.background).toBeTruthy()
      expect(preset.preview.accent).toBeTruthy()
    }
  })

  it('only overrides variables this package declares or consumes', () => {
    const known = sheetTokens()
    for (const preset of THEME_PRESETS) {
      for (const side of [preset.palettes.light, preset.palettes.dark]) {
        for (const [name, value] of Object.entries(side ?? {})) {
          expect(known.has(name), `${preset.id} overrides unknown ${name}`).toBe(true)
          expect(value.trim()).not.toBe('')
        }
      }
    }
  })

  it('groups every preset into a declared color family', () => {
    const groups = new Set(THEME_GROUPS.map(group => group.id))
    for (const preset of THEME_PRESETS) expect(groups.has(themeGroupOf(preset))).toBe(true)
  })

  it('ships interface thumbnails for the ported themes that have them', () => {
    const dream = findThemePreset('dream-abyss')
    expect(dream?.thumbnails.dark).toMatch(/^data:image\/jpeg;base64,/)
    expect(dream?.thumbnails.light).toBeUndefined()
    const ivory = findThemePreset('dream-ivory')
    expect(ivory?.thumbnails.light).toMatch(/^data:image\/jpeg;base64,/)

    const joiFlowers = findThemePreset('joi-flowers')
    expect(joiFlowers?.thumbnails.light).toMatch(/^data:image\/jpeg;base64,/)
    expect(joiFlowers?.thumbnails.dark).toMatch(/^data:image\/jpeg;base64,/)
    expect(joiFlowers?.thumbnails.light).not.toBe(joiFlowers?.thumbnails.dark)

    // OpenCode 只有整体截图，没有逐套缩略图：卡片回落到配色块。
    expect(findThemePreset('oc-dracula')?.thumbnails).toEqual({})
    for (const preset of THEME_PRESETS) {
      for (const url of Object.values(preset.thumbnails)) {
        expect(url).toMatch(/^data:image\/jpeg;base64,/)
      }
    }
  })

  it('classifies dark-only OpenCode palettes as fixed dark themes', () => {
    expect(findThemePreset('oc-aura')?.scheme).toBe('dark')
    expect(findThemePreset('oc-dracula')?.scheme).toBe('auto')
  })
})
