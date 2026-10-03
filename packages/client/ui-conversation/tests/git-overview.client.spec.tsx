// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { GitOverview, type GitOverviewInjected } from '../src/client/skeleton/GitOverview.tsx'
import { en, zh } from '../src/client/locales.ts'

const sessionId = 'git-session' as Parameters<GitOverviewInjected['status']>[0]
const git = { branch: 'main', ahead: 1, behind: 2, additions: 17, deletions: 4, files: [{ path: 'src/a.ts' }] }
const t = makeTranslate(zh)

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(overrides: Partial<GitOverviewInjected> = {}) {
  const actions: GitOverviewInjected = {
    status: vi.fn(async () => git),
    operate: vi.fn(async () => 'done' as const),
    resolveConflict: vi.fn(async () => {}),
    ...overrides,
  }
  const props = {
    sessionId,
    status: actions.status,
    operate: actions.operate,
    resolveConflict: actions.resolveConflict,
    t,
  } as Parameters<typeof GitOverview>[0]
  return { actions, view: render(<GitOverview {...props} />) }
}

describe('Git overview', () => {
  it('hides non-Git directories and displays file/line totals for repositories', async () => {
    const empty = fixture({ status: vi.fn(async () => null) })
    await waitFor(() => { expect(empty.actions.status).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('region', { name: 'Git 变更' })).toBeNull()
    empty.view.unmount()
    fixture()
    expect(await screen.findByRole('region', { name: 'Git 变更' })).toBeTruthy()
    expect(screen.getByText('1 个文件 · +17 / −4 行')).toBeTruthy()
    expect(screen.getByText('待推送 1 · 待拉取 2')).toBeTruthy()
  })

  it('keeps a long branch readable and labels the active operation', async () => {
    let finish!: (value: 'done') => void
    const operation = new Promise<'done'>((resolve) => { finish = resolve })
    fixture({
      status: vi.fn(async () => ({ ...git, branch: 'feature/long-running-overview-refinement' })),
      operate: vi.fn(() => operation),
    })
    const region = await screen.findByRole('region', { name: 'Git 变更' })
    const branch = screen.getByTitle('feature/long-running-overview-refinement')
    expect(region.contains(branch)).toBe(true)
    expect(screen.getByRole('heading', { name: 'Git 变更' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    expect(screen.getByRole('button', { name: '推送中…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '拉取' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { finish('done') })
    expect(screen.getByRole('status').textContent).toBe('Git 操作已完成')
  })

  it('pushes, pulls, and refreshes the working tree', async () => {
    const { actions } = fixture()
    await screen.findByRole('region', { name: 'Git 变更' })
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => { expect(actions.operate).toHaveBeenCalledWith(sessionId, 'push') })
    await screen.findByText('Git 操作已完成')
    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => { expect(actions.operate).toHaveBeenCalledWith(sessionId, 'pull') })
    expect(actions.status).toHaveBeenCalledTimes(3)
  })

  it('offers a new conflict-resolution session after a blocked pull', async () => {
    const actions = fixture({ operate: vi.fn(async () => 'conflict' as const) }).actions
    await screen.findByRole('region', { name: 'Git 变更' })
    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建会话解决冲突' }))
    await waitFor(() => { expect(actions.resolveConflict).toHaveBeenCalledWith(sessionId, zh['overview.git.solvePrompt']) })
  })

  it('shows operation errors without presenting the conflict action', async () => {
    fixture({ operate: vi.fn(async () => { throw new Error('no upstream') }) })
    await screen.findByRole('region', { name: 'Git 变更' })
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    expect((await screen.findByRole('alert')).textContent).toContain('no upstream')
    expect(screen.queryByRole('button', { name: '新建会话解决冲突' })).toBeNull()
    expect(makeTranslate(en)('overview.git.push')).toBe('Push')
  })
})
