import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { BrowserMirror, type BrowserMirrorInjected } from '../src/client/BrowserMirror.tsx'
import { NS } from '../src/client/locales.ts'

describe('browser mirror slot lifetime', () => {
  it('waits for the actual workbench declaration and withdraws on owner/plugin disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.snapshot('workbench.browser')).toEqual([])
    const owner = ctx.slots.register({ name: 'root', children: {
      'workbench.browser': { kind: 'single', scope: 'session' },
    } } as never, () => null)
    expect(ctx.slots.entries('workbench.browser')).toHaveLength(1)
    const entry = ctx.slots.entries('workbench.browser')[0]
    expect(entry?.component).toBe(BrowserMirror)
    expect(entry?.locale).toBe(NS)
    owner()
    expect(ctx.slots.entries('workbench.browser')).toEqual([])
    const next = ctx.slots.register({ name: 'root', children: {
      'workbench.browser': { kind: 'single', scope: 'session' },
    } } as never, () => null)
    expect(ctx.slots.entries('workbench.browser')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('workbench.browser')).toEqual([])
    next()
  })

  it('removes a stopped session controller while leaving other sessions intact', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const owner = ctx.slots.register({ name: 'root', children: {
      'workbench.browser': { kind: 'single', scope: 'session' },
    } } as never, () => null)
    const entry = ctx.slots.entries('workbench.browser')[0]!
    const face = entry.inject as unknown as (sessionId: string) => BrowserMirrorInjected
    const first = face('session-1')
    const other = face('session-2')
    expect(face('session-1').hooks.browserMirror).toBe(first.hooks.browserMirror)
    const stop = first.start(vi.fn())
    stop()
    expect(face('session-1').hooks.browserMirror).not.toBe(first.hooks.browserMirror)
    expect(face('session-2').hooks.browserMirror).toBe(other.hooks.browserMirror)
    owner()
    await fiber.dispose()
    vi.unstubAllGlobals()
  })
})
