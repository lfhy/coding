import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from 'coding-client-ui-slots'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { TestRemote } from 'coding-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from 'coding-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'

describe('电脑操作设置分区注册', () => {
  it('把分区按其身份贡献给设置导航，切换语言后跟随，卸载时撤回', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    new TestRemote(ctx)
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
    const entry = slots.entries('settings.section')[0] as unknown as { inject?: () => Record<string, unknown> }
    const face = entry.inject?.() as { hooks: Record<string, unknown>; save: unknown }
    expect(Object.keys(face.hooks)).toEqual(['computerUseSettings'])
    expect(typeof face.save).toBe('function')
    locale.setLocale('en')
    expect(resolveSlotLabel(options?.label)).toBe('Computer control')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
