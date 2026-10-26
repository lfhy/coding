/** 宿主半边：注册持久化的主题外观分节，并注入首屏主题引导脚本。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-host-webserver'
import { settingsNamespace } from 'coding-settings'
import { injectBootTheme } from './boot-theme.ts'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type ThemeSelection, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_PREFERENCE, THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSelection, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/** 读取已注册的主题选择；没有设置提供方时用 schema 默认值。 */
function readPreference(ctx: Context): ThemeSelection {
  const settings = ctx.get('settings')
  if (settings === undefined) return DEFAULT_PREFERENCE
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) return DEFAULT_PREFERENCE
  return section.preference
}

/**
 * 在可选宿主服务被组合时注册主题分节与首屏主题替换。
 * @param ctx - 可能获得 settings 与 HTTP 服务的宿主上下文。
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex(html => injectBootTheme(html, readPreference(ctx))),
      'client-ui-theme: initial theme bootstrap',
    )
  })
}
