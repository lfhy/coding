/** 独立搜索设置分区；所有浏览器读取都来自两个 settingsScope。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SearchSettingsSection } from './SearchSettingsSection.tsx'
import { SearchSettingsController, decodeWeb, decodeDeepSeek } from './controller.ts'
import { zh, en, type SearchSettingsKey } from './locales.ts'

export type { SearchSettingsFace } from './controller.ts'
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']
const NS = 'settings.search'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 联网搜索分区文案。 */
    'settings.search': SearchSettingsKey
  }
}

/**
 * 将分区贡献给设置导航；凭据外部更新只刷新当前引用。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-search: dictionaries')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const controller = new SearchSettingsController(
    ctx.settingsScope.bind({ namespace: 'web', decode: decodeWeb }),
    ctx.settingsScope.bind({ namespace: 'web-search-deepseek', decode: decodeDeepSeek }),
    api,
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-search: controller')
  ctx.effect(
    () => ctx.remote.$on('credentials/updated', (ref) => { controller.refreshCredential(ref) }),
    'ui-settings-search: credential invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { controller.refreshAfterReset() }),
    'ui-settings-search: credential reconnect',
  )
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'search', order: 12, label: () => t('nav'), locale: NS,
    inject: () => controller.inject(),
  }, SearchSettingsSection))
}
