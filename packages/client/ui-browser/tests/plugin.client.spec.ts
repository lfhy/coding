import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { BrowserMirror, BrowserTabs, type BrowserMirrorInjected } from '../src/client/BrowserMirror.tsx'

describe('browser twin-slot lifetime', () => {
  it('shares one session snapshot and withdraws both contributions on owner removal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('connection', { api: { browser: { control: vi.fn() } } } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const owner = ctx.slots.register({ name: 'root', children: {
      'workbench.browser': { kind: 'single', scope: 'session' },
      'workbench.browser.tabs': { kind: 'single', scope: 'session' },
    } } as never, () => null)
    const content = ctx.slots.entries('workbench.browser')[0]!
    const tabs = ctx.slots.entries('workbench.browser.tabs')[0]!
    expect(content.component).toBe(BrowserMirror)
    expect(tabs.component).toBe(BrowserTabs)
    const contentFace = content.inject as unknown as (id: string) => BrowserMirrorInjected
    const tabsFace = tabs.inject as unknown as (id: string) => BrowserMirrorInjected
    expect(contentFace('session-1').hooks.browserMirror).toBe(tabsFace('session-1').hooks.browserMirror)
    expect(contentFace('session-2').hooks.browserMirror).not.toBe(contentFace('session-1').hooks.browserMirror)
    const stop = contentFace('session-1').start(vi.fn())
    stop()
    owner()
    expect(ctx.slots.entries('workbench.browser')).toEqual([])
    expect(ctx.slots.entries('workbench.browser.tabs')).toEqual([])
    await fiber.dispose()
    vi.unstubAllGlobals()
  })
})
