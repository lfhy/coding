// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

afterEach(() => { vi.useRealTimers() })

function openIde(options: {
  current?: string
  page?: unknown
  togglePage?: () => void
  openPage?: () => void
  workspaces?: { workspaceId: string; sessionIds: readonly string[] }[]
  remembered?: string
  binding?: string
  connectWorkspace?: (id: string) => Promise<string>
} = {}) {
  const registered: {
    id?: string
    key?: string
    inject: (sessionId?: string) => Record<string, unknown>
  }[] = []
  const connectHome = vi.fn(async () => 'session-home' as const)
  const connectWorkspace = vi.fn(options.connectWorkspace ?? (async() => 'session-workspace' as const))
  const open = vi.fn()
  const togglePage = options.togglePage ?? vi.fn()
  const openPage = options.openPage ?? vi.fn()
  const setPageAssistant = vi.fn()
  const workspaces = options.workspaces ?? []
  const ctx = {
    effect: (install: () => unknown) => { install() },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name: string, install: () => unknown) => { install() },
      register: (entry: { id?: string; key?: string; inject: (sessionId?: string) => Record<string, unknown> }) => {
        registered.push(entry)
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          current: options.current as never,
          byId: options.binding === undefined ? {} : { [options.binding]: {} },
        }),
      },
      open,
    },
    workspaces: {
      connectHome, connectWorkspace, create: vi.fn(),
      list: { getSnapshot: () => ({ items: workspaces }) },
    },
    workspaceFiles: {},
    layout: {
      page: { getSnapshot: () => options.page ?? null },
      togglePage, openPage, setPageAssistant, closePage: vi.fn(),
    },
  }
  apply(ctx as never)
  const entry = registered.find(value => value.id === 'ide')
  if (entry === undefined) throw new Error('ide navigation entry missing')
  const page = registered.find(value => value.key === 'ide')
  const face = page?.inject() as {
    actions: { enter: (id: string | null) => void; bindSession: (id: string, sessionId: string) => void }
    openWorkspace: (id: string) => Promise<void>
    leaveWorkspace: () => void
  }
  if (options.remembered !== undefined) {
    face.actions.bindSession(options.remembered, options.binding ?? 'session-bound')
    face.actions.enter(options.remembered)
  }
  const injected = entry.inject() as { openIde: () => Promise<void> }
  return {
    openIde: injected.openIde, connectHome, connectWorkspace, open, togglePage, openPage,
    setPageAssistant, face,
  }
}

describe('代码工作区入口打开流程', () => {
  it('没有记住工作区时进入欢迎页，不沿用对话页的工作区', async () => {
    const fixture = openIde({
      current: 'session-current',
      workspaces: [{ workspaceId: 'workspace-a', sessionIds: ['session-current'] }],
      page: { kind: 'notes', sessionId: 'page-session', returnSessionId: 'origin-session' },
    })
    await fixture.openIde()

    expect(fixture.togglePage).toHaveBeenCalledWith('ide', 'session-current', 'origin-session')
    expect(fixture.setPageAssistant).toHaveBeenCalledWith(false)
    expect(fixture.connectWorkspace).not.toHaveBeenCalled()
  })

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

  it('记住的工作区仍在时回到它并自动展开助手', async () => {
    const fixture = openIde({
      current: 'session-current',
      workspaces: [{ workspaceId: 'workspace-a', sessionIds: ['session-current'] }],
      remembered: 'workspace-a',
      binding: 'session-bound',
    })
    await fixture.openIde()

    expect(fixture.connectWorkspace).not.toHaveBeenCalled()
    expect(fixture.open).toHaveBeenCalledWith('session-bound')
    expect(fixture.openPage).toHaveBeenCalledWith('ide', 'session-bound', 'session-current')
    expect(fixture.setPageAssistant).toHaveBeenLastCalledWith('auto')
  })

  it('记住的工作区已删除时退回欢迎页', async () => {
    const fixture = openIde({
      current: 'session-current',
      workspaces: [{ workspaceId: 'workspace-b', sessionIds: ['session-current'] }],
      remembered: 'workspace-a',
      binding: 'session-bound',
    })
    await fixture.openIde()

    expect(fixture.connectWorkspace).not.toHaveBeenCalled()
    expect(fixture.togglePage).toHaveBeenCalledWith('ide', 'session-current', 'session-current')
    expect(fixture.setPageAssistant).toHaveBeenCalledWith(false)
  })

  it('页内切换工作区绑定新会话并留在同一页面', async () => {
    const fixture = openIde({
      current: 'session-current',
      workspaces: [{ workspaceId: 'workspace-a', sessionIds: ['session-current'] }],
      connectWorkspace: async () => 'session-a',
    })
    await fixture.face.openWorkspace('workspace-a')
    expect(fixture.connectWorkspace).toHaveBeenCalledWith('workspace-a')
    expect(fixture.open).toHaveBeenCalledWith('session-a')
    expect(fixture.openPage).toHaveBeenCalledWith('ide', 'session-a', 'session-current')
    expect(fixture.setPageAssistant).toHaveBeenLastCalledWith('auto')

    // 刚创建的工作区可能还没出现在列表投影里，进入动作不因此失败。
    await fixture.face.openWorkspace('workspace-missing')
    expect(fixture.openPage).toHaveBeenLastCalledWith('ide', 'session-a', 'session-current')
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
