// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { GitHistoryPanel } from '../src/client/GitHistoryPanel.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
const commit = (id: string, parents: string[] = []) => ({
  id, parents, subject: `提交 ${id.slice(0, 3)}`, author: 'Alice', authoredAt: '2026-01-01T01:02:03Z',
  refs: id.startsWith('a') ? ['main', 'v1.0'] : [],
})
const history = (commits: ReturnType<typeof commit>[], truncated = false) => ({
  commits, truncated, branches: ['main'], current: 'main',
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Git 提交树', () => {
  it('展示有界提交图、引用和按需详情，并能显式刷新', async () => {
    const load = vi.fn(async () => history([commit('aaaa', ['bbbb', 'cccc']), commit('bbbb', ['dddd']),
      commit('cccc', ['dddd']), commit('dddd')]))
    const clipboard = { writeText: vi.fn(async () => undefined) }
    vi.stubGlobal('navigator', { clipboard })
    render(<GitHistoryPanel shown history={load} t={t} />)
    await screen.findByText('提交 aaa')
    expect(load).toHaveBeenCalledExactlyOnceWith({ count: 60 }, expect.any(AbortSignal))
    expect(screen.getByRole('list', { name: zh['workbench.menu.review'] }).querySelectorAll('li')).toHaveLength(4)
    expect(screen.getAllByText('main')).toHaveLength(2)
    fireEvent.change(screen.getByRole('searchbox', { name: zh['history.search'] }), { target: { value: 'cccc' } })
    expect(screen.getByRole('list', { name: zh['workbench.menu.review'] }).querySelectorAll('li')).toHaveLength(1)
    fireEvent.change(screen.getByRole('searchbox', { name: zh['history.search'] }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '提交 aaa' }))
    expect(screen.getByRole('button', { name: '提交 aaa' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['history.copyHash'] }))
    await waitFor(() => { expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('aaaa') })
    fireEvent.click(screen.getByRole('button', { name: zh['history.refresh'] }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('区分非仓库、空仓库与请求失败，可在错误后重试', async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(history([]))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(history([commit('aaaa')]))
    render(<GitHistoryPanel shown history={load} t={t} />)
    await screen.findByText(zh['history.noRepository'])
    fireEvent.click(screen.getByRole('button', { name: zh['history.refresh'] }))
    await screen.findByText(zh['history.empty'])
    fireEvent.click(screen.getByRole('button', { name: zh['history.refresh'] }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: zh['history.retry'] }))
    await screen.findByText('提交 aaa')
  })

  it('只在可见时请求历史、取消旧请求，按用户动作扩展至上限', async () => {
    const requests: AbortSignal[] = []
    const load = vi.fn(async (_query: { count: number }, signal: AbortSignal) => {
      requests.push(signal)
      return history([commit('aaaa')], true)
    })
    const mounted = render(<GitHistoryPanel shown={false} history={load} t={t} />)
    expect(load).not.toHaveBeenCalled()
    mounted.rerender(<GitHistoryPanel shown history={load} t={t} />)
    await screen.findByText('提交 aaa')
    fireEvent.change(screen.getByRole('searchbox', { name: zh['history.search'] }), { target: { value: 'missing' } })
    expect(screen.getByText(zh['history.noMatches'])).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: zh['history.search'] }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: zh['history.more'] }))
    await waitFor(() => { expect(load).toHaveBeenLastCalledWith({ count: 120 }, expect.any(AbortSignal)) })
    expect(requests[0]?.aborted).toBe(true)
    mounted.rerender(<GitHistoryPanel shown={false} history={load} t={t} />)
    expect(requests.at(-1)?.aborted).toBe(true)
    mounted.unmount()
  })
})
