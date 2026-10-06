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
  it('delegates only to the mounted Session and shares an in-flight double-click', async () => {
    const b = await provider()
    const first = 'session-first' as SessionId
    const second = 'session-second' as SessionId
    let finish!: () => void
    const open = vi.fn((_url: string) => new Promise<void>((resolve) => { finish = resolve }))
    const dispose = b.face(first).registerLinkOpener(first, async (url, current) => {
      expect(current()).toBe(true)
      await open(url)
    })
    const pending = b.links.open(first, 'https://one.example/')
    expect(b.links.open(first, 'https://one.example/')).toBe(pending)
    await expect(b.links.open(first, 'https://two.example/')).rejects.toThrow('正在打开另一链接')
    await expect(b.links.open(second, 'https://one.example/')).rejects.toThrow('尚未就绪')
    await Promise.resolve()
    expect(open).toHaveBeenCalledExactlyOnceWith('https://one.example/')
    finish()
    await pending
    dispose()
    await expect(b.links.open(first, 'https://one.example/')).rejects.toThrow('尚未就绪')
    b.owner()
    await b.fiber.dispose()
    expect(b.ctx.get('chatBrowserLinks')).toBeUndefined()
  })

  it('rejects a late Host settlement after the Session content unmounts', async () => {
    const b = await provider()
    const first = 'session-first' as SessionId
    let finish!: () => void
    const dispose = b.face(first).registerLinkOpener(first, async (_url, current) => {
      await new Promise<void>((resolve) => { finish = resolve })
      if (!current()) throw new Error('会话已切换')
    })
    const pending = b.links.open(first, 'https://one.example/')
    await Promise.resolve()
    dispose()
    finish()
    await expect(pending).rejects.toThrow('会话已切换')
    b.owner()
    await b.fiber.dispose()
  })

  it('propagates the provider rejection and permits another attempt', async () => {
    const b = await provider()
    const session = 'session-first' as SessionId
    const open = vi.fn().mockRejectedValueOnce(new Error('远程工作区不支持人工浏览器'))
      .mockResolvedValueOnce(undefined)
    b.face(session).registerLinkOpener(session, open)
    await expect(b.links.open(session, 'https://one.example/')).rejects.toThrow('远程工作区')
    await b.links.open(session, 'https://one.example/')
    expect(open).toHaveBeenCalledTimes(2)
    b.owner()
    await b.fiber.dispose()
  })
})
