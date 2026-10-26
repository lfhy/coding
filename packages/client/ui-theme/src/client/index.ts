/**
 * 主题插件浏览器半边：`--dsw-*` 令牌样式表、主题注册表、内置主题目录、
 * 外观覆盖层（强调色／壁纸／玻璃／主题包），以及该特征自己的两个设置界面。
 *
 * 服务 `ctx.theme` 把明暗已解析、覆盖层已合成的快照交给 ui-layout 的呈现器；
 * 本插件不直接写 body（唯一例外是全局样式表，随插件 fiber 一起装卸）。
 * 浏览器绑定 `ui-theme` 设置分节：内置偏好与内置预设 id 都会持久化，远程
 * 浏览器没有特权设置通道，它的选择只留在进程内。
 */
import type { ClientContext } from 'coding-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from 'coding-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from 'coding-client-locale/client'
import { AppearanceRuntime } from './appearance-runtime.ts'
import { ThemeRuntime } from './theme-runtime.ts'
import { installThemeStyles } from './styles.ts'
import { en, zh, type ThemeKey } from './locales.ts'
import {
  registerAppearanceRow, registerThemeCatalog, registerThemeGallery, SETTINGS_NS,
} from './register.ts'
import { themePackFromHash } from './theme-pack.ts'
import { THEME_SETTINGS_NAMESPACE, type ThemeSettings } from '../theme-settings.ts'

export type { AppearanceRowComponentProps, AppearanceRowInjected } from './AppearanceRow.tsx'
export type { AppearanceRowState } from './settings-store.ts'
export type { ThemeKey } from './locales.ts'
export type { ThemePreference, ThemeSelection, ThemeSettings } from '../theme-settings.ts'
export type { AppearanceSnapshot, PackImportResult } from './appearance-runtime.ts'
export type {
  ActiveTheme, ThemeColorScheme, ThemeDefinition, ThemeSchemeDeclaration, ThemeSnapshot,
  ThemeTokenInspection, ThemeTokenModes, ThemeTokenOverrides, ThemeTokens,
} from './theme-runtime.ts'
export type { ThemeGalleryComponentProps, ThemeGalleryInjected } from './ThemeGallery.tsx'
export type { ThemePreset, ThemeSourceId } from '../themes/catalog.ts'
export { ThemeRuntime } from './theme-runtime.ts'
export { AppearanceRuntime } from './appearance-runtime.ts'
export { THEME_PRESETS } from '../themes/catalog.ts'

/** 本特征设置界面共用的文案命名空间。 */
export { SETTINGS_NS }

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 外观行与主题外观页面的文案。 */
    'settings.theme': ThemeKey
  }
}

/**
 * 必需服务：设置传输，以及外观行与主题外观页面用到的 slots／locale。
 * `remote` 携带 `ctx.settingsScope.bind(spec)` 在这个上下文上订阅的设置失效通知。
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * 客户端插件体：提供主题服务，注册内置目录与外观层，并注册该特征自己的
 * 设置界面（General 分区的外观行 + 独立的「主题外观」分区）。
 * @param ctx - 客户端 cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  installThemeStyles(ctx)
  const host = ctx.settingsScope.bind<ThemeSettings>({ namespace: THEME_SETTINGS_NAMESPACE })
  const theme = new ThemeRuntime(ctx, host)
  ctx.provide('theme', theme)
  registerThemeCatalog(ctx, theme)
  const appearance = new AppearanceRuntime(ctx, host, theme)

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-theme: settings dictionaries')
  registerAppearanceRow(ctx, theme)
  registerThemeGallery(ctx, theme, appearance)
  adoptSharedPack(appearance)
}

/**
 * 打开带 `#theme-pack=` 的分享链接时导入主题包，并把 hash 清掉，避免刷新时
 * 重复导入。导入失败不打断启动：主题包只是外观，坏数据不该让页面起不来。
 * @param appearance - 外观层。
 */
function adoptSharedPack(appearance: AppearanceRuntime): void {
  if (typeof location === 'undefined') return
  const shared = themePackFromHash(location.hash)
  if (shared === undefined) return
  appearance.importPack(shared)
  const { origin, pathname, search } = location
  history.replaceState(null, '', `${origin}${pathname}${search}`)
}
