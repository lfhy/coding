import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { AgentBrowserPanel, type AgentBrowserInjected } from '../src/client/AgentBrowserPanel.tsx'
import { WATCH_ID, WATCH_KIND } from '../src/client/activity.ts'

afterEach(() => { vi.unstubAllGlobals() })

class FakeStream extends EventTarget {
  readonly close = vi.fn()
  emit(sessionId: string, count: number): void {
    this.dispatchEvent(new MessageEvent('tool-call', { data: JSON.stringify({ sessionId, count }) }))
  }
}

describe('Agent 浏览器插件注册与生命周期', () => {
  it('等待工作台声明后注册 keyed 内容，按会话展开并在卸载后清理', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const tab = { id: WATCH_ID, kind: WATCH_KIND, title: () => 'Agent 浏览器' }
    const register = vi.fn((_definition: { id: string; kind: string; keepMounted?: boolean }) => vi.fn())
    ctx.provide('sidebarRightTabs', { register })
    const openTabForSession = vi.fn()
    ctx.provide('sidebarRight', { openTabForSession })
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { 'session-one': {}, 'session-two': {} } }) } })
    const stream = new FakeStream()
    vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); return stream } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls.at(0)?.[0]).toMatchObject({ id: tab.id, kind: tab.kind, keepMounted: true })
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
    stream.emit('session-one', 1)
    stream.emit('session-two', 2)
    stream.emit('session-one', 3)
    stream.emit('unknown', 4)
    expect(openTabForSession.mock.calls).toEqual([['session-one', WATCH_KIND], ['session-two', WATCH_KIND]])
    root()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    await fiber.dispose()
    expect(stream.close).toHaveBeenCalled()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
  })
})
