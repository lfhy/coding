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
    const open = vi.fn(async (url: string, current: () => boolean, shouldReveal: () => boolean,
      click: { interactionEpoch: number }) => {
      expect(current()).toBe(true)
      if (seen.length === 0) await firstGate
      seen.push(`${url}:${String(click.interactionEpoch)}:${String(shouldReveal())}`)
    })
    const dispose = b.face(first).registerLinkOpener(first, open, () => ({ interactionEpoch: epoch }))
    const other = vi.fn(async () => {})
    b.face(second).registerLinkOpener(second, other, () => ({ interactionEpoch: 0 }))
    const one = b.links.open(first, 'https://one.example/')
    epoch = 5
    const same = b.links.open(first, 'https://one.example/')
    epoch = 6
    const two = b.links.open(first, 'https://two.example/')
    expect(one).not.toBe(same)
    await b.links.open(second, 'https://other-session.example/')
    expect(other).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([one, same, two])
    expect(open).toHaveBeenCalledTimes(3)
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

  it('cancels waiting work before a Host command when Session content unmounts', async () => {
    const b = await provider()
    const first = 'session-first' as SessionId
    let finish!: () => void
    const open = vi.fn(async (_url: string, current: () => boolean) => {
      await new Promise<void>((resolve) => { finish = resolve })
      if (!current()) throw new Error('会话已切换')
    })
    const dispose = b.face(first).registerLinkOpener(first, open, () => ({ interactionEpoch: 0 }))
    const pending = b.links.open(first, 'https://one.example/')
    const pendingError = expect(pending).rejects.toThrow('会话已切换')
    const waiting = b.links.open(first, 'https://two.example/')
    const waitingError = expect(waiting).rejects.toThrow('会话已切换')
    dispose()
    await waitingError
    finish()
    await pendingError
    expect(open).toHaveBeenCalledTimes(1)
    b.owner()
    await b.fiber.dispose()
  })

  it('continues the FIFO after a Host denial without losing the second click', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    const open = vi.fn().mockRejectedValueOnce(new Error('远程工作区不支持人工浏览器'))
      .mockResolvedValueOnce(undefined)
    b.face(session).registerLinkOpener(session, open, () => ({ interactionEpoch: 0 }))
    const first = b.links.open(session, 'https://one.example/')
    const rejected = expect(first).rejects.toThrow('远程工作区')
    const second = b.links.open(session, 'https://two.example/')
    await rejected
    await second
    expect(open).toHaveBeenCalledTimes(2)
    b.owner()
    await b.fiber.dispose()
  })

  it('bounds pending work to 32 clicks with explicit backpressure', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    let finish!: () => void
    const open = vi.fn(async () => new Promise<void>((resolve) => { finish = resolve }))
    const dispose = b.face(session).registerLinkOpener(session, open, () => ({ interactionEpoch: 0 }))
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
