/**
 * 权限预设插件的浏览器端：在 host `/permission` 命令上挂一项 popupSelect 装饰，
 * 用扁平本地化列表标记当前值并执行切换。装饰只接管无参数调用；host 命令继续拥有
 * 目录行、带参路径（`/permission <preset>` 仍可直接切换）与生命周期日志。选项和
 * active 标记读取会话 `permissions` 投影，与输入区 chip 共用 host 计算结果；选择后
 * 提交 `/permission <preset>`，两处界面因此共享写入路径和推送确认。完全访问行与
 * 输入区 chip 使用同一风险门控，弹层机制归共享 popup 外壳。General 设置行另行通过
 * host Settings API 写入后续会话的默认预设。
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// 仅类型：把 locale 插件的 Context 合并（ctx.locale）带入当前程序。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：设置 slot 类型，本包会注册一个 General 行。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：带入 ctx.remote 合并和转发事件键接口，设置失效通知经其 allowlist 传递。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/client'
import { PermissionRow } from './PermissionRow.tsx'
import type { PermissionRowInjected } from './PermissionRow.tsx'
import {
  accessEn, accessZh, en, zh,
} from './locales.ts'
import {
  displayPermissionPreset, FULL_ACCESS_PRESET,
} from './presentation.ts'
import { PermissionPresetSettingsController } from './settings-store.ts'

export type { PermissionRowInjected, PermissionRowProps } from './PermissionRow.tsx'
export type {
  PermissionDefaultOption, PermissionSettingsState,
} from './settings-store.ts'

/** 必需服务（Cordis fiber inject）。 */
export const inject = ['commandUi', 'sessions', 'slots', 'locale', 'connection', 'remote', 'settingsScope', 'settingsSchema']

const ACCESS_NS = 'permission.access'

/** 读取会话当前权限投影；undefined 表示组合中没有该能力。 */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/** 把投影选择值展平为 popup 行；`custom` 只表示展示状态，绝不是切换目标。 */
function optionsOf(value: PermissionSelect, t: (key: string) => string): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: displayPermissionPreset(option.value, option.name, t),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === value.currentValue ? { active: true } : {}),
      ...(option.value === FULL_ACCESS_PRESET
        ? {
          confirmation: {
            title: t('confirm.title'),
            description: t('confirm.description'),
            acknowledgeLabel: t('confirm.acknowledge'),
            closeLabel: t('confirm.close'),
            cancelLabel: t('confirm.cancel'),
            confirmLabel: t('confirm.enable'),
          },
        }
        : {}),
    }))
}

/**
 * 注册基于 permissions 投影的 `/permission` popup 选择器。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.sessions
  // 本可选 bundle 与 ui-conversation 可独立加载，因此各自在自己的 locale 命名空间
  // 持有同一份安全文案。
  /* jscpd:ignore-start */
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(ACCESS_NS, 'zh', {
        'preset.readOnly': accessZh['preset.readOnly'],
        'preset.workspaceWrite': accessZh['preset.workspaceWrite'],
        'preset.fullAccess': accessZh['preset.fullAccess'],
        'preset.custom': accessZh['preset.custom'],
        'confirm.title': accessZh['confirm.title'],
        'confirm.description': accessZh['confirm.description'],
        'confirm.acknowledge': accessZh['confirm.acknowledge'],
        'confirm.close': accessZh['confirm.close'],
        'confirm.cancel': accessZh['confirm.cancel'],
        'confirm.enable': accessZh['confirm.enable'],
      }),
      ctx.locale.register(ACCESS_NS, 'en', {
        'preset.readOnly': accessEn['preset.readOnly'],
        'preset.workspaceWrite': accessEn['preset.workspaceWrite'],
        'preset.fullAccess': accessEn['preset.fullAccess'],
        'preset.custom': accessEn['preset.custom'],
        'confirm.title': accessEn['confirm.title'],
        'confirm.description': accessEn['confirm.description'],
        'confirm.acknowledge': accessEn['confirm.acknowledge'],
        'confirm.close': accessEn['confirm.close'],
        'confirm.cancel': accessEn['confirm.cancel'],
        'confirm.enable': accessEn['confirm.enable'],
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-permission: Full access confirmation dictionaries')
  /* jscpd:ignore-end */
  const t = ctx.locale.bind(ACCESS_NS)
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session

  ctx.effect(() => ctx.locale.register('settings.permission', { zh, en }), 'ui-permission: settings row dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // 此行跟随共享 describe 镜像；其归属插件已负责在文档提交与重连时刷新。
  const controller = new PermissionPresetSettingsController(
    ctx.settingsScope.describe(), connection.api, ctx.settingsSchema)
  const load = (): Promise<void> => controller.load()
  const select = (preset: string): Promise<void> => controller.select(preset)
  const injected = (): PermissionRowInjected => ({
    hooks: { permission: controller.store },
    load,
    select,
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-permission: settings row directory')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'permission',
    order: -20,
    locale: 'settings.permission',
    inject: injected,
  }, PermissionRow))

  ctx.effect(() => command.decorate({
    name: 'permission',
    // 选择器与投影严格同生命周期；无权限能力的 host 不提供该键，裸调用会落回同样
    // 缺席的 host 命令，因此整行不会命中。
    available: session => selectOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: (session) => {
        const value = selectOf(sessionFor(session))
        if (value === undefined) throw new Error('permission presets are not available on this host')
        return Promise.resolve(optionsOf(value, t))
      },
      onSelect: async (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permission ${option.id}`)
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permission command')
      },
    },
  }), 'ui-permission: /permission decoration')
}
