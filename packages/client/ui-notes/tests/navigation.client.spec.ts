// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { createNotesNavigation } from '../src/client/navigation.ts'

const CWD = '/home/u/.coding/files/notes'

interface FakeSessions {
  list: { getSnapshot: () => { current: string | null; byId: Record<string, { id: string; cwd?: string }> } }
  create: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
}

interface FakeLayout {
  page: { getSnapshot: () => PageRoute | null }
  togglePage: ReturnType<typeof vi.fn>
  setPageAssistant: ReturnType<typeof vi.fn>
}

function makeContext(sessions: FakeSessions, layout: FakeLayout): ClientContext {
  return { sessions, layout } as unknown as ClientContext
}

function stubCwd(): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ path: CWD })))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('notes navigation', () => {
  it('复用工作目录相同的已有会话，打开页面并启用自动并排的助手', () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: { 's-old': { id: 's-old', cwd: CWD }, 's-cur': { id: 's-cur' } } }) },
      create: vi.fn(), open: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    const openNotes = createNotesNavigation(makeContext(sessions, layout))
    return openNotes().then(() => {
      expect(sessions.create).not.toHaveBeenCalled()
      expect(sessions.open).toHaveBeenCalledWith('s-old')
      expect(layout.togglePage).toHaveBeenCalledWith('notes', 's-old', 's-cur')
      expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
    })
  })

  it('没有同工作目录会话时新建会话；来处取自当前页的 returnSessionId', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: { 's-cur': { id: 's-cur', cwd: '/other' } } }) },
      create: vi.fn(async () => 's-new'), open: vi.fn(),
    }
    const layout = {
      page: { getSnapshot: () => ({ kind: 'files', sessionId: 's-cur', returnSessionId: 's-orig' }) as PageRoute },
      togglePage: vi.fn(), setPageAssistant: vi.fn(),
    }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout))()
    expect(sessions.create).toHaveBeenCalledWith({ cwd: CWD })
    expect(sessions.open).toHaveBeenCalledWith('s-new')
    expect(layout.togglePage).toHaveBeenCalledWith('notes', 's-new', 's-orig')
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('页面槽未就绪时按 32ms 间隔重试打开', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: 's-cur', byId: { 's-cur': { id: 's-cur', cwd: CWD } } }) },
      create: vi.fn(), open: vi.fn(),
    }
    let calls = 0
    const layout = {
      page: { getSnapshot: () => null },
      togglePage: vi.fn(() => { calls += 1; if (calls < 3) throw new Error('slot not ready') }),
      setPageAssistant: vi.fn(),
    }
    stubCwd()
    await createNotesNavigation(makeContext(sessions, layout))()
    expect(layout.togglePage).toHaveBeenCalledTimes(3)
    expect(layout.setPageAssistant).toHaveBeenCalledWith('auto')
  })

  it('进行中的打开流程不会被并发调用重复启动', async () => {
    const sessions = {
      list: { getSnapshot: () => ({ current: null, byId: {} as Record<string, { id: string; cwd?: string }> }) },
      create: vi.fn().mockImplementation(() => new Promise((resolve) => { window.setTimeout(() => { resolve('s-new') }, 40) })),
      open: vi.fn(),
    }
    const layout = { page: { getSnapshot: () => null }, togglePage: vi.fn(), setPageAssistant: vi.fn() }
    stubCwd()
    const openNotes = createNotesNavigation(makeContext(sessions, layout))
    await Promise.all([openNotes(), openNotes()])
    expect(sessions.create).toHaveBeenCalledTimes(1)
  })
})
