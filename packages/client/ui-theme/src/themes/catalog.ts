/**
 * 内置主题目录：把三个上游来源的数据整理成可注册的主题列表，并提供分组、
 * 预览色和查找。
 *
 * 目录在模块加载时构建一次，之后只读。数据有问题（`auto` 却只给一套令牌、
 * id 重复）在构建时抛错——这是我们自己的数据，静默降级只会让页面上少一个
 * 主题而无从排查。
 */
import { DREAM_SKIN_PRESETS } from './data/dream-skin.ts'
import { JOI_PRESETS } from './data/joi.ts'
import { OPENCODE_PRESET_GROUP_A } from './data/opencode-1.ts'
import { OPENCODE_PRESET_GROUP_B } from './data/opencode-2.ts'
import { OPENCODE_PRESET_GROUP_C } from './data/opencode-3.ts'
import { OPENCODE_PRESET_GROUP_D } from './data/opencode-4.ts'
import { OPENCODE_PRESET_GROUP_E } from './data/opencode-5.ts'
import { OPENCODE_PRESET_GROUP_F } from './data/opencode-6.ts'
import { OPENCODE_PRESET_GROUP_G } from './data/opencode-7.ts'
import { opencodePreset } from './opencode.ts'
import { hueOf } from './color.ts'
import type {
  OpencodePaletteData, ThemePreset, ThemePresetData, ThemeScheme, ThemeSourceId, ThemeTokens,
} from './types.ts'

export type { ThemePreset, ThemeSourceId, ThemeTokens } from './types.ts'

/** 三个内置主题来源的展示名与说明。 */
export interface ThemeSourceDescriptor {
  /** 来源 id。 */
  id: ThemeSourceId
  /** 中文名。 */
  name: string
  /** 英文名。 */
  englishName: string
  /** 一句话来源说明（页面上作为分区副标题）。 */
  attribution: string
}

/** 页面上的来源分区顺序。 */
export const THEME_SOURCES: readonly ThemeSourceDescriptor[] = [
  { id: 'builtin', name: '内置配色', englishName: 'Built-in', attribution: '产品自带的外观' },
  { id: 'dream-skin', name: '幻梦', englishName: 'Mirage', attribution: '移植自 dsh-dream-skin' },
  { id: 'joi', name: '轴伊', englishName: 'Joi', attribution: '移植自 dsh-joi-channel-theme' },
  { id: 'opencode', name: 'OpenCode 调色板', englishName: 'OpenCode', attribution: '移植自 dsh-opencode-palette' },
  { id: 'imported', name: '导入的主题', englishName: 'Imported', attribution: '从主题包导入' },
]

/** 色系分组：按主色色相分区，和上游的分组口径一致。 */
export type ThemeGroupId = 'warm' | 'yellow-green' | 'teal' | 'cyan-blue' | 'cool-blue' | 'violet' | 'neutral'

/** 分组顺序、代表色与两种语言的组名。 */
export const THEME_GROUPS: readonly {
  id: ThemeGroupId
  color: string
  name: string
  englishName: string
}[] = [
  { id: 'warm', color: '#fab283', name: '暖色', englishName: 'Warm' },
  { id: 'yellow-green', color: '#a7c080', name: '黄绿', englishName: 'Yellow-green' },
  { id: 'teal', color: '#2dd5b7', name: '青绿', englishName: 'Teal' },
  { id: 'cyan-blue', color: '#88c0d0', name: '青蓝', englishName: 'Cyan-blue' },
  { id: 'cool-blue', color: '#82aaff', name: '冷蓝', englishName: 'Cool blue' },
  { id: 'violet', color: '#c4a7e7', name: '蓝紫', englishName: 'Violet' },
  { id: 'neutral', color: '#9e9e9e', name: '中性', englishName: 'Neutral' },
]

/** 内置的三项外观选择：它们是主题运行时的内置偏好，不注册成预设。 */
export interface BaseThemeChoice {
  /** `setTheme` 接受的偏好值。 */
  id: 'system' | 'light' | 'dark'
  name: string
  englishName: string
  scheme: 'auto' | 'light' | 'dark'
  preview: { background: string; text: string; accent: string }
}

/** 跟随系统 / 浅色 / 深色三张卡片。 */
export const BASE_THEME_CHOICES: readonly BaseThemeChoice[] = [
  {
    id: 'system',
    name: '跟随系统',
    englishName: 'System',
    scheme: 'auto',
    preview: { background: 'linear-gradient(120deg, #f6f7f9 0 50%, #15171b 50% 100%)', text: '#15171b', accent: '#5a6cff' },
  },
  {
    id: 'light',
    name: '浅色',
    englishName: 'Light',
    scheme: 'light',
    preview: { background: '#ffffff', text: '#15171b', accent: '#5a6cff' },
  },
  {
    id: 'dark',
    name: '深色',
    englishName: 'Dark',
    scheme: 'dark',
    preview: { background: '#15171b', text: '#f5f6f8', accent: '#5a6cff' },
  },
]

/** 一条预设数据转成目录条目时的兜底预览色。 */
const FALLBACK_PREVIEW = { background: '#1b1d21', text: '#f4f4f5', accent: '#5a6cff' }

/** 单套色数据按 scheme 收敛成 palettes；跟随明暗的数据必须两套齐全。 */
function resolvePalettes(data: ThemePresetData): { light?: ThemeTokens; dark?: ThemeTokens; scheme: ThemeScheme } {
  if (data.scheme !== 'auto') {
    if (data.scheme === 'light') {
      return data.tokens === undefined ? { scheme: 'light' } : { light: data.tokens, scheme: 'light' }
    }
    return data.tokens === undefined ? { scheme: 'dark' } : { dark: data.tokens, scheme: 'dark' }
  }
  const light = data.palettes?.light
  const dark = data.palettes?.dark
  if (light !== undefined && dark !== undefined) return { light, dark, scheme: 'auto' }
  // 只给一套令牌时按那一套的明暗收敛，避免注册一个 tokens 为空的主题。
  if (dark !== undefined) return { dark, scheme: 'dark' }
  if (light !== undefined) return { light, scheme: 'light' }
  throw new Error(`theme preset "${data.id}" declares scheme "auto" without palettes`)
}

/** 从一套令牌里挑预览色；缺哪项回落到兜底值。 */
function previewFrom(tokens: ThemeTokens | undefined): ThemePreset['preview'] {
  return {
    background: tokens?.['--dsw-alias-bg-base'] ?? FALLBACK_PREVIEW.background,
    text: tokens?.['--dsw-alias-label-primary'] ?? FALLBACK_PREVIEW.text,
    accent: tokens?.['--dsw-alias-brand-primary'] ?? FALLBACK_PREVIEW.accent,
  }
}

/** 一条上游数据整理成目录条目。 */
function buildPreset(data: ThemePresetData, source: ThemeSourceId): ThemePreset {
  const { light, dark, scheme } = resolvePalettes(data)
  const backdrop = typeof data.backdrop === 'string'
    ? { light: data.backdrop, dark: data.backdrop }
    : (data.backdrop ?? {})
  const previewTokens = dark ?? light
  return {
    id: data.id,
    source,
    name: data.name,
    englishName: data.englishName,
    scheme,
    palettes: { ...(light === undefined ? {} : { light }), ...(dark === undefined ? {} : { dark }) },
    backdrop,
    preview: previewFrom(previewTokens),
  }
}

/** 全部可注册的内置预设（不含内置三项外观选择）。 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  ...DREAM_SKIN_PRESETS.map(data => buildPreset(data, 'dream-skin')),
  ...JOI_PRESETS.map(data => buildPreset(data, 'joi')),
  ...([
    ...OPENCODE_PRESET_GROUP_A,
    ...OPENCODE_PRESET_GROUP_B,
    ...OPENCODE_PRESET_GROUP_C,
    ...OPENCODE_PRESET_GROUP_D,
    ...OPENCODE_PRESET_GROUP_E,
    ...OPENCODE_PRESET_GROUP_F,
    ...OPENCODE_PRESET_GROUP_G,
  ] satisfies readonly OpencodePaletteData[]).map(opencodePreset),
]

/** 按 id 建索引：注册、恢复持久偏好和预览都走这里。 */
const PRESET_BY_ID = new Map(THEME_PRESETS.map(preset => [preset.id, preset]))

{
  if (PRESET_BY_ID.size !== THEME_PRESETS.length) {
    throw new Error('theme catalog contains duplicate preset ids')
  }
}

/**
 * 按 id 查找内置预设。
 * @param id - 主题 id。
 * @returns 命中的预设；内置三项外观选择与未知 id 返回 undefined。
 */
export function findThemePreset(id: string): ThemePreset | undefined {
  return PRESET_BY_ID.get(id)
}

/**
 * 取一套预设的背景层。
 * @param preset - 目录条目。
 * @param scheme - 当前生效的明暗方案。
 * @returns CSS `background` 值；该方案没有自带背景时返回 undefined。
 */
export function presetBackdrop(preset: ThemePreset | undefined, scheme: 'light' | 'dark'): string | undefined {
  return preset?.backdrop[scheme]
}

/**
 * 按主色色相分组。
 * @param preset - 目录条目。
 * @returns 分组 id；中性主色落在 neutral。
 */
export function themeGroupOf(preset: ThemePreset): ThemeGroupId {
  const hue = hueOf(preset.preview.accent)
  if (hue === -2 || hue === -1) return 'neutral'
  if (hue < 35) return 'warm'
  if (hue < 90) return 'yellow-green'
  if (hue < 160) return 'teal'
  if (hue < 200) return 'cyan-blue'
  if (hue < 230) return 'cool-blue'
  return 'violet'
}
