// @vitest-environment jsdom
/** 三种侧栏范围的真实呈现、搜索边界、持久化和无障碍交互回归。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from 'coding-client-test-runtime'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from 'coding-client-runtime/client'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => { localStorage.clear() })

const sid = (id: string) => id as SessionId
const summary = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, updatedAt, blank: false, running: false, ...extra,
})
const list = (items: SessionSummary[], current?: SessionId): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
  current, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
})
const workspace = (sessionIds: string[]): WorkspaceView => ({
  workspaceId: 'project' as WorkspaceId, title: '真实项目', path: '/project', sessionIds: sessionIds.map(sid),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaces = (items: WorkspaceView[], archivedSessionIds: SessionId[] = []): WorkspaceListState => ({
  items, archivedSessionIds, state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
})
function hook<T>(snapshot: T) {
  return <S,>(select: (value: T) => S): S => select(snapshot)
}

function mount(sessions: SessionListState, workspaceState: WorkspaceListState, extra: Partial<WorkspaceBrowserProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true, expandSidebar: vi.fn(), collapseSidebar: vi.fn(), conversationVisible: true, showConversation: vi.fn(),
    useSessions: hook(sessions), useWorkspaces: hook(workspaceState), useStore: bindSnapshotSelector(store), actions: store.actions,
    startSession: vi.fn(), open: vi.fn(), renameSession: vi.fn(async () => {}), forkSession: vi.fn(),
    renameWorkspace: vi.fn(async () => {}), deleteWorkspace: vi.fn(async () => {}), archiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}), insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace([])),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
    useDirectoryFlow: select => select(false), useHostDescription: select => select(undefined), renderSlot: () => null,
    t: makeTranslate(zh, commonZh), ...extra,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { store, props, view, update: (patch: Partial<WorkspaceBrowserProps>) => {
    Object.assign(props, patch)
    view.rerender(<WorkspaceBrowser {...props} />)
  } }
}

const selectTab = (name: '工作' | '对话' | '最近') => { fireEvent.click(screen.getByRole('tab', { name })) }
const rowTitles = () => screen.queryAllByRole('treeitem').map(row => row.textContent)

describe('Workspace browser scopes', () => {
  it('filters all three views by true ownership and hides blank, archived and subagent sessions everywhere', () => {
    const items = [
      summary('owned', 1), summary('loose', 4, { cwd: '/project' }),
      summary('fork', 3, { parentId: sid('owned') }),
      summary('owned-blank', 9, { blank: true }), summary('loose-blank', 8, { blank: true }),
      summary('owned-archived', 7), summary('loose-archived', 6),
      summary('owned-agent', 10, { origin: 'subagent', parentId: sid('owned'), running: true }),
      summary('loose-agent', 11, { origin: 'subagent', parentId: sid('loose'), running: true }),
    ]
    mount(list(items, sid('owned')), workspaces([
      workspace(['owned', 'owned-blank', 'owned-archived', 'owned-agent']),
    ], [sid('owned-archived'), sid('loose-archived')]))
    expect(rowTitles()).toEqual([expect.stringContaining('真实项目'), expect.stringContaining('owned')])
    expect(screen.queryByText('loose')).toBeNull()
    expect(screen.queryByText('未分组')).toBeNull()

    selectTab('对话')
    expect(rowTitles()).toEqual([expect.stringContaining('loose'), expect.stringContaining('fork')])
    expect(screen.queryByText('真实项目')).toBeNull()
    expect(screen.queryByText('owned')).toBeNull()

    selectTab('最近')
    expect(rowTitles()).toEqual([
      expect.stringContaining('loose'), expect.stringContaining('fork'), expect.stringContaining('owned'),
    ])
    for (const title of items.slice(3).map(item => item.displayTitle)) expect(screen.queryByText(title)).toBeNull()
    selectTab('工作')
    expect(screen.getByText('owned')).toBeTruthy()
    expect(screen.queryByText('loose')).toBeNull()
  })

  it('keeps Recent strictly newest-first with stable id ties after activity, regardless of persisted manual orders', () => {
    const items = [summary('old', 1), summary('tie-b', 2), summary('tie-a', 2)]
    const browser = mount(list(items), workspaces([workspace(['old'])]))
    act(() => {
      browser.store.actions.setOrderBy('manual')
      browser.store.actions.syncSessionOrderAccount('project', ['old'], { old: 1 })
      browser.store.actions.syncSessionOrderAccount('', ['tie-b', 'tie-a'], { 'tie-b': 2, 'tie-a': 2 })
      browser.store.actions.syncSessionOrderAccount('__flat_session_order__', ['old', 'tie-b', 'tie-a'], {})
    })
    selectTab('最近')
    expect(rowTitles()).toEqual([
      expect.stringContaining('tie-a'), expect.stringContaining('tie-b'), expect.stringContaining('old'),
    ])
    expect(screen.queryByRole('button', { name: '视图选项' })).toBeNull()
    const before = browser.store.getSnapshot().sessionOrderByAccount
    const [first, last] = [screen.getByText('tie-a').closest('[role="treeitem"]')!, screen.getByText('old').closest('[role="treeitem"]')!]
    for (const row of screen.getAllByRole('treeitem')) expect(row.getAttribute('draggable')).toBe('false')
    fireEvent.dragStart(first, { dataTransfer: { setData: vi.fn() } })
    fireEvent.drop(last)
    expect(browser.store.getSnapshot().sessionOrderByAccount).toEqual(before)
    browser.update({ useSessions: hook(list([summary('old', 5), ...items.slice(1)])) })
    expect(rowTitles()).toEqual([
      expect.stringContaining('old'), expect.stringContaining('tie-a'), expect.stringContaining('tie-b'),
    ])
    selectTab('对话')
    expect(rowTitles()).toEqual([expect.stringContaining('tie-b'), expect.stringContaining('tie-a')])
    expect(browser.props.insertSessionBefore).not.toHaveBeenCalled()
  })

  it.each(['对话', '最近'] as const)('retains row navigation, rename, fork and archive in %s', async (tab) => {
    const browser = mount(list([summary('loose', 1)]), workspaces([]), { conversationVisible: false })
    selectTab(tab)
    fireEvent.click(screen.getByText('loose'))
    expect(browser.props.showConversation).toHaveBeenCalledOnce()
    expect(browser.props.open).toHaveBeenCalledWith(sid('loose'))
    fireEvent.click(screen.getByRole('button', { name: '会话“loose”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: '新的标题' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重命名' })) })
    expect(browser.props.renameSession).toHaveBeenCalledWith(sid('loose'), '新的标题')
    fireEvent.click(screen.getByRole('button', { name: '会话“loose”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    expect(browser.props.forkSession).toHaveBeenCalledWith(sid('loose'))
    fireEvent.click(screen.getByRole('button', { name: '会话“loose”的操作' }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' })) })
    expect(browser.props.archiveSession).toHaveBeenCalledWith(sid('loose'))
    browser.update({ useWorkspaces: hook(workspaces([], [sid('loose')])) })
    expect(screen.queryByText('loose')).toBeNull()
  })

  it('provides roving Tab focus, arrow wrapping, Home/End and a labelled panel without losing the last view in rail or reload', () => {
    const browser = mount(list([]), workspaces([]))
    const work = screen.getByRole('tab', { name: '工作' })
    const conversations = screen.getByRole('tab', { name: '对话' })
    const recent = screen.getByRole('tab', { name: '最近' })
    expect([work.tabIndex, conversations.tabIndex, recent.tabIndex]).toEqual([0, -1, -1])
    work.focus()
    expect(fireEvent.keyDown(work, { key: 'Tab' })).toBe(true)
    fireEvent.keyDown(work, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(conversations)
    expect([work.tabIndex, conversations.tabIndex, recent.tabIndex]).toEqual([-1, 0, -1])
    fireEvent.keyDown(conversations, { key: 'End' })
    expect(document.activeElement).toBe(recent)
    fireEvent.keyDown(recent, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(work)
    fireEvent.keyDown(work, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(recent)
    fireEvent.keyDown(recent, { key: 'Home' })
    expect(document.activeElement).toBe(work)
    fireEvent.keyDown(work, { key: 'End' })
    const panel = screen.getByRole('tabpanel', { name: '最近' })
    expect(recent.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(recent.id)
    browser.update({ wide: false })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(browser.store.getSnapshot().view).toBe('recent')
    browser.update({ wide: true })
    expect(screen.getByRole('tab', { name: '最近' }).getAttribute('aria-selected')).toBe('true')
    browser.view.unmount()
    mount(list([]), workspaces([]))
    expect(screen.getByRole('tab', { name: '最近' }).getAttribute('aria-selected')).toBe('true')
  })

  it('defaults legacy preferences without a view to Work, preserves group preferences and discards the old global flat order', () => {
    localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
      groupBy: 'flat', orderBy: 'manual', groupExpansion: { project: true },
      sessionOrderByAccount: { project: ['second', 'first'], '': ['loose'], __flat_session_order__: ['loose', 'first'] },
      sessionUpdatedAtByAccount: { project: { first: 1, second: 2 }, '': { loose: 3 }, __flat_session_order__: {} },
    }))
    const browser = mount(list([summary('first', 1), summary('second', 2), summary('loose', 3)]),
      workspaces([workspace(['first', 'second'])]))
    expect(screen.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    expect(rowTitles()).toEqual([
      expect.stringContaining('真实项目'), expect.stringContaining('second'), expect.stringContaining('first'),
    ])
    expect(browser.store.getSnapshot().sessionOrderByAccount.__flat_session_order__).toBeUndefined()
    selectTab('对话')
    expect(screen.getByText('loose')).toBeTruthy()
  })

  it('resets only the list scroll when switching views, including while a query stays active', () => {
    mount(list([summary('needle-owned', 1), summary('needle-loose', 2)]), workspaces([workspace(['needle-owned'])]))
    const workTree = screen.getByRole('tree')
    workTree.scrollTop = 240
    selectTab('对话')
    expect(screen.getByRole('tree').scrollTop).toBe(0)
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'needle' } })
    const searchTree = screen.getByRole('tree', { name: '搜索结果' })
    const searchScroll = searchTree.parentElement!
    searchScroll.scrollTop = 180
    selectTab('最近')
    expect(screen.getByRole('tree', { name: '搜索结果' }).parentElement!.scrollTop).toBe(0)
    expect(screen.getByPlaceholderText<HTMLInputElement>('搜索会话…').value).toBe('needle')
    expect(within(screen.getByRole('tabpanel')).getAllByRole('treeitem')).toHaveLength(2)
  })

  it('filters both metadata and Host content hits to each tab, keeping hasMore hints in Work and Conversations', async () => {
    vi.useFakeTimers()
    const items = [summary('owned-title', 4, { displayTitle: 'Needle 工作' }),
      summary('loose-title', 3, { displayTitle: 'Needle 对话' }), summary('owned-body', 2), summary('loose-body', 1),
      summary('hidden-blank', 9, { blank: true }), summary('hidden-archive', 8), summary('hidden-agent', 7, { origin: 'subagent' })]
    mount(list(items), workspaces([workspace(['owned-title', 'owned-body', 'hidden-archive'])], [sid('hidden-archive')]), {
      searchSessions: vi.fn(async () => ({
        items: ['loose-body', 'owned-body', 'hidden-blank', 'hidden-archive', 'hidden-agent']
          .map(sessionId => ({ sessionId: sid(sessionId), snippet: `${sessionId} needle excerpt` })),
        hasMore: true,
      })),
    })
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'needle' } })
    expect(screen.getByText('Needle 工作')).toBeTruthy()
    expect(screen.queryByText('Needle 对话')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText('owned-body needle excerpt')).toBeTruthy()
    expect(screen.queryByText('loose-body needle excerpt')).toBeNull()
    expect(screen.getByText('仅显示前 20 条结果，请缩小搜索范围。')).toBeTruthy()
    selectTab('对话')
    expect(screen.getByText('Needle 对话')).toBeTruthy()
    expect(screen.getByText('loose-body needle excerpt')).toBeTruthy()
    expect(screen.queryByText('Needle 工作')).toBeNull()
    expect(screen.queryByText('owned-body needle excerpt')).toBeNull()
    expect(screen.getByText('仅显示前 20 条结果，请缩小搜索范围。')).toBeTruthy()
    selectTab('最近')
    expect(rowTitles()).toEqual([
      expect.stringContaining('Needle 工作'), expect.stringContaining('Needle 对话'),
      expect.stringContaining('owned-body'), expect.stringContaining('loose-body'),
    ])
    for (const item of items.slice(4)) expect(screen.queryByText(`${item.id} needle excerpt`)).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'not-in-title' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    selectTab('工作')
    expect(screen.queryByText('loose-body needle excerpt')).toBeNull()
  })
})
