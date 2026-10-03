// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionId, SessionListState, SessionSummary, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  SubagentCatalogAction, type SubagentCatalogActionProps,
} from '../src/client/SubagentCatalogAction.tsx'
import { SubagentReadOnlyComposer } from '../src/client/SubagentReadOnlyComposer.tsx'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const PARENT = 'parent' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId
const t: SubagentCatalogActionProps['t'] = makeTranslate(zh)

function catalog(over: Partial<SubagentCatalogSnapshot> = {}): SubagentCatalogSnapshot {
  return {
    entries: [
      { kind: 'child', id: CHILD, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
      { kind: 'child', id: 'child-2' as SessionId, mode: 'one-shot', label: 'reviewer', activity: 'inactive', hasChildren: false },
      { kind: 'diagnostic', id: 'bad' as SessionId, reason: 'corrupt' },
    ],
    parentAvailable: true, state: 'ready', error: null, ...over,
  }
}

function summary(id: SessionId, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 1, ...over }
}

function props(
  value: SubagentCatalogSnapshot | undefined,
  nested: Readonly<Record<SessionId, SubagentCatalogSnapshot>> = {},
  summaries?: Readonly<Record<SessionId, SessionSummary>>,
): SubagentCatalogActionProps {
  const state = {
    ids: [CHILD],
    byId: summaries ?? { [CHILD]: summary(CHILD, { title: '正在扫描项目文件', running: true }) },
    current: PARENT, phase: 'ready',
    subagentsByParent: value === undefined ? nested : { [PARENT]: value, ...nested },
    jobsBySession: {}, currentAddress: undefined,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T { return select(state) }
  return {
    sessionId: PARENT, useSessions, openChild: vi.fn(), refresh: vi.fn(),
    setCatalogOpen: vi.fn(), collapse: vi.fn(), t,
  } as unknown as SubagentCatalogActionProps
}

describe('overview subagent catalog', () => {
  it('renders direct rows, diagnostic and navigates by the exact child address', () => {
    const input = props(catalog())
    render(<SubagentCatalogAction {...input} />)
    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, true)
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByText('正在扫描项目文件 · 可继续 · 正在运行')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /会话记录损坏/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: /展开 reviewer/ })).toBeNull()
    fireEvent.click(screen.getByRole('treeitem', { name: /worker/ }))
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    })
    expect(input.collapse).toHaveBeenCalledOnce()
    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, false)
  })

  it('supports tree keyboard traversal, disclosure and Escape delegated to its owner', () => {
    const input = props(catalog(), {
      [CHILD]: catalog({ entries: [{
        kind: 'child', id: GRANDCHILD, mode: 'continuable', label: 'indexer',
        activity: 'inactive', hasChildren: false,
      }] }),
    })
    render(<SubagentCatalogAction {...input} />)
    const worker = screen.getByRole('treeitem', { name: /worker/ })
    fireEvent.keyDown(worker, { key: 'ArrowRight' })
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, true)
    expect(screen.getByRole('treeitem', { name: /indexer/ }).getAttribute('aria-level')).toBe('2')
    fireEvent.keyDown(worker, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: /indexer/ })).toBeNull()
    fireEvent.keyDown(worker, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' })
    expect(document.activeElement).toBe(worker)
    fireEvent.keyDown(worker, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(input.collapse).toHaveBeenCalledOnce()
  })

  it('lazily loads known descendants and releases observed branches on unmount', () => {
    const input = props(catalog(), {}, {
      [GRANDCHILD]: summary(GRANDCHILD, { parentId: CHILD, origin: 'subagent', running: true }),
    })
    const view = render(<SubagentCatalogAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子代理' }))
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('treeitem', { name: '正在加载子代理' }).getAttribute('aria-level')).toBe('2')
    view.unmount()
    expect(input.setCatalogOpen).toHaveBeenCalledWith(PARENT, false)
    expect(input.setCatalogOpen).toHaveBeenCalledWith(CHILD, false)
  })

  it('keeps summary-backed loading rows and retries failed catalogs', () => {
    const summaries = {
      [CHILD]: summary(CHILD, { parentId: PARENT, origin: 'subagent' }),
    }
    const pending = props(undefined, {}, summaries)
    const view = render(<SubagentCatalogAction {...pending} />)
    expect(screen.getByRole('treeitem', { name: '正在加载子代理' })).toBeTruthy()
    view.rerender(<SubagentCatalogAction {...props(catalog({ entries: [] }), {}, summaries)} />)
    expect(screen.getByRole('treeitem', { name: '正在加载子代理' })).toBeTruthy()
    const failed = props(catalog({ entries: [], state: 'error', error: { code: 'internal', message: 'index down', details: {} } }))
    view.rerender(<SubagentCatalogAction {...failed} />)
    expect(screen.getByText('index down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(failed.refresh).toHaveBeenCalledWith(PARENT)
  })

  it('preserves exact token totals and active-turn duration', async () => {
    const now = 2_000_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const input = props(catalog({ entries: [{
      kind: 'child', id: CHILD, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: false,
    }] }), {}, {
      [CHILD]: summary(CHILD, {
        parentId: PARENT, origin: 'subagent', running: true,
        projectionValues: {
          tokenUsage: { uncachedInputTokens: 1_000, outputTokens: 200, cacheReadTokens: 3_000, cacheWriteTokens: 400 },
          subagentTiming: { settledMs: 65_000, active: { since: now - 5_000, through: now - 1_000 } },
        },
      }),
    })
    render(<SubagentCatalogAction {...input} />)
    const row = screen.getByRole('treeitem', { name: /worker.*4\.6K tok · 1分10秒/ })
    expect(within(row).getByText('4.6K tok').nextElementSibling?.textContent).toBe('1分10秒')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(screen.getByRole('treeitem', { name: /worker.*4\.6K tok · 1分11秒/ })).toBeTruthy()
  })
})

describe('SubagentReadOnlyComposer', () => {
  it('explains the exact missing-parent recovery path', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'parent-unavailable' }} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('父会话当前不在线')
  })
  it('explains that one-shot histories never accept follow-ups', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'one-shot' }} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('一次性任务不支持后续消息')
  })
})
