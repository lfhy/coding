/**
 * 设置外壳浏览器插件：持有页面、分区导航、引导协调、通用文案与本地维护操作。
 * 各功能自己的设置行和分区仍由其所属插件注册。
 * 导出约束见 packages/client/AGENTS.md。
 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import { resolveSlotLabel } from 'coding-client-ui-slots'
// 仅类型导入：引入设置 slot 和 ctx.settingsScope；跨插件协作经服务而非值导入。
import type {} from 'coding-client-ui-settings/client'
// 仅类型导入：合并 ctx.locale 声明。
import type {} from 'coding-client-locale/client'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { SettingsDocumentAction } from './SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from './SettingsDocumentAction.tsx'
import { SettingsDocumentStore } from './settings-document-store.ts'
import { SessionMetadataRepair } from './SessionMetadataRepair.tsx'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps,
} from './GeneralSection.tsx'
export type { SettingsDocumentActionInjected, SettingsDocumentActionProps } from './SettingsDocumentAction.tsx'
export type { SettingsDocumentState } from './settings-document-store.ts'
export { SettingsDocumentStore } from './settings-document-store.ts'
export type { SettingsKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 设置外壳控件与通用分区文案。 */
    settings: SettingsKey
  }
}

/** 本插件持有的设置外壳与通用分区字典命名空间。 */
const NS = 'settings'

/**
 * 插件所需服务。布局和设置子 slot 的声明顺序不受服务依赖约束，
 * 注册项通过 slots.inject() 等待所属声明并跟随其生命周期。
 */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * 注册设置字典、页面和通用分区；特权维护操作仅在回环连接下注册。
 * @param ctx - 客户端根上下文。
 * @returns 无返回值；注册项随插件生命周期释放。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')

  // 文案由框架更新：组件读取标准 t，导航标签在渲染时求值，不按语言切换重新注册。
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  // The action follows the shared describe mirror, whose owning plugin
  // already refreshes it on document commits and reconnects.
  const documentController = connection.isLoopback
    ? new SettingsDocumentStore(connection.api, ctx.settingsScope.describe())
    : undefined
  const documentInjected = documentController === undefined
    ? undefined
    : (): SettingsDocumentActionInjected => ({
      controller: documentController,
      hooks: { snapshot: documentController.store },
    })
  ctx.effect(() => () => { documentController?.dispose() }, 'ui-settings-general: document action directory')
  // 设置外壳占用窗口导航座位，并声明设置子 slot。账本投影保持稳定快照；
  // 标签可能跟随语言延迟求值，因此缓存与订阅同时覆盖账本版本和语言修订。
  let rowsVersion = -1
  let rowsRevision = -1
  let rows: readonly SettingsSectionRow[] = []
  let onboardingVersion = -1
  let onboardingSteps: readonly SettingsOnboardingStep[] = []
  const shellInjected = (): SettingsRootInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: resolveSlotLabel(e.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entries('settings.onboarding')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
              }))
              .sort((a, b) => a.order - b.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('shell.settings', () => ctx.slots.register({
    name: 'shell.settings',
    locale: NS,
    children: {
      'settings.trigger': { kind: 'single', scope: 'root' },
      'settings.header': { kind: 'single', scope: 'root' },
      'settings.action': { kind: 'list', scope: 'root' },
      'settings.close': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: shellInjected,
  }, SettingsRoot))

  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
  ctx.slots.inject('settings.header', () =>
    ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
  if (documentInjected !== undefined) {
    ctx.slots.inject('settings.action', () => ctx.slots.register({
      name: 'settings.action',
      id: 'open-document',
      order: 0,
      locale: NS,
      inject: documentInjected,
    }, SettingsDocumentAction))
  }
  ctx.slots.inject('settings.close', () =>
    ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
  if (connection.isLoopback) {
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'session-metadata',
      order: 100,
      locale: NS,
      inject: () => ({
        rebuildMetadata: async (signal: AbortSignal) => {
          const response = await connection.api.sessions.rebuildMetadata({}, signal)
          if (!response.result.ok) throw new Error(response.result.error.message)
          return response.result.value
        },
      }),
    }, SessionMetadataRepair))
  }
}
