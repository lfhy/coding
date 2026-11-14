/**
 * 设置领域底座的浏览器入口：提供 ctx.settingsScope，并持有唯一的 settings.describe 镜像。
 * settings/document-updated 与 connection/reset 在此统一使镜像失效，
 * 让各派生界面共享一次线路读取。本包不依赖 ui-* 呈现包，供各功能绑定自己的持久分区。
 * 占用 shell.settings 的设置页面与导航留在 ui-settings-general，避免底座经布局和主题闭环。
 * 导出约束见 packages/client/AGENTS.md。
 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
// 仅类型导入：合并 $on 及事件键，不将 Client 构建产物带入 Host 引用图。
import type {} from 'coding-api-remotes/types'
import type {} from 'coding-settings/types'
import { SettingsSchemaService } from './schema.ts'
import { SettingsScopeBinder } from './settings-scope.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'
export type { SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot } from './settings-mirror.ts'

/**
 * Required services: the wire handle for the mirror's reads and the forwarded
 * settings invalidation the mirror refreshes on.
 */
export const inject = ['connection', 'remote']

/**
 * Provide the settings-namespace scope service over one shared describe
 * mirror, and keep that mirror fresh on the two signals that can move the
 * settings document: a document commit and a (re)connect.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const schema = new SettingsSchemaService(ctx)
  const connection = ctx.get('connection') as ConnectionHandle
  const mirror = new SettingsDescribeMirror(
    connection.api,
    connection.isLoopback ? 'host' : 'memory',
  )
  ctx.effect(() => {
    const disposers = [
      (ctx.get('remote') as ClientContext['remote']).$on('settings/document-updated', () => { void mirror.load() }),
      ctx.on('connection/reset', () => { void mirror.load() }),
    ]
    // 首次连接刷新与急切读取最多产生两次请求；发送前的刷新合并到本次读取，
    // 在途或完成后的刷新触发补读，确保连接建立期间的文档变更不会丢失。
    void mirror.ensure()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings: describe mirror invalidations')
  new SettingsScopeBinder(ctx, { mirror, schema })
}
