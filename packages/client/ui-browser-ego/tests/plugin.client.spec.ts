import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from 'coding-client-runtime/client'
import { stubSettingsScope } from 'coding-client-test-runtime'
import { LocaleRuntime } from 'coding-client-locale/client'
import type { SessionId } from 'coding-session/types'
import { apply, inject } from '../src/client/index.ts'
import { AgentBrowserPanel, type AgentBrowserInjected } from '../src/client/AgentBrowserPanel.tsx'
import { WATCH_ID, WATCH_KIND } from '../src/client/activity.ts'
import type { EgoBrowserSettings } from '../src/client/settings.ts'

afterEach(() => { vi.unstubAllGlobals() })

class FakeStream extends EventTarget {
  readonly close = vi.fn()
  emit(sessionId: string, count: number): void {
    this.dispatchEvent(new MessageEvent('tool-call', { data: JSON.stringify({ sessionId, count }) }))
  }
}

async function linkProvider(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const settings = stubSettingsScope<EgoBrowserSettings>()
  ctx.provide('settingsScope', { bind: () => settings.scope } as never)
  ctx.provide('sidebarRightTabs', { register: () => vi.fn() })
  const openResourceForSession = vi.fn()
  ctx.provide('sidebarRight', { openResourceForSession, syncTabsForSession: vi.fn() })
  const sessions: Record<string, object> = { 'session-one': {}, 'session-two': {} }
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: sessions }) } })
  vi.stubGlobal('EventSource', class extends EventTarget { close() {} })
  vi.stubGlobal('fetch', fetcher)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, sessions, openResourceForSession, links: ctx.get('chatBrowserLinks')! }
}

describe('Agent 浏览器插件注册与生命周期', () => {
  it('等待工作台声明后注册 keyed 内容，按会话展开并在卸载后清理', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    // 设置卡与面板共用同一个设置命名空间；服务在部署中由设置插件提供。
    const settings = stubSettingsScope<EgoBrowserSettings>()
    ctx.provide('settingsScope', { bind: () => settings.scope } as never)
    const tab = { id: WATCH_ID, kind: WATCH_KIND, title: () => 'Agent 浏览器' }
    const register = vi.fn((_definition: { id: string; kind: string; keepMounted?: boolean; multiple?: boolean }) => vi.fn())
    ctx.provide('sidebarRightTabs', { register })
    const openResourceForSession = vi.fn()
    const syncTabsForSession = vi.fn()
    ctx.provide('sidebarRight', { openResourceForSession, syncTabsForSession })
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { 'session-one': {}, 'session-two': {} } }) } })
    const stream = new FakeStream()
    vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); return stream } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls.at(0)?.[0]).toMatchObject({ id: tab.id, kind: tab.kind, keepMounted: true, multiple: true })
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])

    const root = ctx.slots.register({ name: 'root', children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: {
        hooks: { tabInfo: (_standard: object, owner: object) => () => owner },
      } },
    } } as never, () => null)
    const entry = ctx.slots.entries('sidebar.right.pane.tab')[0]
    expect(entry?.component).toBe(AgentBrowserPanel)
    expect(entry?.options.key).toBe(WATCH_ID)
    const face = entry?.inject as unknown as (sessionId: string) => AgentBrowserInjected
    expect(face('session-one').hooks.browserEgo).not.toBe(face('session-two').hooks.browserEgo)
    expect(typeof face('session-one').navigate).toBe('function')
    stream.emit('session-one', 1)
    stream.emit('session-two', 2)
    stream.emit('session-one', 3)
    stream.emit('unknown', 4)
    expect(openResourceForSession.mock.calls).toEqual([
      ['session-one', 'sidebar://ego-browser%3Awatch', { kind: WATCH_KIND, reuseAddress: true }],
      ['session-two', 'sidebar://ego-browser%3Awatch', { kind: WATCH_KIND, reuseAddress: true }],
    ])
    root()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    await fiber.dispose()
    expect(stream.close).toHaveBeenCalled()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
  })
})

describe('对话链接在 Agent 浏览器打开', () => {
  const first = 'session-one' as SessionId
  const second = 'session-two' as SessionId

  it('没有浏览器标签时创建本会话页面并导航，成功后才展开对应工作台标签', async () => {
    const requests: { url: string; body: unknown }[] = []
    let next = 0
    const provider = await linkProvider(async (url, init) => {
      requests.push({ url, body: JSON.parse(init?.body as string) as unknown })
      if (url === '/api/ego/pages') return Response.json({ ok: true, targetId: `page-${++next}` })
      expect(provider.openResourceForSession).toHaveBeenCalledTimes(next - 1)
      return Response.json({ ok: true })
    })
    await provider.links.open(first, 'https://example.org/first')
    await provider.links.open(first, 'https://example.org/first')
    await provider.links.open(second, 'https://example.org/other')
    expect(requests).toEqual([
      { url: '/api/ego/pages', body: { sessionId: first } },
      { url: '/api/ego/navigation', body: { sessionId: first, targetId: 'page-1', action: 'navigate',
        url: 'https://example.org/first' } },
      { url: '/api/ego/pages', body: { sessionId: first } },
      { url: '/api/ego/navigation', body: { sessionId: first, targetId: 'page-2', action: 'navigate',
        url: 'https://example.org/first' } },
      { url: '/api/ego/pages', body: { sessionId: second } },
      { url: '/api/ego/navigation', body: { sessionId: second, targetId: 'page-3', action: 'navigate',
        url: 'https://example.org/other' } },
    ])
    expect(provider.openResourceForSession.mock.calls).toEqual([
      [first, 'sidebar://ego-browser%3Awatch/page-1', {
        kind: WATCH_KIND, reuseAddress: true, params: { targetId: 'page-1' },
      }],
      [first, 'sidebar://ego-browser%3Awatch/page-2', {
        kind: WATCH_KIND, reuseAddress: true, params: { targetId: 'page-2' },
      }],
      [second, 'sidebar://ego-browser%3Awatch/page-3', {
        kind: WATCH_KIND, reuseAddress: true, params: { targetId: 'page-3' },
      }],
    ])
    await provider.fiber.dispose()
    expect(provider.ctx.get('chatBrowserLinks')).toBeUndefined()
  })

  it.each(['javascript:alert(1)', 'file:///private', 'https://user:secret@example.org/',
    'https://example.org/with space', 'https://user@example.org/', 'https://example.org\\bad'])
  ('拒绝无效或携带凭据的链接 %s，不创建页面', async (url) => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, targetId: 'page-1' }))
    const provider = await linkProvider(fetcher)
    await expect(provider.links.open(first, url)).rejects.toThrow('链接地址无效')
    expect(fetcher).not.toHaveBeenCalled()
    await provider.fiber.dispose()
  })

  it('远端工作区同样在宿主浏览器打开链接', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/pages'
      ? Response.json({ ok: true, targetId: 'page-1' }) : Response.json({ ok: true }))
    const provider = await linkProvider(fetcher)
    provider.sessions[first] = { cwd: '/tmp/remote-workspaces/0123456789abcdefabcd/project-0123456789abcdefabcd' }
    await provider.links.open(first, 'https://example.org/')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/ego/pages', '/api/ego/navigation'])
    expect(provider.openResourceForSession).toHaveBeenCalledTimes(1)
    await provider.fiber.dispose()
  })

  it('会话失效、页面创建或导航失败时不打开工作台', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/pages'
      ? Response.json({ ok: true, targetId: 'page-1' }) : new Response(null, { status: 503 }))
    const provider = await linkProvider(fetcher)
    delete provider.sessions['session-one']
    await expect(provider.links.open(first, 'https://example.org/')).rejects.toThrow('会话已不可用')
    expect(fetcher).not.toHaveBeenCalled()
    provider.sessions[first] = {}
    await expect(provider.links.open(first, 'https://example.org/')).rejects.toThrow('无法在 Agent 浏览器打开链接')
    expect(provider.openResourceForSession).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, targetId: 'invalid id' }))
    await expect(provider.links.open(first, 'https://example.org/')).rejects.toThrow('无法在 Agent 浏览器打开链接')
    fetcher.mockRejectedValueOnce(new TypeError('network unavailable'))
    await expect(provider.links.open(first, 'https://example.org/')).rejects.toThrow('无法在 Agent 浏览器打开链接')
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(provider.links.open(first, 'https://example.org/')).rejects.toThrow('无法在 Agent 浏览器打开链接')
    expect(provider.openResourceForSession).not.toHaveBeenCalled()
    await provider.fiber.dispose()
  })
})
