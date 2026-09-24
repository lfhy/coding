// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
    expect(view.getByText('子代理').closest('div')?.textContent).toBe('子代理21 运行中')
    expect(view.getByText('后台任务').closest('div')?.textContent).toBe('后台任务21 运行中')
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

  it('falls back to visible steps without projections and omits unknown timings and billing', () => {
    const node = { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] } as ConversationSnapshot['nodes'][number]
    const view = render(<OverviewCard {...props({}, [node])} />)
    expect(view.getByText('轮次').nextElementSibling?.textContent).toBe('1')
    expect(view.getByText('步骤').nextElementSibling?.textContent).toBe('1')
    expect(view.queryByText('缓存命中')).toBeNull()
    expect(view.queryByText('LLM 耗时')).toBeNull()
  })

})
