// @vitest-environment jsdom
/** 外观层：强调色、壁纸、玻璃与主题包如何变成一层可撤销的令牌覆盖。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope, type StubSettingsScope } from 'coding-client-test-runtime'
import { ThemeRuntime } from '../src/client/theme-runtime.ts'
import { AppearanceRuntime } from '../src/client/appearance-runtime.ts'
import { registerThemeCatalog } from '../src/client/register.ts'
import { DEFAULT_GLASS, DEFAULT_WALLPAPER, type ThemeSettings } from '../src/theme-settings.ts'


const made: Context[] = []

afterEach(async () => {
  for (const ctx of made.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

/** 组装一套主题运行时 + 外观层，并注册内置目录。 */
function make() {
  const ctx = new Context()
  made.push(ctx)
  const host: StubSettingsScope<ThemeSettings> = stubSettingsScope<ThemeSettings>()
  const theme = new ThemeRuntime(ctx, host.scope)
  registerThemeCatalog(ctx, theme)
  const appearance = new AppearanceRuntime(ctx, host.scope, theme)
  return { ctx, host, theme, appearance }
}

/** 当前生效主题的令牌。 */
const tokens = (theme: ThemeRuntime): Record<string, string> => theme.getTheme().active.tokens

describe('AppearanceRuntime', () => {
  it('starts with the theme untouched and the documented defaults', () => {
    const { theme, appearance } = make()
    expect(appearance.getSnapshot()).toMatchObject({
      accent: '',
      wallpaper: DEFAULT_WALLPAPER,
      glass: DEFAULT_GLASS,
      favorites: [],
      packs: [],
    })
    expect(tokens(theme)).toEqual({})
  })

  it('washes the accent over brand tokens and restores the theme when cleared', () => {
    const { host, theme, appearance } = make()
    theme.setTheme('dream-abyss')
    const original = tokens(theme)['--dsw-alias-brand-primary']
    appearance.setAccent('#ff2200')
    expect(tokens(theme)['--dsw-alias-brand-primary']).toBe('#ff2200')
    expect(tokens(theme)['--dsw-alias-button-primary-fill']).toBe('#ff2200')
    expect(host.set).toHaveBeenCalledWith('accent', '#ff2200')
    appearance.setAccent('')
    expect(tokens(theme)['--dsw-alias-brand-primary']).toBe(original)
  })

  it('ignores an accent that is not a color', () => {
    const { theme, appearance } = make()
    appearance.setAccent('not-a-color')
    expect(appearance.getSnapshot().accent).toBe('')
    expect(tokens(theme)['--dsw-alias-brand-primary']).toBeUndefined()
  })

  it('lays the theme glow behind a diluted canvas when the wallpaper is on', () => {
    const { theme, appearance } = make()
    theme.setTheme('dream-abyss')
    appearance.setWallpaper({ mode: 'theme', opacity: 0.5, blur: 6 })
    const active = tokens(theme)
    expect(active['--dsh-wallpaper-image']).toContain('radial-gradient')
    expect(active['--dsh-wallpaper-opacity']).toBe('0.5')
    expect(active['--dsh-wallpaper-blur']).toBe('6px')
    // 画布被稀释：壁纸才有机会透出来。
    expect(active['--dsw-alias-bg-base']).toMatch(/^rgba\(/)
  })

  it('dilutes the canvas and panels for the built-in appearances as well', () => {
    const { theme, appearance } = make()
    theme.setTheme('dark')
    appearance.setWallpaper({ mode: 'gradient', gradient: 'mist' })
    // 内置深色的画布来自样式表，没有注册定义；兜底表必须给出它的实际颜色。
    expect(tokens(theme)['--dsw-alias-bg-base']).toMatch(/^rgba\(21, 23, 27, /)
    appearance.setGlass({ panelOpacity: 0.5 })
    expect(tokens(theme)['--dsw-alias-bg-layer-2']).toMatch(/^rgba\(44, 44, 46, /)
    theme.setTheme('light')
    expect(tokens(theme)['--dsw-alias-bg-base']).toMatch(/^rgba\(255, 255, 255, /)
  })

  it('turns the wallpaper layer off without touching the theme palette', () => {
    const { theme, appearance } = make()
    theme.setTheme('dream-abyss')
    appearance.setWallpaper({ mode: 'gradient', gradient: 'dusk' })
    expect(tokens(theme)['--dsh-wallpaper-image']).toContain('linear-gradient')
    appearance.setWallpaper({ mode: 'off' })
    expect(tokens(theme)['--dsh-wallpaper-image']).toBeUndefined()
    // 关闭后画布回到主题自己的底色，不再带透明度。
    expect(tokens(theme)['--dsw-alias-bg-base']).toBe('#111317')
  })

  it('uses an imported image with its fit and repeat', () => {
    const { theme, appearance } = make()
    theme.setTheme('dream-abyss')
    appearance.setWallpaper({ mode: 'image', url: 'data:image/png;base64,AAA', fit: 'tile' })
    const active = tokens(theme)
    expect(active['--dsh-wallpaper-image']).toBe('url("data:image/png;base64,AAA")')
    expect(active['--dsh-wallpaper-size']).toBe('auto')
    expect(active['--dsh-wallpaper-repeat']).toBe('repeat')
  })

  it('dilutes panel surfaces and blurs overlays for the frosted material', () => {
    const { theme, appearance } = make()
    theme.setTheme('dream-abyss')
    appearance.setGlass({ panelOpacity: 0.5 })
    expect(tokens(theme)['--dsw-alias-bg-layer-2']).toMatch(/^rgba\(42, 44, 50, 0\.46\)$/)
    appearance.setGlass({ material: 'frosted' })
    expect(tokens(theme)['--dsw-mask-blur']).toBe('blur(14px)')
  })

  it('registers imported packs, persists them, and drops their tokens on removal', () => {
    const { host, theme, appearance } = make()
    const pack = JSON.stringify({
      version: 1,
      name: 'Paper',
      scheme: 'light',
      tokens: { '--dsw-alias-bg-base': '#fdfaf4', '--dsw-alias-label-primary': '#2c2028' },
    })
    const result = appearance.importPack(pack)
    expect(result).toEqual({ ok: true, id: 'imported-paper' })
    expect(theme.getTheme().themes.map(candidate => candidate.id)).toContain('imported-paper')
    expect(host.set).toHaveBeenCalledWith('packs', [expect.objectContaining({ id: 'imported-paper' })])
    theme.setTheme('imported-paper')
    expect(tokens(theme)['--dsw-alias-bg-base']).toBe('#fdfaf4')
    expect(appearance.exportPack('imported-paper')).toContain('#fdfaf4')

    appearance.removePack('imported-paper')
    expect(theme.getTheme().themes.map(candidate => candidate.id)).not.toContain('imported-paper')
    expect(theme.getTheme().preference).toBe('system')
  })

  it('rejects an unreadable pack without registering anything', () => {
    const { theme, appearance } = make()
    expect(appearance.importPack('{')).toEqual({ ok: false, reason: '内容不是合法的 JSON' })
    const invalid = appearance.importPack(JSON.stringify({ name: 'x', scheme: 'dark', tokens: {} }))
    expect(invalid.ok).toBe(false)
    expect(theme.getTheme().themes.some(candidate => candidate.id.startsWith('imported-'))).toBe(false)
  })

  it('exports a built-in preset as a shareable pack', () => {
    const { appearance } = make()
    const text = appearance.exportPack('dream-abyss')
    expect(text).toBeDefined()
    const pack = JSON.parse(text ?? '{}') as { name: string; scheme: string; tokens: Record<string, string> }
    expect(pack.name).toBe('沉静蓝')
    expect(pack.scheme).toBe('dark')
    expect(pack.tokens['--dsw-alias-bg-base']).toBe('#111317')
    expect(appearance.exportPack('missing')).toBeUndefined()
  })

  it('adopts persisted appearance fields and re-applies the layer', () => {
    const { host, theme, appearance } = make()
    theme.setTheme('dream-abyss')
    host.publish({
      status: 'ready',
      writable: true,
      revision: 1,
      value: {
        preference: 'dream-abyss',
        accent: '#22cc55',
        wallpaper: { ...DEFAULT_WALLPAPER, mode: 'off' },
        glass: { ...DEFAULT_GLASS, panelOpacity: 0.8 },
        favorites: ['oc-dracula'],
        packs: [],
      },
    })
    expect(appearance.getSnapshot().accent).toBe('#22cc55')
    expect(appearance.getSnapshot().favorites).toEqual(['oc-dracula'])
    expect(tokens(theme)['--dsw-alias-brand-primary']).toBe('#22cc55')
  })

  it('resets the theme and the advanced appearance while keeping favorites and packs', () => {
    const { host, theme, appearance } = make()
    theme.setTheme('dream-nebula')
    appearance.setAccent('#22cc55')
    appearance.setGlass({ panelOpacity: 0.6 })
    appearance.toggleFavorite('dream-nebula')
    appearance.reset()
    expect(theme.getTheme().preference).toBe('system')
    expect(appearance.getSnapshot()).toMatchObject({
      accent: '',
      wallpaper: DEFAULT_WALLPAPER,
      glass: DEFAULT_GLASS,
      favorites: ['dream-nebula'],
    })
    expect(host.set).toHaveBeenCalledWith('wallpaper', DEFAULT_WALLPAPER)
  })

  it('toggles favorites and persists the resulting list', () => {
    const { host, appearance } = make()
    expect(appearance.toggleFavorite('oc-dracula')).toBe(true)
    expect(appearance.getSnapshot().favorites).toEqual(['oc-dracula'])
    expect(host.set).toHaveBeenCalledWith('favorites', ['oc-dracula'])
    expect(appearance.toggleFavorite('oc-dracula')).toBe(false)
    expect(appearance.getSnapshot().favorites).toEqual([])
  })

  it('removes its override layer when the plugin fiber is disposed', async () => {
    const { ctx, theme, appearance } = make()
    theme.setTheme('dream-abyss')
    appearance.setAccent('#ff2200')
    expect(tokens(theme)['--dsw-alias-brand-primary']).toBe('#ff2200')
    await ctx.fiber.dispose()
    // 目录随 fiber 一起撤下，选择回落到基础配色，覆盖层也随之消失。
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().active.tokens['--dsw-alias-brand-primary']).toBeUndefined()
  })
})
