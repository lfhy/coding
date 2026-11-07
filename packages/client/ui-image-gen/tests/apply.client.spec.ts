// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from 'coding-client-ui-slots'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { stubSettingsScope, TestRemote } from 'coding-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { imageServiceReady, type ImageSettings, type ImageSettingsView } from '../src/client/settings.ts'

describe('图像插件注册生命周期', () => {
  it('贡献设置、侧边栏入口与主内容画廊工作台，卸载时一起移除', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'sidebar.top.entry': { kind: 'list', scope: 'root' },
      'conversation.hero.actions': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'shell.page': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    new TestRemote(ctx)
    const scope = stubSettingsScope<ImageSettings>()
    scope.publish({ status: 'ready', writable: true, revision: 1,
      value: { enabled: false, endpoint: '', model: '', apiKeyRef: '' }, base: {}, user: {} })
    ctx.provide('settingsScope', { bind: () => scope.scope } as never)
    const openSession = vi.fn()
    ctx.provide('sessions', { open: openSession, list: { getSnapshot: () => ({ current: 'image-session',
      byId: { 'image-session': { id: 'image-session', agentPreset: 'image', blank: true } } }) } } as never)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ items: [] }) } } as never)
    let keyConfigured = true
    const describe = vi.fn(async () => ({ result: {
      ok: true, value: { credentials: { IMAGE_GEN_API_KEY: { configured: keyConfigured, writable: true } } },
    } }))
    ctx.provide('connection', { api: { credentials: { describe } } } as never)
    const openPage = vi.fn()
    const closePage = vi.fn()
    const togglePage = vi.fn()
    ctx.provide('layout', { openPage, closePage, togglePage,
      page: { getSnapshot: () => null, subscribe: () => () => {} } } as never)

    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')[0]?.options.id).toBe('image-generation')
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe('图像生成')
    expect(slots.entries('sidebar.top.entry')[0]?.options.id).toBe('image-generation')
    expect(slots.entries('conversation.hero.actions')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.utilities')[0]?.options.id).toBe('image-generation')
    expect(slots.entries('shell.page').map(entry => entry.options.key)).toEqual(['image-gallery'])
    expect(slots.entries('tool.call.toolview').map(entry => entry.options.key))
      .toEqual(['generate_image', 'generate_images', 'edit_image', 'image_gen'])
    const imageTool = (slots.entries('tool.call.toolview')[0]!.inject as unknown as
      (sessionId: string) => { openInStudio: () => void })('tool-session')
    imageTool.openInStudio()
    expect(openSession).toHaveBeenCalledWith('tool-session')
    expect(openPage).toHaveBeenCalledWith('image-gallery', 'tool-session')
    openPage.mockClear()
    expect(openPage).not.toHaveBeenCalled()

    const entry = (slots.entries('sidebar.top.entry')[0]!.inject as unknown as () => {
      hooks: { imageEntrySettings: { getSnapshot: () => ImageSettingsView } }
    })()
    const settingsSnapshot = () => entry.hooks.imageEntrySettings.getSnapshot()
    scope.publish({ revision: 2, value: {
      enabled: true, endpoint: 'https://images.example/v1', model: 'mock', apiKeyRef: 'IMAGE_GEN_API_KEY',
    } })
    await vi.waitFor(() => { expect(imageServiceReady(settingsSnapshot())).toBe(true) })
    const beforeUnrelated = describe.mock.calls.length
    ctx.remote.$dispatch('credentials/updated', ['UNRELATED_KEY'])
    expect(describe).toHaveBeenCalledTimes(beforeUnrelated)

    keyConfigured = false
    ctx.remote.$dispatch('credentials/updated', ['IMAGE_GEN_API_KEY'])
    await vi.waitFor(() => { expect(imageServiceReady(settingsSnapshot())).toBe(false) })
    expect(settingsSnapshot().credential).toMatchObject({ status: 'ready', configured: false })
    keyConfigured = true
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(imageServiceReady(settingsSnapshot())).toBe(true) })

    await fiber.dispose()
    const beforeDisposed = describe.mock.calls.length
    ctx.remote.$dispatch('credentials/updated', ['IMAGE_GEN_API_KEY'])
    ctx.emit('connection/reset')
    expect(describe).toHaveBeenCalledTimes(beforeDisposed)
    for (const seat of ['settings.section', 'sidebar.top.entry', 'conversation.hero.actions',
      'conversation.session.header.utilities', 'shell.page', 'tool.call.toolview'] as const) {
      expect(slots.entries(seat)).toHaveLength(0)
    }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
  })
})
