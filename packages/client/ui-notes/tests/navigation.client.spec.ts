// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext, SessionId } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { createNotesConversation, createNotesNavigation } from '../src/client/navigation.ts'

const CWD = '/home/u/.coding/files/notes'

interface FakeSessions {
  list: {
    getSnapshot: () => {
      current: string | null
      byId: Record<string, { id: string; cwd?: string; blank?: boolean; agentPreset?: string }>
    }
  }
  create: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  noteAgentPreset: ReturnType<typeof vi.fn>
}

interface FakeLayout {
  page: { getSnapshot: () => PageRoute | null }
  togglePage: ReturnType<typeof vi.fn>
  /** 只有「新对话」用例读取页面切换；旧的打开流程不涉及画页。 */
  openPage?: ReturnType<typeof vi.fn>
  setPageAssistant: ReturnType<typeof vi.fn>
}

function makeContext(sessions: FakeSessions, layout: FakeLayout): ClientContext {
  return { sessions, layout, get: () => ({ api: { agentPresets: { select: vi.fn(async () => ({ result: { ok: true, value: { agentPreset: 'notes' } } })) } } }) } as unknown as ClientContext
}

function stubCwd(): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ path: CWD })))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('notes navigation', () => {
  it('同目录只有带历史的笔记对话时新建空白会话，助手停在欢迎页', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-old': { id: 's-old', cwd: CWD, agentPreset: 'notes', updatedAt: 30 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => undefined)()
    expect(sessions.create).toHaveBeenCalledWith({ cwd: CWD })
    expect(sessions.open).toHaveBeenCalledWith('s-new')
    expect(layout.togglePage).toHaveBeenCalledWith('notes', 's-new', 's-cur')
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('同目录有多个会话时优先复用空白会话', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-note-old': { id: 's-note-old', cwd: CWD, agentPreset: 'notes', updatedAt: 10 },
        's-blank': { id: 's-blank', cwd: CWD, blank: true, updatedAt: 20 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => undefined)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('s-blank')
    expect(sessions.noteAgentPreset).toHaveBeenCalledWith('s-blank', 'notes')
  })

  it('同目录只有空白会话时复用它并切到笔记专用模式', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-blank': { id: 's-blank', cwd: CWD, blank: true, updatedAt: 20 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => undefined)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.noteAgentPreset).toHaveBeenCalledWith('s-blank', 'notes')
    expect(sessions.open).toHaveBeenCalledWith('s-blank')
  })

  it('本次运行里用过的对话继续用，不被同目录的空白会话顶掉', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-used': { id: 's-used', cwd: CWD, agentPreset: 'notes', updatedAt: 10 },
        's-blank': { id: 's-blank', cwd: CWD, blank: true, updatedAt: 20 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => 's-used' as SessionId)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('s-used')
    expect(layout.togglePage).toHaveBeenCalledWith('notes', 's-used', 's-cur')
  })

  it('记住的对话已被删除时按同目录空白会话重新开始', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-blank': { id: 's-blank', cwd: CWD, blank: true, updatedAt: 20 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => 's-gone' as SessionId)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('s-blank')
  })

  it('记住的对话不在笔记目录时不接续', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: {
        's-other': { id: 's-other', cwd: '/tmp/other', agentPreset: 'notes', updatedAt: 30 },
        's-blank': { id: 's-blank', cwd: CWD, blank: true, updatedAt: 20 },
        's-cur': { id: 's-cur', updatedAt: 1 },
      } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => 's-other' as SessionId)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('s-blank')
  })

  it('复用的空白会话在打开过程中被别的客户端占用时拒绝继续', async () => {
    const blank = { id: 's-notes', cwd: CWD, agentPreset: 'notes', blank: true }
    const current = { id: 's-cur', updatedAt: 1 }
    let reads = 0
    const sessions = {
      // 前两次读取用于定位可复用会话；模式检查时该会话已被其他客户端切走并写入历史。
      list: { getSnapshot: () => {
        reads += 1
        return { current: 's-cur', byId: reads <= 2
          ? { 's-notes': blank, 's-cur': current }
          : { 's-notes': { ...blank, agentPreset: 'standard', blank: false }, 's-cur': current } }
      } },
      create: vi.fn(), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    await expect(createNotesNavigation(makeContext(sessions, layout), () => undefined)()).rejects.toThrow(/笔记助手需要空白会话/u)
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('没有同工作目录会话时新建会话；来处取自当前页的 returnSessionId', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: { 's-cur': { id: 's-cur', cwd: '/other' } } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = {
      page: { getSnapshot: () => ({ kind: 'files', sessionId: 's-cur', returnSessionId: 's-orig' }) as PageRoute },
      togglePage: vi.fn(), setPageAssistant: vi.fn(),
    }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => undefined)()
    expect(sessions.create).toHaveBeenCalledWith({ cwd: CWD })
    expect(sessions.open).toHaveBeenCalledWith('s-new')
    expect(layout.togglePage).toHaveBeenCalledWith('notes', 's-new', 's-orig')
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('页面槽未就绪时按 32ms 间隔重试打开', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: { 's-cur': { id: 's-cur', cwd: CWD, agentPreset: 'notes', blank: true } } }) },
      create: vi.fn(), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    let calls = 0
    const layout = {
      page: { getSnapshot: () => null },
      togglePage: vi.fn(() => { calls += 1; if (calls < 3) throw new Error('slot not ready') }),
      setPageAssistant: vi.fn(),
    }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout), () => undefined)()
    expect(layout.togglePage).toHaveBeenCalledTimes(3)
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('进行中的打开流程不会被并发调用重复启动', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: null, byId: {} as Record<string, { id: string; cwd?: string }> }) },
      create: vi.fn().mockImplementation(() => new Promise((resolve) => { window.setTimeout(() => { resolve('s-new') }, 40) })),
      open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    const openNotes = createNotesNavigation(makeContext(sessions, layout), () => undefined)
    await Promise.all([openNotes(), openNotes()])
    expect(sessions.create).toHaveBeenCalledTimes(1)
  })
})

describe('notes new conversation', () => {
  function setup(select: (input: unknown) => unknown = async () => ({ result: { ok: true, value: { agentPreset: 'notes' } } })) {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-old', byId: { 's-old': { id: 's-old', cwd: CWD, agentPreset: 'notes' } } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(), noteAgentPreset: vi.fn(),
    }
    const layout = {
      page: { getSnapshot: () => ({ kind: 'notes', sessionId: 's-old', returnSessionId: 's-orig' }) as PageRoute },
      togglePage: vi.fn(), openPage: vi.fn(), setPageAssistant: vi.fn(),
    }
    const ctx = {
      sessions,
      layout,
      get: () => ({ api: { agentPresets: { select: vi.fn(select) } } }),
    } as unknown as ClientContext
    return { ctx, sessions, layout }
  }

  it('在当前笔记页新建会话，沿用笔记专用模式并保持页面与助手', async () => {
    stubCwd()
    const { ctx, sessions, layout } = setup()
    await createNotesConversation(ctx)()
    expect(sessions.create).toHaveBeenCalledWith({ cwd: CWD })
    expect(sessions.noteAgentPreset).toHaveBeenCalledWith('s-new', 'notes')
    expect(sessions.open).toHaveBeenCalledWith('s-new')
    expect(layout.openPage).toHaveBeenCalledWith('notes', 's-new', 's-orig')
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('不在笔记页时不创建会话', async () => {
    stubCwd()
    const { ctx, sessions, layout } = setup()
    layout.page.getSnapshot = () => ({ kind: 'files', sessionId: 's-old' }) as PageRoute
    await createNotesConversation(ctx)()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(layout.openPage).not.toHaveBeenCalled()
  })

  it('笔记专用模式不可用时抛出，不选中新会话也不切换页面', async () => {
    stubCwd()
    const { ctx, sessions, layout } = setup(async () => ({ result: { ok: true, value: { agentPreset: 'standard' } } }))
    await expect(createNotesConversation(ctx)()).rejects.toThrow(/笔记专用模式暂不可用/u)
    expect(sessions.open).not.toHaveBeenCalled()
    expect(layout.openPage).not.toHaveBeenCalled()
  })

  it('进行中的新对话不会被重复点击再建一个会话', async () => {
    stubCwd()
    const { ctx, sessions } = setup()
    sessions.create.mockImplementation(() => new Promise((resolve) => {
      window.setTimeout(() => { resolve('s-new') }, 40)
    }))
    const start = createNotesConversation(ctx)
    await Promise.all([start(), start()])
    expect(sessions.create).toHaveBeenCalledTimes(1)
  })
})
