/**
 * OpenCode 调色板适配层：把上游 37 个语义色换算成本项目的设计令牌。
 *
 * 上游（dsh-opencode-palette）按 opencode 的语义槽组织配色，本项目按
 * `--dsw-alias-*` / `--dsw-specific-*` 组织界面。这里维护唯一的映射表：
 * 上游改槽名或本项目改令牌名时，只改这一个文件。
 *
 * 两条口径：
 * - 上游给 `transparent` 或缺失的槽不落令牌——让底层外观（或壁纸）透出来，
 *   而不是伪造一个近似色。
 * - 语义色的浅色/深色变体各自计算：hover、次级状态这类派生值在深色方案里向
 *   白提亮，在浅色方案里向黑压暗，跨方案复用同一个色值会读不清。
 */
import type { OpencodePaletteData, ThemePreset, ThemeTokens } from './types.ts'
import { readableOn, shade, withAlpha } from './color.ts'

/** 需要从上游语义色直接读取的槽（本项目令牌 ← 上游槽）。 */
const SLOT_TOKENS: ReadonlyArray<readonly [string, string]> = [
  // 画布与分层表面
  ['--dsw-alias-bg-base', 'background'],
  ['--dsw-alias-bg-layer-1', 'background'],
  ['--dsw-alias-bg-layer-2', 'backgroundPanel'],
  ['--dsw-alias-bg-layer-3', 'backgroundElement'],
  ['--dsw-alias-bg-overlay', 'backgroundElement'],
  ['--dsw-alias-bg-module-platform', 'backgroundPanel'],
  ['--dsw-alias-bg-multi-select', 'backgroundPanel'],
  ['--dsw-specific-sidebar-fill', 'sidebarBg'],
  ['--dsw-specific-menu', 'backgroundPanel'],
  ['--dsw-specific-selector', 'backgroundPanel'],
  ['--dsw-specific-tip', 'backgroundElement'],
  ['--dsw-specific-bubble', 'bubbleBg'],
  ['--dsw-specific-bubble-highlight', 'backgroundElement'],
  ['--dsw-specific-input-major', 'inputBg'],
  ['--dsw-specific-login-input', 'inputBg'],
  // Markdown 与代码
  ['--dsw-alias-markdown-code-block', 'codeBlockBg'],
  ['--dsw-alias-markdown-code-block-banner', 'codeHeaderBg'],
  ['--dsw-alias-markdown-placeholder', 'backgroundPanel'],
  ['--dsw-alias-markdown-tag', 'backgroundPanel'],
  ['--dsw-alias-markdown-citation', 'backgroundElement'],
  ['--dsw-alias-markdown-code-segment-selected', 'backgroundElement'],
  ['--dsw-alias-markdown-code-segment-unselected', 'background'],
  ['--dsw-alias-markdown-inline-code', 'backgroundPanel'],
  // 浮层与按钮表面
  ['--dsw-alias-toast-bg', 'backgroundElement'],
  ['--dsw-alias-tooltip-bg', 'backgroundElement'],
  ['--dsw-alias-button-elevated-fill', 'backgroundPanel'],
  ['--dsw-alias-button-floating-fill', 'backgroundPanel'],
  ['--dsw-alias-button-floating-hover', 'backgroundElement'],
  // 文字
  ['--dsw-alias-label-primary', 'text'],
  ['--dsw-alias-label-primary-dimmed', 'text'],
  ['--dsw-alias-label-secondary', 'textMuted'],
  ['--dsw-alias-label-tertiary', 'textMuted'],
  ['--dsw-alias-label-caption', 'textMuted'],
  ['--dsw-alias-label-primary-bluish', 'markdownLink'],
  // 品牌与状态
  ['--dsw-alias-brand-primary', 'primary'],
  ['--dsw-alias-button-primary-fill', 'primary'],
  ['--dsw-alias-button-info-fill', 'info'],
  ['--dsw-alias-button-contrast-fill', 'text'],
  ['--dsw-alias-state-error-primary', 'error'],
  ['--dsw-alias-state-warn-primary', 'warning'],
  ['--dsw-alias-state-warn-label', 'warning'],
  ['--dsw-alias-state-success-primary', 'success'],
  ['--dsw-alias-state-business-primary', 'primary'],
  // 边框
  ['--dsw-alias-border-l1', 'border'],
  ['--dsw-alias-border-l2', 'borderActive'],
  ['--dsw-alias-border-l2-darkmode-thin', 'borderActive'],
  ['--dsw-alias-border-l3', 'borderActive'],
  ['--dsw-alias-border-l4', 'borderActive'],
  ['--dsw-alias-button-ghost-active-border', 'borderActive'],
  ['--dsw-alias-border-inverted', 'border'],
  ['--dsw-alias-border-inverted2', 'borderActive'],
]

/** 语法高亮：本项目 shiki 变量 ← 上游语法槽。 */
const SHIKI_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--shiki-foreground', 'text'],
  ['--shiki-token-comment', 'syntaxComment'],
  ['--shiki-token-keyword', 'syntaxKeyword'],
  ['--shiki-token-function', 'syntaxFunction'],
  ['--shiki-token-parameter', 'syntaxType'],
  ['--shiki-token-constant', 'syntaxNumber'],
  ['--shiki-token-string', 'syntaxString'],
  ['--shiki-token-string-expression', 'syntaxString'],
  ['--shiki-token-punctuation', 'syntaxOperator'],
  ['--shiki-token-link', 'markdownLink'],
]

/**
 * 派生令牌：值由上游槽按规则算出来（提亮、透明、可读文字色）。
 * 计算失败（槽缺失或不可解析）时跳过该令牌。
 */
const DERIVED_TOKENS: ReadonlyArray<readonly [string, (slots: Record<string, string>, dark: boolean) => string | undefined]> = [
  ['--dsw-alias-button-primary-hover', (s, dark) => shade(s.primary, 0.12, dark)],
  ['--dsw-alias-button-info-hover', (s, dark) => shade(s.info, 0.12, dark)],
  ['--dsw-alias-button-primary-dimmed', s => withAlpha(s.primary, 0.2)],
  ['--dsw-alias-brand-text', s => readableOn(s.primary)],
  ['--dsw-alias-brand-primary-invert', s => readableOn(s.primary)],
  ['--dsw-alias-label-primary-foreground', s => readableOn(s.primary)],
  ['--dsw-alias-label-primary-inverted', s => readableOn(s.text)],
  ['--dsw-alias-label-dimmed', s => withAlpha(s.textMuted, 0.8)],
  ['--dsw-alias-bg-skeleton', s => withAlpha(s.text, 0.08)],
  ['--dsw-alias-button-ghost-active-fill', s => withAlpha(s.text, 0.1)],
  ['--dsw-alias-button-ghost-active-hover', s => s.backgroundElement],
  ['--dsw-alias-button-tool-bar-fill', s => withAlpha(s.text, 0.1)],
  ['--dsw-alias-button-tool-bar-hover', s => withAlpha(s.text, 0.16)],
  ['--dsw-alias-button-tool-bar-fill-invisible', s => withAlpha(s.text, 0.04)],
  ['--dsw-alias-interactive-bg-hover', s => withAlpha(s.text, 0.08)],
  ['--dsw-alias-interactive-bg-active', s => withAlpha(s.text, 0.14)],
  ['--dsw-alias-interactive-bg-hover-accent', s => withAlpha(s.primary, 0.2)],
  ['--dsw-alias-interactive-bg-hover-danger', s => withAlpha(s.error, 0.15)],
  ['--dsw-alias-interactive-bg-hover-solid', s => s.backgroundElement],
  ['--dsw-alias-scrollbar-bg-l1', s => withAlpha(s.text, 0.08)],
  ['--dsw-alias-scrollbar-bg-l2', s => withAlpha(s.text, 0.08)],
  ['--dsw-alias-scrollbar-hover-l1', s => s.borderActive],
  ['--dsw-alias-scrollbar-hover-l2', s => s.borderActive],
  ['--dsw-specific-sidebar-nav-item-hover', s => withAlpha(s.text, 0.08)],
  ['--dsw-specific-sidebar-nav-item-active', s => withAlpha(s.text, 0.14)],
  ['--dsw-specific-sidebar-nav-item-active-accent', s => withAlpha(s.primary, 0.35)],
  ['--dsw-alias-state-error-secondary', (s, dark) => shade(s.error, 0.22, dark)],
  ['--dsw-alias-state-success-secondary', (s, dark) => shade(s.success, 0.22, dark)],
  ['--dsw-alias-state-warn-secondary', (s, dark) => shade(s.warning, 0.22, dark)],
  ['--dsw-alias-state-success-tertiary', s => withAlpha(s.success, 0.14)],
  ['--dsw-alias-state-warn-tertiary', s => withAlpha(s.warning, 0.14)],
  ['--dsw-alias-state-business-tertiary', s => withAlpha(s.primary, 0.12)],
]

/** 上游把画布委托给宿主时背景是透明的，这里按不可判定处理。 */
function usable(value: string | undefined): string | undefined {
  return value === undefined || value === 'transparent' || value === 'none' || value.trim() === ''
    ? undefined
    : value
}

/**
 * 把一套上游语义色换算成令牌表。
 * @param slots - 上游语义槽（37 色的一份变体）。
 * @param dark - 是否为深色方案，决定派生值的提亮/压暗方向。
 * @returns 令牌表；缺失或透明的槽不产生条目。
 */
export function mapOpencodeTokens(slots: Record<string, string>, dark: boolean): ThemeTokens {
  const tokens: ThemeTokens = {}
  for (const [token, slot] of [...SLOT_TOKENS, ...SHIKI_TOKENS]) {
    const value = usable(slots[slot])
    if (value !== undefined) tokens[token] = value
  }
  for (const [token, derive] of DERIVED_TOKENS) {
    const value = derive(slots, dark)
    if (value !== undefined) tokens[token] = value
  }
  return tokens
}

/**
 * 上游浅色变体是否真的是浅色：背景透明或仍然偏暗的配色只注册深色一套。
 * @param lightBackground - 上游浅色变体的 `background`。
 * @returns 浅色变体可用时为 true。
 */
export function hasLightPalette(lightBackground: string | undefined): boolean {
  return usable(lightBackground) !== undefined && readableOn(lightBackground) === '#141414'
}

/**
 * 主题自带的弥散光背景：取强调色做两束光，和上游「一束主光 + 环境抬升」的写法一致。
 * @param primary - 上游强调色。
 * @param dark - 深色方案用更强的透明度和更大的范围。
 * @returns CSS `background` 值；强调色不可解析时返回 undefined。
 */
function glow(primary: string | undefined, dark: boolean): string | undefined {
  const key = withAlpha(primary ?? '', dark ? 0.26 : 0.16)
  if (key === undefined) return undefined
  return `radial-gradient(1100px 640px at 78% -12%, ${key}, transparent 62%),`
    + ` radial-gradient(760px 520px at 6% 108%, ${key}, transparent 58%)`
}

/**
 * 主题自带的两侧弥散光；某一侧强调色不可解析时整侧省略。
 * @param data - 上游 37 色数据。
 * @param auto - 是否跟随明暗（浅色方案也参与）。
 * @returns 只含可用侧的背景表。
 */
function backdropOf(data: OpencodePaletteData, auto: boolean): { light?: string; dark?: string } {
  const backdrop: { light?: string; dark?: string } = {}
  if (auto) {
    const light = glow(data.palettes.light.primary, false)
    if (light !== undefined) backdrop.light = light
  }
  const dark = glow(data.palettes.dark.primary, true)
  if (dark !== undefined) backdrop.dark = dark
  return backdrop
}

/**
 * 把一条上游配色整理成目录条目。
 * @param data - 上游 37 色数据。
 * @returns 目录条目；浅色变体不可用时收敛为深色单套色主题。
 */
export function opencodePreset(data: OpencodePaletteData): ThemePreset {
  const auto = hasLightPalette(data.palettes.light.background)
  const darkTokens = mapOpencodeTokens(data.palettes.dark, true)
  const lightTokens = mapOpencodeTokens(data.palettes.light, false)
  const palettes = auto ? { light: lightTokens, dark: darkTokens } : { dark: darkTokens }
  // 卡片预览取深色一侧：本产品的默认观感是深色，浅色方案只影响跟随明暗时的第二面。
  const base = data.palettes.dark
  return {
    id: `oc-${data.id}`,
    source: 'opencode',
    name: data.name,
    englishName: data.englishName,
    scheme: auto ? 'auto' : 'dark',
    palettes,
    backdrop: backdropOf(data, auto),
    preview: {
      background: usable(base.background) ?? (auto ? '#ffffff' : '#101014'),
      text: usable(base.text) ?? (auto ? '#1a1a1a' : '#f4f4f5'),
      accent: usable(base.primary) ?? '#5a6cff',
    },
  }
}
