// @vitest-environment jsdom
// 状态源均是 Host 成品投影；这里覆盖推送后的优先级与回合显隐，不重放领域事件。
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type { SessionId, SessionListState, SessionProjectionMap } from 'coding-client-runtime/client'
import {
  bindSnapshotSelector, conversationSnapshot, makeTranslate, workspaceListState,
} from 'coding-client-test-runtime'
import type { GoalPhase, GoalProjection } from 'coding-goal/client'
import type {} from 'coding-tool-status/client'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { createChatStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

type StatusValues = Partial<Pick<SessionProjectionMap, 'turnStatus' | 'todos' | 'goal'>>
const SID = 'status-session' as SessionId

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

/** 仅提供状态行所在视图实际使用的标准座位，所有变化都由快照源发布。 */
function makeHarness(initial: StatusValues = {}) {
  const session = createSnapshotStore({ ...conversationSnapshot(SID), running: true })
  const projections = createSnapshotStore<StatusValues>(initial)
  const useValues = bindSnapshotSelector(projections)
  const useProjection = ((key: keyof StatusValues, selector?: (value: unknown) => unknown) =>
    useValues(values => (selector ?? (value => value))(values[key]))) as ChatViewSlotProps['useProjection']
  const sessions = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore(workspaceListState())
  const chat = createChatStore().create()
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection,
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    useInput: () => { throw new Error('本测试不读取输入区') },
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {}, pruneImages: () => {}, submit: () => {},
    },
    renderSlot: () => null,
    SessionProvider: ({ children }) => children(SID),
    openDetails: vi.fn(), openFile: vi.fn(async () => {}), openBrowserUrl: vi.fn(async () => {}),
    loadOlder: vi.fn(), loadImage: vi.fn(async () => ''), inspectCall: vi.fn(),
    chatScroll: { read: () => null, save: () => {} },
    forkAt: vi.fn(), retryTurn: vi.fn(async () => {}), retryHistory: vi.fn(async () => {}),
    startSession: vi.fn(), archiveSession: vi.fn(async () => {}), fileMentions: () => undefined,
    t: makeTranslate(zh, commonZh),
  }
  return {
    props,
    push: (next: StatusValues) => { projections.set({ ...projections.getSnapshot(), ...next }) },
    setRunning: (running: boolean) => { session.update((value) => { value.running = running }) },
  }
}

/** 目标只提供持久阶段，续行是否启用不影响此处的目标过滤。 */
function goal(phase: GoalPhase = 'active', objective = '完成本轮验收'): GoalProjection {
  return {
    goal: { id: 'goal-1' as GoalProjection['goal']['id'], revision: 1, objective, phase, maxGoalRounds: 8 },
    roundsStarted: 0, createdAt: 100, updatedAt: 100,
  }
}

describe('聊天视图运行进度', () => {
  it('按原列表顺序显示全部活动待办，并实时跟随最新内容', () => {
    const h = makeHarness({
      todos: [
        { content: '已读需求', status: 'completed' },
        { content: '实现功能', status: 'in_progress' },
        { content: '准备发布', status: 'pending' },
        { content: '验证交互', status: 'in_progress' },
      ],
      goal: goal(),
    })
    const view = render(<ChatView {...h.props} />)
    expect(view.getByText('实现功能 · 验证交互')).toBeTruthy()
    expect(view.queryByText('完成本轮验收')).toBeNull()
    expect(view.queryByText(zh['status.running'])).toBeNull()
    act(() => { h.push({ todos: [{ content: '修复验证缺口', status: 'in_progress' }] }) })
    expect(view.getByText('修复验证缺口')).toBeTruthy()
    expect(view.queryByText('实现功能 · 验证交互')).toBeNull()
  })

  it('手动进度实时覆盖自动来源，后一次待办写入清除它并显示最新列表', () => {
    const h = makeHarness({ todos: [{ content: '实现入口', status: 'in_progress' }], goal: goal() })
    const view = render(<ChatView {...h.props} />)
    act(() => { h.push({ turnStatus: '正在等待验收结果' }) })
    expect(view.getByText('正在等待验收结果').getAttribute('aria-hidden')).toBeNull()
    expect(view.queryByText('实现入口')).toBeNull()
    // 同一次 todo/write 的权威结果同时更新清单、清空手动进度；客户端不比较事件 seq。
    act(() => {
      h.push({ turnStatus: null, todos: [
        { content: '实现入口', status: 'completed' },
        { content: '核对最终结果', status: 'in_progress' },
        { content: '复核兼容性', status: 'in_progress' },
      ] })
    })
    expect(view.getByText('核对最终结果 · 复核兼容性')).toBeTruthy()
    expect(view.queryByText('正在等待验收结果')).toBeNull()
  })

  it('清除手动进度时显示当前目标，而非设置手动进度前的旧目标', () => {
    const h = makeHarness({ turnStatus: '正在确认需求', goal: goal() })
    const view = render(<ChatView {...h.props} />)
    act(() => { h.push({ goal: goal('active', '核验新的验收范围') }) })
    expect(view.getByText('正在确认需求')).toBeTruthy()
    act(() => { h.push({ turnStatus: null }) })
    expect(view.getByText('核验新的验收范围')).toBeTruthy()
    expect(view.queryByText('完成本轮验收')).toBeNull()
  })

  it.each([
    {},
    { todos: null },
    { todos: [] },
    { todos: [{ content: '尚未开始', status: 'pending' as const }, { content: '已结束', status: 'completed' as const }] },
  ] satisfies StatusValues[])('没有活动待办时回退到进行中的目标：%j', (values) => {
    const h = makeHarness({ ...values, goal: goal() })
    const view = render(<ChatView {...h.props} />)
    expect(view.getByText('完成本轮验收').getAttribute('aria-hidden')).toBeNull()
    expect(view.queryByText(zh['status.running'])).toBeNull()
  })

  it.each(['paused', 'blocked', 'complete'] as const)('不使用 %s 目标，回退到随机运行文案', (phase) => {
    const h = makeHarness({ goal: goal(phase) })
    const view = render(<ChatView {...h.props} />)
    expect(view.queryByText('完成本轮验收')).toBeNull()
    expect(view.getByText(zh['status.running'])).toBeTruthy()
    expect(view.getByRole('status').querySelector('[title]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('完成待办的后写更新清除手动进度，先回退目标，再随目标结算回退随机文案', () => {
    const h = makeHarness({ turnStatus: '正在交付', goal: goal() })
    const view = render(<ChatView {...h.props} />)
    act(() => { h.push({ turnStatus: null, todos: [{ content: '交付完成', status: 'completed' }] }) })
    expect(view.getByText('完成本轮验收')).toBeTruthy()
    act(() => { h.push({ goal: goal('complete') }) })
    expect(view.queryByText('完成本轮验收')).toBeNull()
    expect(view.getByText(zh['status.running'])).toBeTruthy()
  })

  it('投影未到达时显示随机文案，清除手动进度也可立即回退随机文案', () => {
    const h = makeHarness()
    const view = render(<ChatView {...h.props} />)
    expect(view.getByText(zh['status.running'])).toBeTruthy()
    act(() => { h.push({ turnStatus: '正在核对输入' }) })
    expect(view.getByText('正在核对输入')).toBeTruthy()
    act(() => { h.push({ turnStatus: null, todos: [], goal: null }) })
    expect(view.queryByText('正在核对输入')).toBeNull()
    expect(view.getByText(zh['status.running'])).toBeTruthy()
  })

  it('运行结束时隐藏活动行，即使还有已投影的进度', () => {
    const h = makeHarness({ turnStatus: '正在检查', todos: [{ content: '检查结果', status: 'in_progress' }] })
    const view = render(<ChatView {...h.props} />)
    expect(view.getByText('正在检查')).toBeTruthy()
    act(() => { h.setRunning(false) })
    expect(view.queryByRole('status')).toBeNull()
    act(() => { h.push({ turnStatus: null, todos: null }) })
    act(() => { h.setRunning(true) })
    expect(view.getByText(zh['status.running'])).toBeTruthy()
  })
})
