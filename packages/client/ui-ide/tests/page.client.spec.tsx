// @vitest-environment jsdom
/** 欢迎页的目录选择、最近工作区与失败反馈都通过现有目录流和 Toast。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IdePage, type IdePageProps } from '../src/client/IdePage.tsx'
import { zh } from '../src/client/locales.ts'
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import type { WorkspaceView } from 'coding-client-runtime/client'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function workspace(id: string, title: string, updatedAt: string, path = `/tmp/${id}`): WorkspaceView {
  return {
    workspaceId: id as WorkspaceView['workspaceId'], path, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt,
  }
}

function setup(items: WorkspaceView[] = [], phase: 'pending' | 'ready' = 'ready', state: 'idle' | 'loading' | 'error' = 'idle') {
  let flow: DirectoryFlowOwnerProps | undefined
  const createWorkspace = vi.fn(async (input: { path: string }) => workspace('created', input.path, '2026-01-02T00:00:00Z', input.path))
  const openWorkspace = vi.fn(async () => {})
  const leaveWorkspace = vi.fn()
  const closePage = vi.fn()
  const actions = new Proxy({}, { get: () => () => {} })
  const props = {
    closePage,
    useWorkspaces: (selector: (value: { items: readonly WorkspaceView[]; phase: 'pending' | 'ready'; state: 'idle' | 'loading' | 'error' }) => unknown) =>
      selector({ items, phase, state }),
    createWorkspace,
    openWorkspace,
    leaveWorkspace,
    // 欢迎页不读页面状态；给出空快照即可验证它只按工作区列表渲染。
    useIdeState: (selector: (value: { workspaceId: null; views: {}; sessions: {} }) => unknown) =>
      selector({ workspaceId: null, views: {}, sessions: {} }),
    actions,
    t: (key: keyof typeof zh, params?: Record<string, string | number>) => {
      const text = zh[key]
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
    },
    renderSlot: (_name: string, owner: DirectoryFlowOwnerProps) => {
      flow = owner
      return <div data-testid="directory-flow">{owner.open ? 'open' : 'closed'}</div>
    },
  }
  const view = render(<IdePage {...(props as unknown as IdePageProps)} />)
  return { view, createWorkspace, openWorkspace, closePage, flow: () => flow }
}

describe('代码工作区欢迎页', () => {
  it('优先显示最近工作区，且无工作区时只显示打开入口与空态', () => {
    const first = setup([
      workspace('old', '旧项目', '2026-01-01T00:00:00Z'),
      workspace('new', '新项目', '2026-01-03T00:00:00Z'),
    ])
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.openFolder })).toBeTruthy()
    const rows = screen.getAllByRole('button', { name: /新项目|旧项目/ })
    expect(rows[0]?.textContent).toContain('新项目')
    expect(rows[1]?.textContent).toContain('旧项目')
    first.view.unmount()

    setup()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.queryByText(zh.recent)).toBeNull()
  })

  it('远端工作区显示可读名称，不暴露本地占位路径', () => {
    const path = '/tmp/remote-workspaces/aaaaaaaaaaaaaaaaaaaa/remote-project-bbbbbbbbbbbbbbbbbbbb'
    setup([workspace('remote', '远端项目', '2026-01-02T00:00:00Z', path)])
    const row = screen.getByRole('button', { name: /远端项目/ })
    expect(row.textContent).toContain('remote-project')
    expect(row.textContent).not.toContain('aaaaaaaaaaaaaaaaaaaa')
  })

  it('取消目录选择只关闭弹层并保留欢迎页', () => {
    const fixture = setup()
    fireEvent.click(screen.getByRole('button', { name: zh.openFolder }))
    act(() => { fixture.flow()?.onCancel() })
    expect(screen.getByTestId('directory-flow').textContent).toBe('closed')
    expect(fixture.closePage).not.toHaveBeenCalled()
  })

  it('加载期间显示读取状态，不把空列表当成无工作区', () => {
    setup([], 'pending')
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    expect(screen.queryByText(zh.empty)).toBeNull()
  })

  it('读取失败时显示错误，不把失败当成无工作区', () => {
    setup([], 'ready', 'error')
    expect(screen.getByRole('alert').textContent).toBe(zh.error)
    expect(screen.queryByText(zh.empty)).toBeNull()
  })

  it('打开目录后创建并进入工作区；选择最近项也复用同一入口', async () => {
    const fixture = setup([workspace('recent', '最近项目', '2026-01-02T00:00:00Z')])
    fireEvent.click(screen.getByRole('button', { name: zh.openFolder }))
    expect(screen.getByTestId('directory-flow').textContent).toBe('open')
    fixture.flow()?.onPicked('/tmp/new-project')

    await waitFor(() => {
      expect(fixture.createWorkspace).toHaveBeenCalledWith({ path: '/tmp/new-project' })
      expect(fixture.openWorkspace).toHaveBeenCalledWith('created')
    })

    fireEvent.click(screen.getByRole('button', { name: /最近项目/ }))
    await waitFor(() => { expect(fixture.openWorkspace).toHaveBeenCalledWith('recent') })
  })

  it('目录流失败时保留欢迎页并用共享 Toast 告知', async () => {
    const fixture = setup()
    fireEvent.click(screen.getByRole('button', { name: zh.openFolder }))
    fixture.flow()?.onError('host unavailable')
    await screen.findByText(zh.workspaceError)
    expect(screen.getByTestId('directory-flow').textContent).toBe('closed')
  })

  it('创建或打开工作区失败时保留页面并解除忙碌状态', async () => {
    const fixture = setup([workspace('recent', '最近项目', '2026-01-02T00:00:00Z')])
    fixture.createWorkspace.mockRejectedValueOnce(new Error('create failed'))
    fireEvent.click(screen.getByRole('button', { name: zh.openFolder }))
    fixture.flow()?.onPicked('/tmp/new-project')
    await screen.findByText(zh.workspaceError)
    expect(screen.getByRole('button', { name: zh.openFolder })).toHaveProperty('disabled', false)

    fixture.openWorkspace.mockRejectedValueOnce(new Error('open failed'))
    fireEvent.click(screen.getByRole('button', { name: /最近项目/ }))
    await screen.findByText(zh.workspaceError)
    expect(screen.getByRole('button', { name: /最近项目/ })).toHaveProperty('disabled', false)
  })

  it('页面卸载后的异步拒绝不更新已释放组件', async () => {
    const fixture = setup([workspace('recent', '最近项目', '2026-01-02T00:00:00Z')])
    const pending = Promise.withResolvers<undefined>()
    fixture.openWorkspace.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: /最近项目/ }))
    fixture.view.unmount()
    pending.reject(new Error('late failure'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('连续错误更新 Toast 序号，到时后自动清除', () => {
    vi.useFakeTimers()
    const fixture = setup()
    act(() => { fixture.flow()?.onError('first') })
    expect(screen.getByRole('alert').textContent).toBe(zh.workspaceError)
    act(() => { fixture.flow()?.onError('second') })
    expect(screen.getByRole('alert').textContent).toBe(zh.workspaceError)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Escape 返回原界面，弹层打开时由弹层自己处理', () => {
    const fixture = setup()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(fixture.closePage).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh.openFolder }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(fixture.closePage).toHaveBeenCalledOnce()
  })

  it('Escape 忽略已处理事件和展开控件，文档目标仍可返回', () => {
    const fixture = setup()
    fireEvent.keyDown(document, { key: 'Enter' })
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    prevented.preventDefault()
    document.body.dispatchEvent(prevented)
    const expanded = document.createElement('button')
    expanded.setAttribute('aria-expanded', 'true')
    document.body.append(expanded)
    fireEvent.keyDown(expanded, { key: 'Escape' })
    expanded.remove()
    expect(fixture.closePage).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fixture.closePage).toHaveBeenCalledOnce()
  })
})
