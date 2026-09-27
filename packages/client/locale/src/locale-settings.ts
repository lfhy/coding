/** Locale preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the locale plugin. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** 显式语言选择字段；缺失时使用中文默认值。 */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Locale identifiers shipped by the browser client. */
export const LOCALE_IDS = ['zh', 'en'] as const

/** Shipped locale identifier. */
export type LocaleId = typeof LOCALE_IDS[number]

/** Durable locale section shared by the Host schema and the browser scope. */
export interface LocaleSettings {
  /** 显式语言选择；缺失时使用中文默认值。 */
  preference?: LocaleId
}

/** Durable locale schema; also the wire envelope the browser scope validates against. */
export const LocaleSettingsSchema: z<LocaleSettings> = z.object({
  [LOCALE_PREFERENCE_FIELD]: z.union([...LOCALE_IDS]).required(false),
})
