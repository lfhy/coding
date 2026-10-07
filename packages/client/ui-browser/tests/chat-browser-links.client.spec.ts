import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatBrowserLinks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '../src/client/index.ts'
import type { BrowserMirrorInjected } from '../src/client/BrowserMirror.tsx'

afterEach(() => { vi.unstubAllGlobals() })

async function provider() {
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
  const face = ctx.slots.entries('workbench.browser')[0]!.inject as unknown as (id: string) => BrowserMirrorInjected
  const links = ctx.get('chatBrowserLinks') as ChatBrowserLinks
  return { ctx, fiber, owner, face, links }
}

describe('Assistant browser link service', () => {
  it('runs different and repeated URLs FIFO as independent clicks without cross-Session contention', async () => {
    const b = await provider()
    const first = 'session-first' as SessionId
    const second = 'session-second' as SessionId
    let finish!: () => void
    const firstGate = new Promise<void>((resolve) => { finish = resolve })
    let epoch = 4
    const seen: string[] = []
    const begin = vi.fn((_id: string, _url: string) => {})
    const open = vi.fn(async (url: string, _pendingId: string, current: () => boolean, shouldReveal: () => boolean,
      click: { interactionEpoch: number }) => {
      expect(current()).toBe(true)
      if (seen.length === 0) await firstGate
      seen.push(`${url}:${String(click.interactionEpoch)}:${String(shouldReveal())}`)
    })
    const dispose = b.face(first).registerLinkOpener(first, open, begin, vi.fn(), () => ({ interactionEpoch: epoch }))
    const other = vi.fn(async () => {})
    b.face(second).registerLinkOpener(second, other, vi.fn(), vi.fn(), () => ({ interactionEpoch: 0 }))
    const one = b.links.open(first, 'https://one.example/')
    epoch = 5
    const same = b.links.open(first, 'https://one.example/')
    epoch = 6
    const two = b.links.open(first, 'https://two.example/')
    expect(one).not.toBe(same)
    expect(begin).toHaveBeenCalledTimes(3)
    expect(begin.mock.calls.map(([id, url]) => [id, url])).toEqual([
      ['browser-link:1', 'https://one.example/'],
      ['browser-link:2', 'https://one.example/'],
      ['browser-link:3', 'https://two.example/'],
    ])
    await b.links.open(second, 'https://other-session.example/')
    expect(other).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([one, same, two])
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(3) })
    expect(seen).toEqual([
      'https://one.example/:4:false',
      'https://one.example/:5:false',
      'https://two.example/:6:true',
    ])
    dispose()
    await expect(b.links.open(first, 'https://one.example/')).rejects.toThrow('尚未就绪')
    b.owner()
    await b.fiber.dispose()
    expect(b.ctx.get('chatBrowserLinks')).toBeUndefined()
  })

  it('never reuses a pending id when a drained queue is recreated for the same Session', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    const begin = vi.fn((_id: string, _url: string) => {})
    b.face(session).registerLinkOpener(session, async () => {}, begin, vi.fn(), () => ({ interactionEpoch: 0 }))
    await b.links.open(session, 'https://one.example/')
    await vi.waitFor(() => { expect(begin).toHaveBeenCalledTimes(1) })
    await b.links.open(session, 'https://two.example/')
    expect(begin.mock.calls.map(([id]) => id)).toEqual(['browser-link:1', 'browser-link:2'])
    b.owner()
    await b.fiber.dispose()
  })

  it('coalesces rapid retries of one failed placeholder before its Host request settles', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const begin = vi.fn((_id: string, _url: string) => {})
    const open = vi.fn(async () => gate)
    const face = b.face(session)
    face.registerLinkOpener(session, open, begin, vi.fn(), () => ({ interactionEpoch: 0 }))
    const first = face.retryLink('https://retry.example/', 'browser-link:failed')
    const duplicate = face.retryLink('https://retry.example/', 'browser-link:failed')
    await Promise.all([first, duplicate])
    expect(begin).toHaveBeenCalledExactlyOnceWith('browser-link:failed', 'https://retry.example/')
    expect(open).toHaveBeenCalledTimes(1)
    finish()
    b.owner()
    await b.fiber.dispose()
  })

  it('cancels waiting work before a Host command when Session content unmounts', async () => {
    const b = await provider()
    const first = 'session-first' as SessionId
    let finish!: () => void
    const open = vi.fn(async (_url: string, _pendingId: string, current: () => boolean) => {
      await new Promise<void>((resolve) => { finish = resolve })
      if (!current()) throw new Error('会话已切换')
    })
    const clear = vi.fn()
    const dispose = b.face(first).registerLinkOpener(first, open, vi.fn(), clear, () => ({ interactionEpoch: 0 }))
    const pending = b.links.open(first, 'https://one.example/')
    await pending
    const waiting = b.links.open(first, 'https://two.example/')
    await waiting
    dispose()
    expect(clear).toHaveBeenCalledExactlyOnceWith()
    finish()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(1) })
    expect(open).toHaveBeenCalledTimes(1)
    b.owner()
    await b.fiber.dispose()
  })

  it('continues the FIFO after a Host denial without losing the second click', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    const open = vi.fn().mockRejectedValueOnce(new Error('远程工作区不支持人工浏览器'))
      .mockResolvedValueOnce(undefined)
    b.face(session).registerLinkOpener(session, open, vi.fn(), vi.fn(), () => ({ interactionEpoch: 0 }))
    const first = b.links.open(session, 'https://one.example/')
    const second = b.links.open(session, 'https://two.example/')
    await Promise.all([first, second])
    await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
    b.owner()
    await b.fiber.dispose()
  })

  it('bounds pending work to 32 clicks with explicit backpressure', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    let finish!: () => void
    const open = vi.fn(async () => new Promise<void>((resolve) => { finish = resolve }))
    const dispose = b.face(session).registerLinkOpener(session, open, vi.fn(), vi.fn(), () => ({ interactionEpoch: 0 }))
    const accepted = Array.from({ length: 32 }, (_, index) => b.links.open(session, `https://${String(index)}.example/`))
    const settlements = accepted.map(promise => promise.then(() => {}, () => {}))
    await expect(b.links.open(session, 'https://overflow.example/')).rejects.toThrow('待打开的链接过多')
    expect(open).toHaveBeenCalledTimes(1)
    dispose()
    finish()
    await Promise.all(settlements)
    expect(open).toHaveBeenCalledTimes(1)
    b.owner()
    await b.fiber.dispose()
  })
})
