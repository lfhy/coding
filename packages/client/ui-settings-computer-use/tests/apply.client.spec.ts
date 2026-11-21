import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from 'coding-client-ui-slots'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from 'coding-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { ComputerUseSettingsFace } from '../src/client/settings.ts'

describe('电脑操作设置分区注册', () => {
  it('把分区按其身份贡献给设置导航，切换语言后跟随，卸载时撤回', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    // `remote` 必须是 Cordis 服务，嵌套命名空间才会通过 `ctx.remote.<name>` 解析。
    class RemoteService extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
      /** 本用例不关心转发事件；只满足设置底座订阅接口。 */
      $on(): () => void { return () => {} }
    }
    new RemoteService(ctx)
    ctx.provide('remote.computerUse', {
      status: async () => ({ ok: false as const, error: {} }),
      check: async () => ({ ok: false as const, error: {} }),
      openPermissionSettings: async () => ({ ok: false as const, error: {} }),
    })
    ctx.provide('connection', { isLoopback: true, api: {
      settings: { describe: vi.fn(async () => ({ rpcId: 's' as never, result: { ok: false as const, error: {} } })) },
    } } as never)
    await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const options = slots.entries('settings.section')[0]?.options
    expect(options).toMatchObject({ id: 'computer-use', order: 16 })
    expect(resolveSlotLabel(options?.label)).toBe('电脑操作')
    // 注入面按渲染器的方式取得：entry.inject 是一个返回注入面的工厂。
    const entry = slots.entries('settings.section')[0] as unknown as { inject?: () => ComputerUseSettingsFace }
    const face = entry.inject?.() as ComputerUseSettingsFace
    expect(Object.keys(face.hooks).sort()).toEqual(['computerUseAccess', 'computerUseSettings'])
    expect(typeof face.save).toBe('function')
    // 远端面可用时两个动作转发给它；这里替身返回失败，分区据此标成读取失败。
    await face.check()
    expect(await face.openPermissionSettings('accessibility')).toBe(false)
    expect(face.hooks.computerUseAccess.getSnapshot().status).toBe('error')
    locale.setLocale('en')
    expect(resolveSlotLabel(options?.label)).toBe('Computer control')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
