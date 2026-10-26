/**
 * 外观层：主题之上的强调色、壁纸、玻璃与导入的主题包。
 *
 * 主题运行时负责"底色与配色"，这一层负责"材质"：它把用户的高级设置换算成
 * 一层 `ctx.theme.overrideTokens` 覆盖，因此不会改动任何已注册主题，关掉即
 * 恢复主题原样。计算只读取注册表里的主题定义（不是合成后的快照），否则本层
 * 自己的输出会在下一次计算里被当成主题底色、逐次叠加透明度。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from 'coding-client-runtime/client'
import type { ThemeDefinition, ThemeRuntime, ThemeTokenOverrides, ThemeTokens } from './theme-runtime.ts'
import type {
  GlassSettings, ImportedThemePack, ThemeSettings, WallpaperSettings,
} from '../theme-settings.ts'
import {
  DEFAULT_GLASS, DEFAULT_WALLPAPER, normalizeThemeSettings,
} from '../theme-settings.ts'
import { findThemePreset, presetBackdrop } from '../themes/catalog.ts'
import { parseColor, readableOn, shade, withAlpha } from '../themes/color.ts'
import { findWallpaperGradient } from './wallpaper.ts'
import { parseThemePack, serializeThemePack } from './theme-pack.ts'

/** 覆盖层来源；一个来源只有一层，重新注册即替换。 */
const LAYER_SOURCE = 'ui-theme-appearance'

/** 壁纸层可见时画布留出的最低不透明度：全透明会让正文压在图上读不清。 */
const MIN_CANVAS_ALPHA = 0.18

/** 面板类 token：玻璃不透明度作用在这些"浮起来的面"上。 */
const PANEL_TOKENS: readonly string[] = [
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-specific-bubble',
  '--dsw-specific-menu',
  '--dsw-specific-selector',
  '--dsw-specific-tip',
]

/** 壁纸可见时的画布 token：只有它们半透明，壁纸才在下面透出来。 */
const CANVAS_TOKENS: readonly string[] = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 外观设置变化（强调色、壁纸、玻璃、收藏或导入的主题包）。
     * @param snapshot - 当前的外观快照。
     * @mode emit
     */
    'theme/appearance-change'(snapshot: AppearanceSnapshot): void
  }
}

/** 一次外观设置的不可变快照。 */
export interface AppearanceSnapshot {
  /** 强调色；空串表示跟随主题。 */
  accent: string
  /** 壁纸设置。 */
  wallpaper: WallpaperSettings
  /** 玻璃材质与面板不透明度。 */
  glass: GlassSettings
  /** 收藏的主题 id。 */
  favorites: readonly string[]
  /** 导入的主题包。 */
  packs: readonly ImportedThemePack[]
  /** 单调递增的变化序号。 */
  revision: number
}

/** 导入主题包的结果。 */
export interface PackImportResult {
  /** 是否导入成功。 */
  ok: boolean
  /** 失败原因（可直接展示给用户）。 */
  reason?: string
  /** 导入后的主题 id。 */
  id?: string
}

/** 把一到两套令牌夹到合法区间。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 内置浅色/深色两套外观没有注册主题定义——它们的底色直接来自
 * `design-platform.css`。壁纸与玻璃要稀释这些表面，就必须知道它们的实际颜色，
 * 这里的取值与 design-platform.css 的别名层逐个对应（改那边要同步这里）。
 */
const BUILTIN_TOKENS: Readonly<Record<'light' | 'dark', ThemeTokens>> = {
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-specific-sidebar-fill': '#f9fafb',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-layer-3': '#ffffff',
    '--dsw-alias-bg-overlay': '#e9ecf2',
    '--dsw-alias-button-elevated-fill': '#ffffff',
    '--dsw-alias-button-floating-fill': '#ffffff',
    '--dsw-alias-markdown-code-block': '#fafafa',
    '--dsw-alias-markdown-code-block-banner': '#fafafa',
    '--dsw-specific-bubble': '#edf3fe',
    '--dsw-specific-menu': '#ffffff',
    '--dsw-specific-selector': '#f5f6f7',
    '--dsw-specific-tip': '#f5f6f7',
  },
  dark: {
    '--dsw-alias-bg-base': '#15171b',
    '--dsw-specific-sidebar-fill': '#1b1b1c',
    '--dsw-alias-bg-layer-2': '#2c2c2e',
    '--dsw-alias-bg-layer-3': '#353538',
    '--dsw-alias-bg-overlay': '#61666b',
    '--dsw-alias-button-elevated-fill': '#43454a',
    '--dsw-alias-button-floating-fill': '#2c2c2e',
    '--dsw-alias-markdown-code-block': '#1b1b1c',
    '--dsw-alias-markdown-code-block-banner': '#2c2c2e',
    '--dsw-specific-bubble': '#2c2c2e',
    '--dsw-specific-menu': '#353538',
    '--dsw-specific-selector': '#353538',
    '--dsw-specific-tip': '#353538',
  },
}

/** 取主题定义在该明暗下的基础令牌（不读合成快照；内置两套外观用内置表兜底）。 */
function definitionTokens(definition: ThemeDefinition | undefined, scheme: 'light' | 'dark'): ThemeTokens {
  const builtin = BUILTIN_TOKENS[scheme]
  if (definition === undefined) return builtin
  const tokens = definition.colorScheme === 'auto' ? (definition.palettes?.[scheme] ?? {}) : definition.tokens
  // 预设只覆盖它自己声明的令牌；没声明的表面回落到内置表，先生效于玻璃与壁纸。
  return { ...builtin, ...tokens }
}

/** 主题包转成可注册的定义。 */
function packDefinition(pack: ImportedThemePack): ThemeDefinition {
  if (pack.scheme === 'auto' && pack.palettes !== undefined) {
    return { id: pack.id, colorScheme: 'auto', tokens: {}, palettes: pack.palettes }
  }
  return {
    id: pack.id,
    colorScheme: pack.scheme === 'light' ? 'light' : 'dark',
    tokens: pack.tokens ?? pack.palettes?.dark ?? {},
  }
}

/**
 * 外观设置与覆盖层的主人。写入只经本类的方法（每个方法同时落到设置文档），
 * 读取只经 {@link getSnapshot}；主题变化或设置变化后重新计算覆盖层。
 */
export class AppearanceRuntime {
  private state: AppearanceSnapshot
  private detach: (() => void) | undefined
  private signature = ''
  private revision = 0
  /** 已注册的主题包 id → 卸载函数。 */
  private readonly registered = new Map<string, () => void>()

  /**
   * @param ctx - 所属上下文（主题变化监听与覆盖层随它释放）。
   * @param host - `ui-theme` 分节的设置作用域。
   * @param theme - 主题运行时（覆盖层挂到它上面）。
   */
  constructor(
    private readonly ctx: Context,
    private readonly host: SettingsScope<ThemeSettings>,
    private readonly theme: ThemeRuntime,
  ) {
    this.state = this.fromSettings(undefined)
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-theme: appearance adoption')
    ctx.on('theme/change', () => { this.apply() })
    ctx.effect(() => () => {
      this.detach?.()
      this.detach = undefined
      for (const dispose of this.registered.values()) dispose()
      this.registered.clear()
    }, 'ui-theme: appearance layer teardown')
    this.adopt()
  }

  /** 读取当前外观快照。 */
  getSnapshot(): AppearanceSnapshot {
    return this.state
  }

  /**
   * 设置强调色。
   * @param color - CSS 颜色；空串表示跟随主题。
   */
  setAccent(color: string): void {
    const next = color.trim()
    if (parseColor(next) === undefined && next !== '') return
    this.patch({ accent: next })
    void this.host.set('accent', next)
  }

  /**
   * 改写壁纸设置（可只改一项）。
   * @param patch - 要改的字段。
   */
  setWallpaper(patch: Partial<WallpaperSettings>): void {
    const wallpaper = { ...this.state.wallpaper, ...patch }
    this.patch({ wallpaper })
    void this.host.set('wallpaper', wallpaper)
  }

  /**
   * 改写玻璃设置。
   * @param patch - 要改的字段。
   */
  setGlass(patch: Partial<GlassSettings>): void {
    const glass = { ...this.state.glass, ...patch }
    this.patch({ glass })
    void this.host.set('glass', glass)
  }

  /**
   * 收藏/取消收藏一个主题。
   * @param id - 主题 id。
   * @returns 操作后是否处于收藏状态。
   */
  toggleFavorite(id: string): boolean {
    const favorites = this.state.favorites.includes(id)
      ? this.state.favorites.filter(favorite => favorite !== id)
      : [...this.state.favorites, id]
    this.patch({ favorites })
    void this.host.set('favorites', favorites)
    return favorites.includes(id)
  }

  /**
   * 导入一段主题包 JSON：校验、注册、持久化。
   * @param text - 文件内容或分享链接里的 JSON 文本。
   * @returns 导入结果；失败时 `reason` 指明是哪一项不合格。
   */
  importPack(text: string): PackImportResult {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, reason: '内容不是合法的 JSON' }
    }
    const existing = [...this.theme.getTheme().themes.map(theme => theme.id), ...this.state.packs.map(pack => pack.id)]
    const parsed = parseThemePack(raw, existing)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const packs = [...this.state.packs, parsed.pack]
    this.registerPack(parsed.pack)
    this.patch({ packs })
    void this.host.set('packs', packs)
    // 导入即应用：主题包自带强调色时一并采纳，和导出时看到的样子一致。
    if (parsed.pack.accent !== undefined && parsed.pack.accent !== '') {
      this.setAccent(parsed.pack.accent)
    }
    this.theme.setTheme(parsed.pack.id)
    return { ok: true, id: parsed.pack.id }
  }

  /**
   * 移除一个导入的主题包。
   * @param id - 主题包 id。
   */
  removePack(id: string): void {
    const packs = this.state.packs.filter(pack => pack.id !== id)
    if (packs.length === this.state.packs.length) return
    this.registered.get(id)?.()
    this.registered.delete(id)
    this.patch({ packs })
    void this.host.set('packs', packs)
  }

  /**
   * 导出一个主题包为 JSON 文本（主题包或任意已注册主题都可以导）。
   * @param id - 主题 id。
   * @returns JSON 文本；主题不存在时返回 undefined。
   */
  exportPack(id: string): string | undefined {
    const pack = this.state.packs.find(candidate => candidate.id === id)
    if (pack !== undefined) return serializeThemePack(pack)
    const preset = findThemePreset(id)
    if (preset !== undefined) {
      return serializeThemePack({
        id: preset.id,
        name: preset.name,
        englishName: preset.englishName,
        scheme: preset.scheme,
        ...(preset.scheme === 'auto'
          ? { palettes: { light: preset.palettes.light ?? {}, dark: preset.palettes.dark ?? {} } }
          : { tokens: (preset.scheme === 'light' ? preset.palettes.light : preset.palettes.dark) ?? {} }),
        accent: this.state.accent,
      })
    }
    const definition = this.theme.getTheme().themes.find(theme => theme.id === id)
    if (definition === undefined) return undefined
    const name = definition.id
    return serializeThemePack({
      id: definition.id,
      name,
      englishName: name,
      scheme: definition.colorScheme === 'auto' ? 'auto' : definition.colorScheme === 'dark' ? 'dark' : 'light',
      ...(definition.colorScheme === 'auto'
        ? { palettes: definition.palettes ?? { light: {}, dark: {} } }
        : { tokens: definition.tokens }),
    })
  }

  /**
   * 还原默认外观：跟随系统、无强调色、无自定义壁纸、标准材质。
   * 收藏与导入的主题包保留。
   */
  reset(): void {
    this.theme.setTheme('system')
    const wallpaper = { ...DEFAULT_WALLPAPER }
    const glass = { ...DEFAULT_GLASS }
    this.patch({ accent: '', wallpaper, glass })
    void this.host.set('accent', '')
    void this.host.set('wallpaper', wallpaper)
    void this.host.set('glass', glass)
  }

  /**
   * 从设置分节组装快照：旧文档可能没有新字段，逐层用默认值补齐后再归一化，
   * 这样升级后用户已有的主题选择不会因为缺少外观字段而整节失效。
   */
  private fromSettings(section: ThemeSettings | undefined): AppearanceSnapshot {
    const normalized = normalizeThemeSettings({
      preference: section?.preference ?? 'system',
      accent: section?.accent ?? '',
      wallpaper: { ...DEFAULT_WALLPAPER, ...section?.wallpaper },
      glass: { ...DEFAULT_GLASS, ...section?.glass },
      favorites: section?.favorites ?? [],
      packs: section?.packs ?? [],
    })
    return Object.freeze({
      accent: normalized.accent,
      wallpaper: Object.freeze(normalized.wallpaper),
      glass: Object.freeze(normalized.glass),
      favorites: Object.freeze([...normalized.favorites]),
      packs: Object.freeze([...normalized.packs]),
      revision: this.revision,
    })
  }

  /** 采纳设置文档里的外观字段并重算覆盖层。 */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    const next = this.fromSettings(section)
    this.syncPacks(next.packs)
    if (this.signatureOfState(next) === this.signatureOfState(this.state)) return
    this.state = Object.freeze({ ...next, revision: this.revision })
    this.ctx.emit('theme/appearance-change', this.state)
    this.apply()
  }

  /** 只用于比较两次快照是否等价（忽略 revision）。 */
  private signatureOfState(snapshot: AppearanceSnapshot): string {
    return JSON.stringify({
      accent: snapshot.accent,
      wallpaper: snapshot.wallpaper,
      glass: snapshot.glass,
      favorites: snapshot.favorites,
      packs: snapshot.packs.map(pack => pack.id),
    })
  }

  /** 改一部分外观字段并重算。 */
  private patch(patch: Partial<AppearanceSnapshot>): void {
    this.revision += 1
    this.state = Object.freeze({ ...this.state, ...patch, revision: this.revision })
    this.ctx.emit('theme/appearance-change', this.state)
    this.apply()
  }

  /** 把主题包注册进主题运行时（已注册的按 id 跳过，消失的撤销）。 */
  private syncPacks(packs: readonly ImportedThemePack[]): void {
    const wanted = new Set(packs.map(pack => pack.id))
    for (const [id, dispose] of [...this.registered]) {
      if (wanted.has(id)) continue
      dispose()
      this.registered.delete(id)
    }
    for (const pack of packs) {
      if (this.registered.has(pack.id)) continue
      this.registerPack(pack)
    }
  }

  /** 注册一个主题包；主题运行时已有同名 id 时静默跳过（内置主题优先）。 */
  private registerPack(pack: ImportedThemePack): void {
    if (this.registered.has(pack.id)) return
    if (this.theme.getTheme().themes.some(theme => theme.id === pack.id)) return
    this.registered.set(pack.id, this.theme.register(packDefinition(pack)))
  }

  /** 重新计算并挂上覆盖层；与上一版等价时不动注册表。 */
  private apply(): void {
    const layer = this.layer()
    const signature = JSON.stringify(layer)
    if (signature === this.signature) return
    this.signature = signature
    this.detach?.()
    this.detach = this.theme.overrideTokens(LAYER_SOURCE, layer)
  }

  /** 合成覆盖层：每个 token 给出明暗两态，各自按本方案的底色算。 */
  private layer(): ThemeTokenOverrides {
    const snapshot = this.theme.getTheme()
    const definition = snapshot.themes.find(theme => theme.id === snapshot.active.id)
    const preset = findThemePreset(snapshot.active.id)
    const sides = (['light', 'dark'] as const).map((scheme) => {
      const base = definitionTokens(definition, scheme)
      return { scheme, base, tokens: this.sideTokens(base, scheme, preset) }
    })
    const layer: ThemeTokenOverrides = {}
    const names = new Set(sides.flatMap(side => Object.keys(side.tokens)))
    for (const name of names) {
      const light = sides[0]?.tokens[name]
      const dark = sides[1]?.tokens[name]
      if (light === undefined || dark === undefined) continue
      layer[name] = { light, dark }
    }
    return layer
  }

  /** 单侧覆盖：强调色 → 玻璃 → 壁纸（后者改写画布的透明度，必须最后算）。 */
  private sideTokens(base: ThemeTokens, scheme: 'light' | 'dark', preset: ReturnType<typeof findThemePreset>): ThemeTokens {
    const tokens = this.accentTokens(scheme)
    Object.assign(tokens, this.glassTokens(base))
    Object.assign(tokens, this.wallpaperTokens(base, scheme, preset))
    return tokens
  }

  /** 强调色令牌：强调色不可解析时整组不落。 */
  private accentTokens(scheme: 'light' | 'dark'): ThemeTokens {
    const accent = this.state.accent
    if (accent === '' || parseColor(accent) === undefined) return {}
    const dark = scheme === 'dark'
    const tokens: ThemeTokens = {
      '--dsw-alias-brand-primary': accent,
      '--dsw-alias-brand-text': readableOn(accent),
      '--dsw-alias-brand-primary-invert': readableOn(accent),
      '--dsw-alias-state-business-primary': accent,
    }
    const optional: Array<[string, string | undefined]> = [
      ['--dsw-alias-button-primary-fill', accent],
      ['--dsw-alias-button-primary-hover', shade(accent, 0.14, dark)],
      ['--dsw-alias-button-primary-dimmed', withAlpha(accent, 0.2)],
      ['--dsw-alias-state-business-tertiary', withAlpha(accent, 0.12)],
      ['--dsw-alias-interactive-bg-hover-accent', withAlpha(accent, 0.2)],
      ['--dsw-specific-sidebar-nav-item-active-accent', withAlpha(accent, 0.35)],
    ]
    for (const [name, value] of optional) {
      if (value !== undefined) tokens[name] = value
    }
    return tokens
  }

  /** 玻璃令牌：面板底按不透明度稀释，磨砂额外给遮罩加背景模糊。 */
  private glassTokens(base: ThemeTokens): ThemeTokens {
    const glass = this.state.glass
    const tokens: ThemeTokens = {}
    if (glass.panelOpacity < 1) {
      for (const name of PANEL_TOKENS) {
        const value = base[name]
        if (value === undefined) continue
        const diluted = withAlpha(value, glass.panelOpacity)
        if (diluted !== undefined) tokens[name] = diluted
      }
    }
    if (glass.material === 'frosted') tokens['--dsw-mask-blur'] = 'blur(14px)'
    return tokens
  }

  /** 壁纸令牌：自带背景/渐变/图片 + 画布透明度。 */
  private wallpaperTokens(base: ThemeTokens, scheme: 'light' | 'dark', preset: ReturnType<typeof findThemePreset>): ThemeTokens {
    const wallpaper = this.state.wallpaper
    const background = this.wallpaperBackground(wallpaper, scheme, preset)
    if (background === undefined) return {}
    const frosted = this.state.glass.material === 'frosted'
    const blur = clamp(wallpaper.blur + (frosted ? 6 : 0), 0, 40)
    const tokens: ThemeTokens = {
      '--dsh-wallpaper-image': background,
      '--dsh-wallpaper-opacity': String(clamp(wallpaper.opacity, 0, 1)),
      '--dsh-wallpaper-blur': `${blur}px`,
    }
    if (wallpaper.mode === 'image') {
      const fit = wallpaper.fit
      tokens['--dsh-wallpaper-size'] = fit === 'cover' ? 'cover' : fit === 'contain' ? 'contain' : 'auto'
      tokens['--dsh-wallpaper-repeat'] = fit === 'tile' ? 'repeat' : 'no-repeat'
    }
    const canvasAlpha = clamp(1 - wallpaper.opacity * 0.85, MIN_CANVAS_ALPHA, 1)
    for (const [index, name] of CANVAS_TOKENS.entries()) {
      const value = base[name]
      if (value === undefined) continue
      const alpha = index === 0 ? canvasAlpha : clamp(canvasAlpha + 0.08, MIN_CANVAS_ALPHA, 1)
      const diluted = withAlpha(value, alpha)
      if (diluted !== undefined) tokens[name] = diluted
    }
    return tokens
  }

  /** 按来源取壁纸的 CSS `background` 值。 */
  private wallpaperBackground(
    wallpaper: WallpaperSettings,
    scheme: 'light' | 'dark',
    preset: ReturnType<typeof findThemePreset>,
  ): string | undefined {
    switch (wallpaper.mode) {
      case 'off':
        return undefined
      case 'theme':
        return presetBackdrop(preset, scheme)
      case 'gradient':
        return findWallpaperGradient(wallpaper.gradient)?.background
      case 'image':
        return wallpaper.url === '' ? undefined : `url("${wallpaper.url.replace(/"/g, '%22')}")`
    }
  }
}
