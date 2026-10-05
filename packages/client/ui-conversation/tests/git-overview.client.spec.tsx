// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    branches: vi.fn(async () => ({ branches: ['main', 'feature/ui'], current: 'main' })),
    checkout: vi.fn<GitOverviewInjected['checkout']>(async (_sessionId, branch) => ({ ...git, branch })),
    operate: vi.fn(async () => 'done' as const),
    resolveConflict: vi.fn(async () => {}),
    ...overrides,
  }
  const props = { sessionId, ...actions, t } as Parameters<typeof GitOverview>[0]
  return { actions, view: render(<GitOverview {...props} />) }
}

async function openGit() {
  const row = await screen.findByRole('button', { name: /Git 变更/ })
  fireEvent.click(row)
  const id = row.getAttribute('aria-controls')
  if (!id) throw new Error('Missing Git popup id')
  const layer = document.getElementById(id)
  if (!layer) throw new Error('Missing Git popup')
  return layer
}

describe('Git overview', () => {
  it('hides non-Git directories; presents a full-width summary and a detached popup', async () => {
    const empty = fixture({ status: vi.fn(async () => null) })
    await waitFor(() => { expect(empty.actions.status).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('button', { name: /Git 变更/ })).toBeNull()
    empty.view.unmount()
    const { view } = fixture()
    const row = await screen.findByRole('button', { name: /Git 变更/ })
    expect(row.textContent).toContain('main')
    expect(row.querySelector('svg')).toBeTruthy()
    expect(view.container.contains(row)).toBe(true)
    expect(screen.queryByText('变更')).toBeNull()
    const layer = await openGit()
    expect(layer.parentElement).toBe(document.body)
    expect(view.container.contains(layer)).toBe(false)
    const branchSelector = within(layer).getByRole('button', { name: /切换分支/ })
    expect(branchSelector.textContent).toContain('main')
    expect(within(layer).getByText('变更').parentElement?.parentElement?.textContent).toContain('1 个文件')
    expect(within(layer).getByText('变更').parentElement?.querySelector('svg')).toBeTruthy()
    expect(within(layer).getByText('+17')).toBeTruthy()
    expect(within(layer).getByText('−4')).toBeTruthy()
    expect(within(layer).getByText('同步状态').parentElement?.querySelector('svg')).toBeTruthy()
    expect(within(layer).getByText('待推送 1 · 待拉取 2')).toBeTruthy()
    const push = within(layer).getByRole('button', { name: '推送' })
    const pull = within(layer).getByRole('button', { name: '拉取' })
    expect(push.parentElement).toBe(pull.parentElement)
    expect(push.querySelector('svg')).toBeTruthy()
    expect(pull.querySelector('svg')).toBeTruthy()
  })

  it('keeps a long branch readable and shows operation state in the popup', async () => {
    let finish!: (value: 'done') => void
    const operation = new Promise<'done'>((resolve) => { finish = resolve })
    fixture({ status: vi.fn(async () => ({ ...git, branch: 'feature/long-running-overview-refinement' })), operate: vi.fn(() => operation) })
    const region = await openGit()
    expect(within(region).getByTitle('feature/long-running-overview-refinement')).toBeTruthy()
    fireEvent.click(within(region).getByRole('button', { name: '推送' }))
    expect(within(region).getByRole('button', { name: '推送中…' }).hasAttribute('disabled')).toBe(true)
    expect(within(region).getByRole('button', { name: '拉取' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { finish('done') })
    expect(screen.getByRole('alert').textContent).toBe('Git 操作已完成')
    expect(within(region).queryByText('Git 操作已完成')).toBeNull()
  })

  it('hides empty change counts and switches between local branches without growing the card', async () => {
    const { actions, view } = fixture({ status: vi.fn(async () => ({ ...git, files: [], additions: 0, deletions: 0 })) })
    const layer = await openGit()
    const cardChildCount = view.container.querySelector('[data-overview-git]')?.childElementCount
    expect(within(layer).queryByText('变更')).toBeNull()
    fireEvent.click(within(layer).getByRole('button', { name: /切换分支/ }))
    const branchList = await screen.findByRole('group', { name: '本地分支' })
    expect(layer.contains(branchList)).toBe(true)
    expect(view.container.querySelector('[data-overview-git]')?.childElementCount).toBe(cardChildCount)
    expect(actions.branches).toHaveBeenCalledWith(sessionId)
    expect(within(layer).getByRole('button', { name: '推送' })).toBeTruthy()
    expect(within(layer).getByRole('button', { name: '拉取' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'feature/ui' }))
    await waitFor(() => { expect(actions.checkout).toHaveBeenCalledWith(sessionId, 'feature/ui') })
    expect((await screen.findByRole('button', { name: /Git 变更/ })).textContent).toContain('feature/ui')
    expect(screen.queryByRole('group', { name: '本地分支' })).toBeNull()
  })

  it('closes the popup on Escape and restores focus', async () => {
    fixture()
    const layer = await openGit()
    fireEvent.keyDown(layer, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /Git 变更/ })?.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('button', { name: /Git 变更/ })) })
  })

  it('preserves the branch and shows checkout rejection in the popup', async () => {
    fixture({ checkout: vi.fn(async () => { throw new Error('working tree is dirty') }) })
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: /切换分支/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'feature/ui' }))
    expect((await screen.findByRole('alert')).textContent).toContain('working tree is dirty')
    expect(screen.getByRole('button', { name: /Git 变更/ }).textContent).toContain('main')
  })

  it('pushes, pulls, refreshes status, and notifies outside the card', async () => {
    const { actions } = fixture()
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: '推送' }))
    await waitFor(() => { expect(actions.operate).toHaveBeenCalledWith(sessionId, 'push', undefined) })
    await screen.findByText('Git 操作已完成')
    fireEvent.click(within(layer).getByRole('button', { name: '拉取' }))
    await waitFor(() => { expect(actions.operate).toHaveBeenCalledWith(sessionId, 'pull', undefined) })
    expect(actions.status).toHaveBeenCalledTimes(3)
  })

  it('offers a new conflict-resolution session after a blocked pull', async () => {
    const actions = fixture({ operate: vi.fn(async () => 'conflict' as const) }).actions
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: '拉取' }))
    expect(await within(layer).findByRole('alert')).toBeTruthy()
    fireEvent.click(within(layer).getByRole('button', { name: '新建会话解决冲突' }))
    await waitFor(() => { expect(actions.resolveConflict).toHaveBeenCalledWith(sessionId, zh['overview.git.solvePrompt']) })
  })

  it('requests credentials in a page modal and retries only after explicit submission', async () => {
    const operate = vi.fn<GitOverviewInjected['operate']>(async (_id, _action, credentials) => credentials ? 'done' : { authRequired: 'example.com' })
    fixture({ operate })
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: '推送' }))
    const dialog = await screen.findByRole('dialog', { name: 'Git 账户验证' })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(screen.queryByRole('button', { name: /Git 变更/ })?.getAttribute('aria-expanded')).toBe('false')
    expect(within(dialog).getByText(/example.com/)).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '账户名' }), { target: { value: 'user' } })
    fireEvent.change(within(dialog).getByLabelText('密码或访问令牌'), { target: { value: 'secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续' }))
    await waitFor(() => { expect(operate).toHaveBeenCalledWith(sessionId, 'push', { username: 'user', password: 'secret' }) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Git 账户验证' })).toBeNull() })
    expect(screen.getByRole('alert').textContent).toBe('Git 操作已完成')
  })

  it('retains the modal on invalid credentials without retaining the password', async () => {
    fixture({ operate: vi.fn<GitOverviewInjected['operate']>(async (_id, _action, credentials) => {
      if (!credentials) return { authRequired: 'example.com' }
      throw new Error('Authentication failed')
    }) })
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: '拉取' }))
    const dialog = await screen.findByRole('dialog', { name: 'Git 账户验证' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '账户名' }), { target: { value: 'user' } })
    fireEvent.change(within(dialog).getByLabelText('密码或访问令牌'), { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Authentication failed')
    expect(within(dialog).getByLabelText<HTMLInputElement>('密码或访问令牌').value).toBe('')
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' })[1]!)
    expect(screen.queryByRole('dialog', { name: 'Git 账户验证' })).toBeNull()
  })

  it('shows operation errors in the popup rather than a conflict action', async () => {
    fixture({ operate: vi.fn(async () => { throw new Error('no upstream') }) })
    const layer = await openGit()
    fireEvent.click(within(layer).getByRole('button', { name: '推送' }))
    expect((await within(layer).findByRole('alert')).textContent).toContain('no upstream')
    expect(within(layer).queryByRole('button', { name: '新建会话解决冲突' })).toBeNull()
    expect(makeTranslate(en)('overview.git.push')).toBe('Push')
  })
})
