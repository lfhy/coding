// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from 'coding-client-ui-slots'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { stubSettingsScope } from 'coding-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { ImageSettings } from '../src/client/settings.ts'

describe('图像插件注册生命周期', () => {
  it('贡献设置、两个入口、画廊和右侧标签，卸载时一起移除', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.hero.actions': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.view': { kind: 'list', scope: 'session' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    const scope = stubSettingsScope<ImageSettings>()
    scope.publish({ status: 'ready', writable: true, revision: 1,
      value: { enabled: false, endpoint: '', model: '', apiKeyRef: '' }, base: {}, user: {} })
    ctx.provide('settingsScope', { bind: () => scope.scope } as never)
    const current = { current: 'image-session' as string | undefined,
      byId: { 'image-session': { id: 'image-session', agentPreset: 'image', blank: true } } }
    const listeners = new Set<() => void>()
    ctx.provide('sessions', { list: { getSnapshot: () => current, subscribe: (listener: () => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } } } as never)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ items: [] }) } } as never)
    ctx.provide('conversation', { selectView: vi.fn() } as never)
    ctx.provide('connection', { api: { credentials: { describe: vi.fn(async () => ({ result: {
      ok: true, value: { credentials: {} },
    } })) } } } as never)
    const register = vi.fn(() => vi.fn())
    const openTabForSession = vi.fn()
    ctx.provide('sidebarRight', { openTabForSession } as never)
    ctx.provide('sidebarRightTabs', { register } as never)

    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')[0]?.options.id).toBe('image-generation')
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe('图像生成')
    expect(slots.entries('conversation.hero.actions')[0]?.options.id).toBe('image-generation')
    expect(slots.entries('conversation.session.header.utilities')[0]?.options.id).toBe('image-generation')
    expect(slots.entries('conversation.view')[0]?.options.id).toBe('image-gallery')
    expect(slots.entries('sidebar.right.pane.tab')[0]?.options.key).toBe('image-canvas')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-canvas', kind: 'image-canvas' }))
    expect(openTabForSession).not.toHaveBeenCalled()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    window.dispatchEvent(new Event('resize'))
    expect(openTabForSession).toHaveBeenCalledWith('image-session', 'image-canvas')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    window.dispatchEvent(new Event('resize'))
    expect(openTabForSession).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    for (const seat of ['settings.section', 'conversation.hero.actions', 'conversation.session.header.utilities',
      'conversation.view', 'sidebar.right.pane.tab'] as const) expect(slots.entries(seat)).toHaveLength(0)
    expect(listeners).toHaveProperty('size', 0)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
  })
})
