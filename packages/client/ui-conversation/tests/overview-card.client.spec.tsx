// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
  type ConversationSnapshot, type JobView, type SessionId, type SessionListState,
  type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { OverviewCard, type OverviewCardProps } from '../src/client/skeleton/OverviewCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SID = 'parent' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId
const OTHER = 'other' as SessionId
const t: OverviewCardProps['t'] = makeTranslate(zh, commonZh)

function snapshot(nodes: ConversationSnapshot['nodes'] = []): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: { ...EMPTY_CHAT_SNAPSHOT, legacy: { ...EMPTY_CHAT_SNAPSHOT.legacy, nodes } },
    nodes, turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

function list(): SessionListState {
  const summary = (id: SessionId, running = false) => ({
    id, displayTitle: id, running, blank: false, updatedAt: 0,
  })
  return {
    ids: [SID, CHILD, GRANDCHILD, OTHER],
    byId: {
      [SID]: summary(SID),
      [CHILD]: { ...summary(CHILD, true), parentId: SID, origin: 'subagent' as const },
      [GRANDCHILD]: { ...summary(GRANDCHILD), parentId: CHILD, origin: 'subagent' as const },
      [OTHER]: summary(OTHER),
    },
    current: SID, phase: 'ready', subagentsByParent: {}, currentAddress: undefined,
    jobsBySession: {
      [SID]: [
        { id: 'bash-1' as JobView['id'], kind: 'bash', label: 'build', status: 'running', startedAt: 1 },
        { id: 'bash-2' as JobView['id'], kind: 'bash', label: 'test', status: 'completed', startedAt: 1, finishedAt: 2 },
      ],
      [OTHER]: [{ id: 'bash-3' as JobView['id'], kind: 'bash', label: 'other', status: 'running', startedAt: 1 }],
    },
  }
}

function props(values: Record<string, unknown> = {}, nodes: ConversationSnapshot['nodes'] = []) {
  const currentSnapshot = snapshot(nodes)
  const sessions = createSnapshotStore<SessionListState>(list())
  const workspaces = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const panel: OverviewCardProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector({ getSnapshot: () => currentSnapshot, subscribe: () => () => {} }),
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: (key: string) => values[key],
    useInput: () => { throw new Error('输入状态不在概览卡片中读取') },
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {}, pruneImages: () => {}, submit: () => {},
    },
    overviewExpanded: true,
    toggleOverview: vi.fn(),
    renderSlot: ((name: string, owner: { collapse?: () => void }) => name === 'conversation.overview.git'
      ? null
      : <button type="button" onClick={owner.collapse}>{name}</button>) as OverviewCardProps['renderSlot'],
    SessionProvider: ({ children }) => children(SID),
    t,
  }
  return panel
}

describe('session overview card', () => {
  it('groups this session’s descendant and task counts with whole-log metrics', () => {
    const panel = props({
      sessionStats: {
        turns: 2, steps: 449, llmMs: 8_394_000, toolMs: 1_623_000,
        ttftMs: 29_000, ttftSteps: 2, decodeMs: 1_000, decodeTokens: 270,
      },
      tokenUsage: {
        uncachedInputTokens: 1_700_000, cacheReadTokens: 168_300_000,
        cacheWriteTokens: 0, outputTokens: 123_000,
      },
    })
    const view = render(<OverviewCard {...panel} />)
    expect(view.getByRole('region', { name: '会话概览' })).toBeTruthy()
    expect(view.queryByRole('heading', { name: '会话概览' })).toBeNull()
    expect(view.getByRole('heading', { level: 2, name: '协作' })).toBeTruthy()
    expect(view.getByRole('heading', { level: 2, name: '运行统计' })).toBeTruthy()
    expect(view.getByRole('button', { name: /子代理/ }).textContent).toBe('子代理1 运行中')
    expect(view.getByRole('button', { name: /后台任务/ }).textContent).toBe('后台任务21 运行中')
    const subagents = view.getByRole('button', { name: /子代理/ })
    fireEvent.click(subagents)
    expect(subagents.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('button', { name: 'conversation.overview.subagents' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'conversation.overview.subagents' }))
    expect(subagents.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByRole('button', { name: /后台任务/ }))
    expect(view.getByRole('button', { name: 'conversation.overview.jobs' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /子代理/ }))
    expect(view.queryByRole('button', { name: 'conversation.overview.jobs' })).toBeNull()
    expect(view.getByRole('button', { name: 'conversation.overview.subagents' })).toBeTruthy()
    expect(view.getByText('轮次').nextElementSibling?.textContent).toBe('2')
    expect(view.getByText('步骤').nextElementSibling?.textContent).toBe('449')
    expect(view.getByText('LLM 耗时').nextElementSibling?.textContent).toBe('139m54s')
    expect(view.getByText('工具调用').nextElementSibling?.textContent).toBe('27m3s')
    expect(view.getByText('首 token 平均').nextElementSibling?.textContent).toBe('14.5s')
    expect(view.getByText('生成速度').nextElementSibling?.textContent).toBe('270 tok/s')
    expect(view.getByText('缓存命中').nextElementSibling?.textContent).toBe('99%')
    expect(view.getByText('输入').nextElementSibling?.textContent).toBe('170M tok')
    expect(view.getByText('输出').nextElementSibling?.textContent).toBe('123K tok')
    fireEvent.click(view.getByRole('button', { name: '收起会话概览' }))
    expect(panel.toggleOverview).toHaveBeenCalledOnce()
    view.rerender(<OverviewCard {...panel} overviewExpanded={false} />)
    expect(view.queryByRole('region', { name: '会话概览' })).toBeNull()
    view.rerender(<OverviewCard {...panel} overviewExpanded />)
    expect(view.getByRole('region', { name: '会话概览' })).toBeTruthy()
  })

  it('shows the total subagents only after all descendants stop running', () => {
    const panel = props()
    const view = render(<OverviewCard {...panel} />)
    expect(view.getByRole('button', { name: /子代理/ }).textContent).toBe('子代理1 运行中')
    const stopped = list()
    const child = stopped.byId[CHILD]
    if (child === undefined) throw new Error('Missing child fixture')
    stopped.byId[CHILD] = { ...child, running: false }
    panel.useSessions = bindSnapshotSelector(createSnapshotStore(stopped))
    view.rerender(<OverviewCard {...panel} />)
    expect(view.getByRole('button', { name: /子代理/ }).textContent).toBe('子代理2')
  })

  it('layers a long catalog outside the scroll-clipped card without shifting Git or statistics', () => {
    const panel = props()
    panel.renderSlot = ((name: string, owner: { collapse?: () => void }) => name === 'conversation.overview.git'
      ? <div data-overview-git="">Git marker</div>
      : name === 'conversation.overview.subagents'
        ? <div>{Array.from({ length: 20 }, (_, index) => <button type="button" key={index} onClick={owner.collapse}>Child {index}</button>)}</div>
        : <button type="button" onClick={owner.collapse}>Job</button>) as OverviewCardProps['renderSlot']
    const view = render(<OverviewCard {...panel} />)
    const card = view.getByRole('region', { name: '会话概览' })
    const git = view.getByText('Git marker')
    const stats = view.getByRole('heading', { name: '运行统计' })
    const cardChildren = Array.from(card.children)
    fireEvent.click(view.getByRole('button', { name: /子代理/ }))
    const layer = view.getByRole('region', { name: '子代理' })
    expect(layer.parentElement).toBe(document.body)
    expect(view.getByRole('button', { name: /子代理/ }).getAttribute('aria-controls')).toBe(layer.id)
    expect(card.contains(layer)).toBe(false)
    expect(within(layer).getAllByRole('button')).toHaveLength(20)
    expect(layer.style.maxHeight).not.toBe('')
    expect(card.children.length).toBe(cardChildren.length)
    expect(Array.from(card.children)).toEqual(cardChildren)
    expect(card.contains(git)).toBe(true)
    expect(card.contains(stats)).toBe(true)
    fireEvent.click(view.getByRole('button', { name: /后台任务/ }))
    expect(view.queryByRole('region', { name: '子代理' })).toBeNull()
    expect(view.getByRole('region', { name: '后台任务' }).parentElement).toBe(document.body)
  })

  it('positions the layer near viewport edges and follows card scrolling', () => {
    const originalWidth = window.innerWidth
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    try {
      const view = render(<OverviewCard {...props()} />)
      const anchor = view.getByRole('button', { name: /子代理/ })
      let top = 340
      vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({
        top, bottom: top + 28, left: 320, right: 360, width: 40, height: 28,
      }) as DOMRect)
      fireEvent.click(anchor)
      const layer = view.getByRole('region', { name: '子代理' })
      expect(parseFloat(layer.style.left)).toBeLessThanOrEqual(375 - 12 - 288)
      expect(parseFloat(layer.style.top)).toBeLessThan(top)
      expect(parseFloat(layer.style.maxHeight)).toBeLessThanOrEqual(400 - 24)
      top = 20
      fireEvent.scroll(view.getByRole('region', { name: '会话概览' }))
      expect(parseFloat(layer.style.top)).toBeGreaterThan(top)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
    }
  })

  it('supports ArrowDown navigation, Escape focus return and outside dismissal', async () => {
    const panel = props()
    panel.renderSlot = ((name: string, owner: { collapse?: () => void }) => name === 'conversation.overview.git'
      ? null
      : <button type="button" role="treeitem" onClick={owner.collapse}>{name}</button>) as OverviewCardProps['renderSlot']
    const view = render(<OverviewCard {...panel} />)
    const anchor = view.getByRole('button', { name: /子代理/ })
    anchor.focus()
    fireEvent.keyDown(anchor, { key: 'ArrowDown' })
    await vi.waitFor(() => { expect(document.activeElement).toBe(view.getByRole('treeitem')) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => { expect(document.activeElement).toBe(anchor) })
    expect(view.queryByRole('region', { name: '子代理' })).toBeNull()
    fireEvent.click(anchor)
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('region', { name: '子代理' })).toBeNull()
    fireEvent.click(anchor)
    fireEvent.click(view.getByRole('treeitem'))
    await vi.waitFor(() => { expect(document.activeElement).toBe(anchor) })
  })

  it('closes on outside focus, overview collapse, and session change without reusing another instance ID', () => {
    const panel = props()
    const view = render(<><OverviewCard {...panel} /><OverviewCard {...panel} /></>)
    const anchors = view.getAllByRole('button', { name: /子代理/ })
    expect(anchors[0]!.getAttribute('aria-controls')).not.toBe(anchors[1]!.getAttribute('aria-controls'))
    fireEvent.click(anchors[0]!)
    const layer = view.getByRole('region', { name: '子代理' })
    expect(anchors[0]!.getAttribute('aria-controls')).toBe(layer.id)
    view.unmount()

    const single = render(<OverviewCard {...panel} />)
    const anchor = single.getByRole('button', { name: /子代理/ })
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      fireEvent.click(anchor)
      anchor.focus()
      expect(single.getByRole('region', { name: '子代理' })).toBeTruthy()
      act(() => { outside.focus() })
      expect(document.activeElement).toBe(outside)
      expect(single.queryByRole('region', { name: '子代理' })).toBeNull()
      fireEvent.click(anchor)
      single.rerender(<OverviewCard {...panel} overviewExpanded={false} />)
      expect(single.queryByRole('region', { name: '子代理' })).toBeNull()
      single.rerender(<OverviewCard {...panel} overviewExpanded />)
      expect(anchor.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(anchor)
      single.rerender(<OverviewCard {...panel} sessionId={OTHER} />)
      expect(single.queryByRole('region', { name: '子代理' })).toBeNull()
    } finally {
      outside.remove()
    }
  })

  it('falls back to visible steps without projections and omits unknown timings and billing', () => {
    const node = { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] } as ConversationSnapshot['nodes'][number]
    const view = render(<OverviewCard {...props({}, [node])} />)
    expect(view.getByText('轮次').nextElementSibling?.textContent).toBe('1')
    expect(view.getByText('步骤').nextElementSibling?.textContent).toBe('1')
    expect(view.queryByText('缓存命中')).toBeNull()
    expect(view.queryByText('LLM 耗时')).toBeNull()
  })

})
