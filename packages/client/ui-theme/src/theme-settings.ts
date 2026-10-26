/**
 * 主题外观的持久化契约：宿主设置文档里的 `ui-theme` 分节。
 *
 * 分节由主题运行时与外观层共同写入：主题运行时只写 `preference`（内置三项
 * 或任一内置预设 id），外观层写强调色、壁纸、玻璃与收藏。所有字段都是普通
 * JSON 值，浏览器侧绑定时按同一份 schema 校验——远程浏览器没有特权设置通道，
 * 它的改动只留在进程内。
 */
import z from '@deepseek-ai/schemastery'

/** 内置外观偏好：跟随系统与两套基础配色。 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** 设置分节名。 */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** 承载所选主题的字段名。 */
export const THEME_PREFERENCE_FIELD = 'preference'

/** 内置外观偏好。 */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** 持久化的主题选择：内置偏好或任一内置预设 id。 */
export type ThemeSelection = string

/** 没有用户选择时的默认外观。 */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** 壁纸来源：跟随主题自带的弥散光、关闭、渐变预设、图片。 */
export const WALLPAPER_MODES = ['theme', 'off', 'gradient', 'image'] as const

/** 壁纸来源。 */
export type WallpaperMode = typeof WALLPAPER_MODES[number]

/** 图片壁纸的填充方式：裁剪填满、完整显示、平铺。 */
export const WALLPAPER_FITS = ['cover', 'contain', 'tile'] as const

/** 图片壁纸的填充方式。 */
export type WallpaperFit = typeof WALLPAPER_FITS[number]

/** 壁纸设置；图片本身以 data URL 存在 `url` 里，随设置文档一起持久化。 */
export interface WallpaperSettings {
  /** 壁纸来源。 */
  mode: WallpaperMode
  /** 渐变预设 id（`wallpaper.ts` 的目录键）。 */
  gradient: string
  /** 图片 data URL 或 http(s) 图片地址。 */
  url: string
  /** 壁纸可见度（0–1）；0 时画布完全遮住壁纸。 */
  opacity: number
  /** 壁纸模糊半径（px）。 */
  blur: number
  /** 图片填充方式。 */
  fit: WallpaperFit
}

/** 玻璃材质：标准平面与磨砂玻璃。 */
export const GLASS_MATERIALS = ['standard', 'frosted'] as const

/** 玻璃材质。 */
export type GlassMaterial = typeof GLASS_MATERIALS[number]

/** 玻璃与浮层不透明度设置。 */
export interface GlassSettings {
  /** 材质种类；磨砂额外给画布与浮层加背景模糊。 */
  material: GlassMaterial
  /** 面板与浮层的底不透明度（0.4–1）；越接近 1 越实。 */
  panelOpacity: number
}

/** 一套令牌表（主题包里按 `--dsw-*` 变量名存放的 CSS 值）。 */
export type ThemePackTokens = Record<string, string>

/**
 * 导入的主题包：自带 id、名称、明暗归属与令牌，注册后就是一张普通主题卡片。
 * 主题包不执行代码，只提供令牌值。
 */
export interface ImportedThemePack {
  /** 主题 id（导入时由名称生成，保证与内置主题不冲突）。 */
  id: string
  /** 中文名。 */
  name: string
  /** 英文名。 */
  englishName: string
  /** 明暗归属。 */
  scheme: 'light' | 'dark' | 'auto'
  /** 单套色令牌。 */
  tokens?: ThemePackTokens
  /** 跟随明暗的两套令牌。 */
  palettes?: { light: ThemePackTokens; dark: ThemePackTokens }
  /** 主题自带的强调色（导出时的强调色；空串表示跟随主题）。 */
  accent?: string
}

/** 主题外观分节。 */
export interface ThemeSettings {
  /** 所选主题：内置偏好或内置预设 id。 */
  preference: ThemeSelection
  /** 强调色；空串表示跟随主题自身。 */
  accent: string
  /** 壁纸。 */
  wallpaper: WallpaperSettings
  /** 玻璃材质与面板不透明度。 */
  glass: GlassSettings
  /** 收藏的主题 id。 */
  favorites: string[]
  /** 导入的主题包。 */
  packs: ImportedThemePack[]
}

/** 默认壁纸：跟随主题自带的弥散光。 */
export const DEFAULT_WALLPAPER: WallpaperSettings = Object.freeze({
  mode: 'theme',
  gradient: 'mist',
  url: '',
  opacity: 0.55,
  blur: 0,
  fit: 'cover',
})

/** 默认玻璃：标准材质、面板不透明。 */
export const DEFAULT_GLASS: GlassSettings = Object.freeze({ material: 'standard', panelOpacity: 1 })

/** 一张图片壁纸的体积上限（data URL 字符数，约 2 MB）。 */
export const MAX_WALLPAPER_DATA_URL = 2_000_000

/** 分节 schema：宿主注册与浏览器校验共用同一份。 */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.string().default(DEFAULT_PREFERENCE),
  accent: z.string().default(''),
  wallpaper: z.object({
    mode: z.union([...WALLPAPER_MODES]).default(DEFAULT_WALLPAPER.mode),
    gradient: z.string().default(DEFAULT_WALLPAPER.gradient),
    url: z.string().default(DEFAULT_WALLPAPER.url),
    opacity: z.number().default(DEFAULT_WALLPAPER.opacity),
    blur: z.number().default(DEFAULT_WALLPAPER.blur),
    fit: z.union([...WALLPAPER_FITS]).default(DEFAULT_WALLPAPER.fit),
  }).default(DEFAULT_WALLPAPER),
  glass: z.object({
    material: z.union([...GLASS_MATERIALS]).default(DEFAULT_GLASS.material),
    panelOpacity: z.number().default(DEFAULT_GLASS.panelOpacity),
  }).default(DEFAULT_GLASS),
  favorites: z.array(z.string()).default([]),
  // 主题包的值本身就是任意令牌表，逐字段声明只会把导入格式钉死在这里；
  // 导入路径自己校验（见 client/theme-pack.ts），schema 只保证它是数组。
  packs: z.array(z.any()).default([]),
})

/**
 * 窄化一个跨边界值是否为内置外观偏好。
 * @param value - 设置或注册边界上的值。
 * @returns 是否为内置偏好。
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}

/**
 * 把透明度、模糊与面板不透明度夹到合法区间：设置文档可能被手工编辑，
 * 越界的滑杆值会让壁纸或浮层完全不可读。
 * @param settings - 已解码的分节。
 * @returns 归一化后的副本。
 */
export function normalizeThemeSettings(settings: ThemeSettings): ThemeSettings {
  const clamp = (value: number, min: number, max: number): number =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min
  return {
    preference: settings.preference,
    accent: settings.accent,
    wallpaper: {
      ...settings.wallpaper,
      opacity: clamp(settings.wallpaper.opacity, 0, 1),
      blur: clamp(settings.wallpaper.blur, 0, 40),
    },
    glass: { ...settings.glass, panelOpacity: clamp(settings.glass.panelOpacity, 0.4, 1) },
    favorites: [...settings.favorites],
    packs: [...settings.packs],
  }
}
