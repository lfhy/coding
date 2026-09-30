import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'

describe('search settings registration', () => {
  it('contributes a locale-aware standalone section and leaves on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    new TestRemote(ctx)
    const describe = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: false as const, error: {} } }))
    ctx.provide('connection', { isLoopback: true, api: {
      settings: { describe: vi.fn(async () => ({ rpcId: 's' as never, result: { ok: false as const, error: {} } })) },
      credentials: { describe },
    } } as never)
    await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')[0]?.options).toMatchObject({ id: 'search', order: 12 })
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe('联网搜索')
    locale.setLocale('en')
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe('Web search')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
