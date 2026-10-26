/** OpenCode 适配层：语义槽到本项目令牌的映射与派生。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hasLightPalette, mapOpencodeTokens, opencodePreset } from '../src/themes/opencode.ts'
import type { OpencodePaletteData } from '../src/themes/types.ts'

const SHEETS = ['base.css', 'design-platform.css', 'scrollbar.css', 'gradient-shadow-text.css', 'shiki.css', 'wallpaper.css']

/** 本包样式表里出现过的自定义属性名。 */
function sheetTokens(): Set<string> {
  const names = new Set<string>()
  for (const sheet of SHEETS) {
    const text = readFileSync(new URL(`../src/styles/${sheet}`, import.meta.url), 'utf8')
    for (const match of text.matchAll(/--[a-z0-9-]+/g)) names.add(match[0])
  }
  return names
}

/** 一套最小可用的语义色。 */
const SLOTS: Record<string, string> = {
  background: '#101014',
  backgroundPanel: '#16161c',
  backgroundElement: '#1d1d25',
  text: '#f2f2f5',
  textMuted: '#a0a0aa',
  primary: '#8b7cf6',
  secondary: '#c084fc',
  info: '#38bdf8',
  success: '#4ade80',
  warning: '#fbbf24',
  error: '#f87171',
  border: '#2a2a33',
  borderActive: '#3d3d4a',
  markdownLink: '#93c5fd',
  markdownHeading: '#ffffff',
  markdownCode: '#f0abfc',
  markdownEmph: '#fca5a5',
  markdownStrong: '#fef08a',
  markdownBlockQuote: '#a1a1aa',
  syntaxComment: '#71717a',
  syntaxKeyword: '#f472b6',
  syntaxFunction: '#60a5fa',
  syntaxType: '#34d399',
  syntaxNumber: '#fbbf24',
  syntaxString: '#a3e635',
  syntaxOperator: '#e4e4e7',
  codeBlockBg: '#14141a',
  codeHeaderBg: '#1a1a22',
  inputBg: '#181820',
  bubbleBg: '#1f1f2a',
  sidebarBg: '#0e0e12',
}

/** 一条最小可用的上游配色。 */
function palette(id = 'test', patch: Record<string, string | undefined> = {}): OpencodePaletteData {
  const dark = { ...SLOTS, ...patch } as Record<string, string>
  return {
    id,
    name: 'Test',
    englishName: 'Test',
    palettes: { dark, light: { ...dark, background: '#fafafa', text: '#18181b' } },
  }
}

describe('opencode adapter', () => {
  it('maps semantic slots onto declared design tokens only', () => {
    const known = sheetTokens()
    const tokens = mapOpencodeTokens(SLOTS, true)
    expect(Object.keys(tokens).length).toBeGreaterThan(50)
    for (const [name, value] of Object.entries(tokens)) {
      expect(known.has(name), `mapped unknown ${name}`).toBe(true)
      expect(value.trim()).not.toBe('')
    }
    expect(tokens['--dsw-alias-bg-base']).toBe('#101014')
    expect(tokens['--dsw-alias-brand-primary']).toBe('#8b7cf6')
    expect(tokens['--shiki-token-keyword']).toBe('#f472b6')
  })

  it('drops transparent and missing slots instead of faking a value', () => {
    const tokens = mapOpencodeTokens({ ...SLOTS, background: 'transparent', bubbleBg: undefined } as unknown as Record<string, string>, true)
    expect(tokens['--dsw-alias-bg-base']).toBeUndefined()
    expect(tokens['--dsw-specific-bubble']).toBeUndefined()
  })

  it('derives hover and dimmed values in the direction of the scheme', () => {
    const dark = mapOpencodeTokens(SLOTS, true)
    const light = mapOpencodeTokens({ ...SLOTS, background: '#fafafa', text: '#18181b' }, false)
    expect(dark['--dsw-alias-button-primary-hover']).not.toBe(light['--dsw-alias-button-primary-hover'])
    expect(light['--dsw-alias-button-primary-dimmed']).toBe('rgba(139, 124, 246, 0.2)')
    expect(dark['--dsw-alias-brand-text']).toBe('#f4f4f5')
  })

  it('treats a dark or transparent light palette as a dark-only theme', () => {
    expect(hasLightPalette('#fafafa')).toBe(true)
    expect(hasLightPalette('#0b0b0f')).toBe(false)
    expect(hasLightPalette('transparent')).toBe(false)
    expect(hasLightPalette(undefined)).toBe(false)
  })

  it('builds presets with prefixes, backdrops, and preview colors', () => {
    const preset = opencodePreset(palette('demo'))
    expect(preset.id).toBe('oc-demo')
    expect(preset.scheme).toBe('auto')
    expect(preset.backdrop.light).toContain('radial-gradient')
    expect(preset.backdrop.dark).toContain('radial-gradient')
    expect(preset.preview).toEqual({ background: '#101014', text: '#f2f2f5', accent: '#8b7cf6' })
  })

  it('collapses dark-only palettes to a single dark side', () => {
    const data = palette('dark-only', { background: '#0b0b0f' })
    data.palettes.light = { ...data.palettes.dark }
    const preset = opencodePreset(data)
    expect(preset.scheme).toBe('dark')
    expect(preset.palettes.light).toBeUndefined()
    expect(preset.backdrop.light).toBeUndefined()
  })
})
