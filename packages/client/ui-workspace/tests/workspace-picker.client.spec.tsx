// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'
import { remoteHostUrl } from '../src/client/remote.ts'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const sessions: SessionListState = {
  ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
  startSessionWithoutWorkspace = vi.fn(async () => {}),
  connectRemote = vi.fn(),
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const { probe, renderSlot } = flowProbe()
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useWorkspaces={hook(workspaceState(nextItems))}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      startSessionWithoutWorkspace={startSessionWithoutWorkspace}
      connectRemote={connectRemote}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, startSessionWithoutWorkspace, connectRemote, probe, occupancy,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseAdd(): void {
  fireEvent.click(screen.getByRole('menuitem', { name: '打开文件夹' }))
}

describe('WorkspacePicker', () => {
  it('lists same-title Workspaces separately and forwards the selected id', () => {
    const b = mount([workspace('alpha', 'Shared'), workspace('beta', 'Shared')])
    const entries = screen.getAllByRole('menuitem', { name: 'Shared' })
    expect(entries).toHaveLength(2)
    fireEvent.click(entries[1]!)
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('filters the recent workspace list from the picker search field', () => {
    mount([workspace('alpha', 'Alpha'), workspace('beta', 'Beta')])
    fireEvent.change(screen.getByRole('textbox', { name: '搜索工作区' }), { target: { value: 'beta' } })
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeTruthy()
  })

  it('opens the remote dialog and forwards the supplied Host address', async () => {
    const b = mount()
    fireEvent.click(screen.getByRole('menuitem', { name: '远程连接' }))
    screen.getByRole('dialog', { name: '连接远程 Host' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Host 地址' }), { target: { value: 'http://127.0.0.1:4312' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(b.connectRemote).toHaveBeenCalledWith('http://127.0.0.1:4312') })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '连接远程 Host' })).toBeNull() })
  })

  it('keeps the remote dialog open and shows an address error when navigation is rejected', async () => {
    const connectRemote = vi.fn(async () => { throw new Error('目标 Host 无法访问') })
    mount([], vi.fn(), occupancySource(), vi.fn(async () => {}), connectRemote)
    fireEvent.click(screen.getByRole('menuitem', { name: '远程连接' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Host 地址' }), { target: { value: 'https://host.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('目标 Host 无法访问') })
    expect(screen.getByRole('dialog', { name: '连接远程 Host' })).toBeTruthy()
  })

  it('localizes a rejected remote address', async () => {
    const connectRemote = vi.fn((address: string) => { remoteHostUrl(address) })
    mount([], vi.fn(), occupancySource(), vi.fn(async () => {}), connectRemote)
    fireEvent.click(screen.getByRole('menuitem', { name: '远程连接' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Host 地址' }), { target: { value: 'ssh://host.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('远程 Host 仅支持 http 或 https 地址。') })
    expect(screen.getByRole('dialog', { name: '连接远程 Host' })).toBeTruthy()
  })

  it('starts an ungrouped session from the no-project action', async () => {
    const startSessionWithoutWorkspace = vi.fn(async () => {})
    const b = mount([], vi.fn(), occupancySource(), startSessionWithoutWorkspace)
    fireEvent.click(screen.getByRole('menuitem', { name: '不在项目中工作' }))
    await waitFor(() => { expect(startSessionWithoutWorkspace).toHaveBeenCalledOnce() })
    expect(b.onClose).toHaveBeenCalled()
  })

  it('shows a retryable error surface when the no-project session cannot start', async () => {
    const startSessionWithoutWorkspace = vi.fn(async () => { throw new Error('会话服务不可用') })
    mount([], vi.fn(), occupancySource(), startSessionWithoutWorkspace)
    fireEvent.click(screen.getByRole('menuitem', { name: '不在项目中工作' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('会话服务不可用') })
    expect(screen.getByRole('dialog', { name: '无法开始会话' })).toBeTruthy()
  })

  it('opens the composed directory flow, adopts its picked path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const b = mount([workspace('alpha', 'Alpha')], createWorkspace)
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    chooseAdd()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    await act(async () => { b.probe.owner!.onPicked('/tmp/project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    // Successful adoption withdraws the flow request.
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('keeps the chooser open when no workspace is listed, exposing every start path', () => {
    const b = mount([])
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '打开文件夹' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '远程连接' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '不在项目中工作' })).toBeTruthy()
    expect(b.onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('treats flow cancellation as a silent no-op', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a non-Error adoption failure in the folder-error surface', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw 'permission denied' }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('permission denied')
    expect(b.probe.owner!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(b.probe.owner!.open).toBe(true)
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables every menu action from flow open through adoption, and reports busy to the flow', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    // The flow is open but nothing is picked yet: a chooser pending on the
    // host display must already block concurrent workspace actions.
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '打开文件夹' }).disabled).toBe(true)
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '打开文件夹' }).disabled).toBe(true)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('shows the flow-reported failure in the folder-error surface', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes the folder-error surface when the user cancels', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([workspace('alpha', 'Alpha')]))}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        startSessionWithoutWorkspace={vi.fn(async () => {})} connectRemote={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu up while the list baseline is still in flight', () => {
    const state: WorkspaceListState = {
      ...workspaceState([]), phase: 'pending', state: 'loading', baselinesReady: false,
    }
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        startSessionWithoutWorkspace={vi.fn(async () => {})} connectRemote={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    // An empty list is not final yet: jumping into the directory flow here
    // would pre-empt the workspaces about to arrive.
    expect(screen.getByRole('status').textContent).toBe('正在加载工作区…')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(screen.getByRole('menuitem', { name: '打开文件夹' })).toBeTruthy()
  })

  it('keeps remote and no-project actions available without a directory flow', () => {
    const b = mount([], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '打开文件夹' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '远程连接' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '不在项目中工作' })).toBeTruthy()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('holds the anchor gesture while an adoption is still settling', async () => {
    // The auto-open path obeys the same busy rule as the disabled menu entry:
    // an occupant that re-registers mid-adoption must not raise a second flow.
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    // The list empties under the still-settling adoption (the workspace was
    // deleted elsewhere), which would otherwise make add the only entry.
    act(() => { b.rerenderItems([]) })
    expect(b.createWorkspace).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('hides the folder action while the directory-flow hole is empty', () => {
    mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '打开文件夹' })).toBeNull()
  })

  it('shows the folder action when a flow package activates after the first paint', () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '打开文件夹' })).toBeNull()
    // Registration changes flow through the subscription, no re-render needed.
    act(() => { b.occupancy.flip(true) })
    expect(screen.getByRole('menuitem', { name: '打开文件夹' })).toBeTruthy()
  })

  it('keeps Choose again inert while the flow occupant is gone, and snaps back a flow opened over an empty hole', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw new Error('adoption failed') }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy() })
    // The occupant unloads while the error dialog is up: retrying would open
    // a flow nobody can serve or cancel, so the button goes inert.
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新选择' }).disabled).toBe(true)
    // Cancel stays the way out, and the menu actions are usable again.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
  })

  it('withdraws an open flow when its occupant unloads, re-enabling the menu actions', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    // The flow plugin unloads mid-interaction (HMR): nobody is left to
    // cancel, so the owner withdraws and the actions come back.
    act(() => { b.occupancy.flip(false) })
    expect(b.probe.owner!.open).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: '打开文件夹' })).toBeNull()
  })
})
