// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

afterEach(() => { vi.useRealTimers() })

function openIde(options: {
  current?: string
  page?: unknown
  togglePage?: () => void
} = {}) {
  const registered: { id?: string; inject: () => Record<string, unknown> }[] = []
  const connectHome = vi.fn(async () => 'session-home' as const)
  const open = vi.fn()
  const togglePage = options.togglePage ?? vi.fn()
  const setPageAssistant = vi.fn()
  const ctx = {
    effect: (install: () => unknown) => { install() },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name: string, install: () => unknown) => { install() },
      register: (entry: { id?: string; inject: () => Record<string, unknown> }) => {
        registered.push(entry)
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => ({ current: options.current as never }) }, open },
    workspaces: { connectHome, connectWorkspace: vi.fn(), create: vi.fn() },
    layout: {
      page: { getSnapshot: () => options.page ?? null },
      togglePage, setPageAssistant, closePage: vi.fn(),
    },
  }
  apply(ctx as never)
  const entry = registered.find(value => value.id === 'ide')
  if (entry === undefined) throw new Error('ide navigation entry missing')
  const injected = entry.inject() as { openIde: () => Promise<void> }
  return { openIde: injected.openIde, connectHome, open, togglePage, setPageAssistant }
}

describe('代码工作区入口打开流程', () => {
  it('没有当前会话时连接 HOME，并保留独立页记录的返回会话', async () => {
    const fixture = openIde({
      page: { kind: 'notes', sessionId: 'page-session', returnSessionId: 'origin-session' },
    })
    await fixture.openIde()

    expect(fixture.connectHome).toHaveBeenCalledOnce()
    expect(fixture.open).toHaveBeenCalledWith('session-home')
    expect(fixture.togglePage).toHaveBeenCalledWith('ide', 'session-home', 'origin-session')
    expect(fixture.setPageAssistant).toHaveBeenCalledWith(false)
  })

  it('并发点击复用在途打开，页面短暂不可用后自动重试', async () => {
    vi.useFakeTimers()
    const togglePage = vi.fn()
      .mockImplementationOnce(() => { throw new Error('not ready') })
      .mockImplementation(() => {})
    const fixture = openIde({ current: 'session-current', togglePage })

    const first = fixture.openIde()
    const second = fixture.openIde()
    expect(first).toBe(second)
    await vi.advanceTimersByTimeAsync(32)
    await first
    expect(togglePage).toHaveBeenCalledTimes(2)
  })

  it('页面持续不可用时拒绝打开，不留下永久在途状态', async () => {
    vi.useFakeTimers()
    const togglePage = vi.fn(() => { throw new Error('not ready') })
    const fixture = openIde({ current: 'session-current', togglePage })

    const opening = fixture.openIde()
    const rejected = expect(opening).rejects.toThrow('ide page unavailable')
    await vi.advanceTimersByTimeAsync(30 * 32)
    await rejected
    expect(togglePage).toHaveBeenCalledTimes(30)
  })
})
