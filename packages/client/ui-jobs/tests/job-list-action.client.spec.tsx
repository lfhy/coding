// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState, JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction, type JobListActionProps } from '../src/client/JobListAction.tsx'
import { zh } from '../src/client/locales.ts'

const SESSION = 'session' as SessionId
const START = 1_700_000_000_000
const t: JobListActionProps['t'] = makeTranslate(zh)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'bash-1' as JobView['id'], kind: 'bash', label: 'pnpm run build',
    status: 'running', startedAt: START, ...over,
  }
}

function props(jobs: readonly JobView[] | undefined, collapse = vi.fn()): JobListActionProps {
  const state = {
    ids: [SESSION], byId: {}, current: SESSION, phase: 'ready', subagentsByParent: {},
    jobsBySession: jobs === undefined ? {} : { [SESSION]: jobs }, currentAddress: undefined,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  return { sessionId: SESSION, useSessions, collapse, t } as unknown as JobListActionProps
}

function rowCells(): string[][] {
  return within(screen.getByRole('list', { name: zh['list.aria'] }))
    .queryAllByRole('listitem')
    .map(row => [...row.children].map(cell => cell.textContent ?? '').filter(Boolean))
}

describe('JobListAction overview rows', () => {
  it('keeps an empty list available to the overview row', () => {
    render(<JobListAction {...props(undefined)} />)
    expect(rowCells()).toEqual([])
  })

  it('orders live jobs by start, then settled jobs newest-first', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-3' as JobView['id'], label: 'old done', status: 'completed', startedAt: START, finishedAt: START + 1_000 }),
      job({ id: 'bash-4' as JobView['id'], label: 'new done', status: 'failed', startedAt: START, finishedAt: START + 9_000 }),
      job({ id: 'bash-2' as JobView['id'], label: 'later live', startedAt: START + 5_000 }),
      job({ id: 'bash-1' as JobView['id'], label: 'earlier live', startedAt: START }),
    ])} />)
    expect(rowCells()).toEqual([
      ['bash', 'earlier live', '运行中', '0秒'],
      ['bash', 'later live', '运行中', '0秒'],
      ['bash', 'new done', '已失败', '9秒'],
      ['bash', 'old done', '已完成', '1秒'],
    ])
  })

  it('breaks settled ties by start and prefers producer detail', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'second', status: 'killed', detail: 'signal: SIGTERM', startedAt: START + 10, finishedAt: START + 100 }),
      job({ id: 'bash-1' as JobView['id'], label: 'first', status: 'completed', startedAt: START, finishedAt: START + 100 }),
    ])} />)
    expect(rowCells().map(cells => cells[1])).toEqual(['first', 'second'])
    expect(rowCells()[1]).toContain('signal: SIGTERM')
  })

  it('shows all wire status words', () => {
    render(<JobListAction {...props([
      job({ id: '1' as JobView['id'], status: 'running' }),
      job({ id: '2' as JobView['id'], status: 'stopping' }),
      job({ id: '3' as JobView['id'], status: 'completed', finishedAt: START }),
      job({ id: '4' as JobView['id'], status: 'killed', finishedAt: START }),
      job({ id: '5' as JobView['id'], status: 'failed', finishedAt: START }),
    ])} />)
    expect(new Set(rowCells().map(cells => cells[2])))
      .toEqual(new Set(['运行中', '正在停止', '已完成', '已取消', '已失败']))
  })

  it('advances only live elapsed time', () => {
    vi.setSystemTime(START + 1_000)
    render(<JobListAction {...props([
      job({ id: '1' as JobView['id'], label: 'live' }),
      job({ id: '2' as JobView['id'], label: 'done', status: 'completed', finishedAt: START + 4_000 }),
    ])} />)
    expect(rowCells()[0]).toContain('1秒')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(rowCells()[0]).toContain('3秒')
    expect(rowCells()[1]).toContain('4秒')
  })

  it('formats minutes, hours and skewed clocks without a negative duration', () => {
    render(<JobListAction {...props([
      job({ id: '1' as JobView['id'], label: 'm', status: 'completed', finishedAt: START + 125_000 }),
      job({ id: '2' as JobView['id'], label: 'h', status: 'completed', finishedAt: START + 7_380_000 }),
      job({ id: '3' as JobView['id'], label: 'skew', status: 'completed', startedAt: START + 5_000, finishedAt: START }),
    ])} />)
    expect(rowCells().map(cells => cells[3])).toEqual(['2小时3分', '2分5秒', '0秒'])
  })

  it('only ticks when the expanded list contains live work', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const view = render(<JobListAction {...props([job({ status: 'completed', finishedAt: START })])} />)
    expect(interval).not.toHaveBeenCalled()
    view.rerender(<JobListAction {...props([job()])} />)
    expect(interval).toHaveBeenCalledTimes(1)
  })

  it('delegates Escape to the overview row and ignores other keys', () => {
    const collapse = vi.fn()
    render(<JobListAction {...props([job()], collapse)} />)
    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' })
    expect(collapse).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('list'), { key: 'Escape' })
    expect(collapse).toHaveBeenCalledOnce()
  })

  it('tolerates a settled job without finishedAt and keeps start-order fallback', () => {
    render(<JobListAction {...props([
      job({ id: '2' as JobView['id'], label: 'later', status: 'failed', startedAt: START + 1_000 }),
      job({ id: '1' as JobView['id'], label: 'earlier', status: 'failed', startedAt: START }),
    ])} />)
    expect(rowCells().map(cells => [cells[1], cells[3]]))
      .toEqual([['later', '0秒'], ['earlier', '0秒']])
  })
})
