/**
 * 内置主题目录的数据形状。
 *
 * 数据文件（`data/`）只描述上游给的东西：令牌、明暗归属、自带背景。把令牌
 * 接到本项目设计令牌上、判断该主题是跟随明暗还是单套色、以及分组和预览取色，
 * 都在 `catalog.ts` 里完成，数据文件因此可以按上游原样更新。
 */

/** 主题令牌表：`--dsw-*` 变量名 → CSS 值。 */
export type ThemeTokens = Record<string, string>

/** 内置主题的来源分组：页面按来源分区展示，也用于分组筛选。 */
export type ThemeSourceId = 'builtin' | 'dream-skin' | 'joi' | 'opencode' | 'imported'

/** 主题的明暗归属；`auto` 表示跟随应用外观（浅色/深色各一套令牌）。 */
export type ThemeScheme = 'light' | 'dark' | 'auto'

/** 一条内置预设的原始数据（来自上游主题仓库）。 */
export interface ThemePresetData {
  /** 目录内唯一的预设 id（同时也是注册到主题运行时的主题 id）。 */
  id: string
  /** 中文显示名。 */
  name: string
  /** 英文显示名。 */
  englishName: string
  /** 明暗归属；`auto` 时 `palettes` 必须两套齐全。 */
  scheme: ThemeScheme
  /** 单套色预设的令牌表。 */
  tokens?: ThemeTokens
  /** 跟随明暗的预设：浅色与深色各一套令牌。 */
  palettes?: { light: ThemeTokens; dark: ThemeTokens }
  /**
   * 主题自带的背景层（壁纸默认值），CSS `background` 简写。
   * 单套色预设给一个字符串；跟随明暗的预设按方案各给一份。
   */
  backdrop?: string | { light?: string; dark?: string }
  /**
   * 缩略图键（`thumbnails.generated.ts` 里的文件名，不含扩展名）。
   * 单套色预设给一个键；跟随明暗的预设用 `thumbnails` 按方案各给一张。
   */
  thumbnail?: string
  /** 跟随明暗的预设的两张缩略图键。 */
  thumbnails?: { light?: string; dark?: string }
}

/** 一条 OpenCode 配色：37 个语义槽的明暗两套色值。 */
export interface OpencodePaletteData {
  /** 上游主题 slug（目录内会加上 `oc-` 前缀）。 */
  id: string
  /** 中文名（无译名时与英文名相同）。 */
  name: string
  /** 英文名。 */
  englishName: string
  /** 两套语义色：槽名与 `opencode.ts` 的映射表对应。 */
  palettes: { dark: Record<string, string>; light: Record<string, string> }
}

/** 目录里一条可注册的主题：令牌已按本项目设计令牌整理好。 */
export interface ThemePreset {
  /** 主题 id（`ctx.theme.setTheme` 的取值，也是持久化的偏好值）。 */
  id: string
  /** 来源分组。 */
  source: ThemeSourceId
  /** 中文显示名。 */
  name: string
  /** 英文显示名。 */
  englishName: string
  /** 解析后的明暗归属：单套色预设已收敛为 `light` / `dark`。 */
  scheme: ThemeScheme
  /** 令牌：`auto` 两套齐全，单套色只给对应一侧。 */
  palettes: { light?: ThemeTokens; dark?: ThemeTokens }
  /** 自带背景（壁纸），按方案给出。 */
  backdrop: { light?: string; dark?: string }
  /** 界面截图 data URL，按方案给出；没有缩略图的主题是空对象。 */
  thumbnails: { light?: string; dark?: string }
  /** 卡片预览色。 */
  preview: ThemePreview
}

/** 主题卡片预览用到的三种颜色。 */
export interface ThemePreview {
  /** 画布底色。 */
  background: string
  /** 正文色。 */
  text: string
  /** 强调色。 */
  accent: string
}
