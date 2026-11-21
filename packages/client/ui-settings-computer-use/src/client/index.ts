/** 电脑操作设置分区：把 `computer-use` 命名空间接到设置导航，写入仍是唯一保存入口。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import { ComputerUseSection } from './ComputerUseSection.tsx'
import { ComputerUseSettingsController, SETTINGS_NAMESPACE, decodeComputerUseSettings } from './settings.ts'
import { en, zh, type ComputerUseSettingsKey } from './locales.ts'

/** 分区文案命名空间。 */
const NS = 'settings.computer-use'

export type { ComputerUseSettingsFace, ComputerUseSettingsView } from './settings.ts'
export const inject = ['slots', 'locale', 'settingsScope']

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 电脑操作设置分区文案。 */
    'settings.computer-use': ComputerUseSettingsKey
  }
}

/**
 * 贡献电脑操作设置分区。
 *
 * 分区只读写 Host 的 `computer-use` 命名空间：开关关闭后由工具消费方撤销模型可见的
 * 工具与技能，因此这里不做任何本地能力判定。
 * @param ctx - 浏览器插件 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-computer-use: dictionaries')
  const controller = new ComputerUseSettingsController(
    ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE, decode: decodeComputerUseSettings }),
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-computer-use: controller')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'computer-use',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, ComputerUseSection))
}
