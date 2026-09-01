// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'
import { RemoteSshWizard } from '../src/client/WorkspacePicker.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

function workspace(): WorkspaceView {
  return {
    workspaceId: 'remote-workspace' as WorkspaceId,
    path: '/local/markers/remote-workspace',
    title: 'remote-workspace',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function installDesktop(overrides: Partial<Record<string, unknown>> = {}) {
  let emitProgress: ((payload: unknown) => void) | undefined
  const app = {
    RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })),
    RemoteSSHCancelConnect: vi.fn(async () => {}),
    RemoteSSHListDirectories: vi.fn(async () => ({
      path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
    })),
    RemoteSSHSelectDirectory: vi.fn(async () => ({
      markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding/project',
    })),
    RemoteSSHClose: vi.fn(async () => {}),
    RemoteSSHRejectHostKey: vi.fn(async () => {}),
    ...overrides,
  }
  vi.stubGlobal('__CODING_DESKTOP_BRIDGE_TOKEN', 'window-token')
  vi.stubGlobal('go', { main: { App: app } })
  vi.stubGlobal('runtime', {
    EventsOn: vi.fn((_name: string, listener: (payload: unknown) => void) => {
      emitProgress = listener
      return () => {}
    }),
  })
  return { app, emit: (payload: unknown) => { emitProgress?.(payload) } }
}

type CreateWorkspace = (input: { path: string }) => Promise<WorkspaceView>

function mount(createWorkspace?: CreateWorkspace) {
  const onClose = vi.fn()
  const onPick = vi.fn()
  const create = createWorkspace ?? vi.fn(async () => workspace())
  const wizard = (open: boolean) => (
    <RemoteSshWizard open={open} onClose={onClose} onPick={onPick} createWorkspace={create} t={t} />
  )
  const view = render(wizard(true))
  return {
    onClose,
    onPick,
    createWorkspace: create,
    rerenderOpen: (open: boolean) => { view.rerender(wizard(open)) },
    unmount: view.unmount,
  }
}

function enterSshConfig(): void {
  fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'dev.example.test' } })
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'coding' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'transient-only' } })
}

function connectAttemptId(connect: unknown, index = -1): string {
  const calls = (connect as { mock: { calls: unknown[][] } }).mock.calls
  const call = calls[index < 0 ? calls.length + index : index]
  return (call?.[1] as { attemptId: string }).attemptId
}

async function connectReady(): Promise<void> {
  enterSshConfig()
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy() })
}

async function openDirectory(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: '选择此文件夹' })).toBeTruthy() })
}

describe('RemoteSshWizard', () => {
  it('starts at SSH configuration, reports progress, and transfers a selected marker connection', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn(() => pendingConnect.promise),
      RemoteSSHListDirectories: vi.fn()
        .mockResolvedValueOnce({ path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }] })
        .mockResolvedValueOnce({ path: '/home/coding/project', entries: [] }),
    })
    const b = mount()
    expect(screen.getByRole('dialog', { name: '连接 Remote-SSH' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Remote-SSH 连接步骤' })).toBeTruthy()
    expect(within(screen.getByRole('navigation')).getByText('连接 Remote-SSH')).toBeTruthy()
    expect(screen.getByRole('list').children).toHaveLength(3)
    expect(screen.getByRole('heading', { name: '配置 SSH 连接' })).toBeTruthy()
    expect(screen.getByLabelText('主机')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Docker')

    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    let firstAttemptID = ''
    await waitFor(() => {
      expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledOnce()
      firstAttemptID = connectAttemptId(desktop.app.RemoteSSHConnect)
      expect(firstAttemptID).not.toBe('')
      expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledWith('window-token', {
        attemptId: firstAttemptID,
        host: 'dev.example.test', port: 22, username: 'coding',
        auth: { kind: 'password', secret: 'transient-only' },
        confirmationId: undefined,
        acceptHostKeyFingerprint: undefined,
      })
    })
    desktop.emit({ attemptId: firstAttemptID, phase: 'uploading', message: '正在上传安全 agent' })
    expect(await screen.findByText('正在上传安全 agent')).toBeTruthy()
    pendingConnect.resolve({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })
    await waitFor(() => { expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHListDirectories).toHaveBeenCalledWith('window-token', 'connection-1', '/home/coding') })
    fireEvent.click(await screen.findByRole('button', { name: 'project' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHListDirectories).toHaveBeenLastCalledWith('window-token', 'connection-1', '/home/coding/project') })
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHSelectDirectory).toHaveBeenCalledWith('window-token', 'connection-1', '/home/coding/project')
      expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' })
      expect(b.onPick).toHaveBeenCalledWith('remote-workspace')
    })
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
  })

  it('returns the opaque host-key confirmation id with the displayed fingerprint and fresh credentials', async () => {
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', confirmationId: 'confirmation-1',
          fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
        })
        .mockResolvedValueOnce({ kind: 'ready', connectionId: 'connection-1' }),
    })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByText(/此主机尚不在 known_hosts/)).toBeTruthy()
    expect(screen.getByText('ssh-ed25519: SHA256:verify-me')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '信任并继续' }))
    let secondAttemptID = ''
    await waitFor(() => {
      expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledTimes(2)
      secondAttemptID = connectAttemptId(desktop.app.RemoteSSHConnect, 1)
      expect(secondAttemptID).not.toBe('')
      expect(desktop.app.RemoteSSHConnect).toHaveBeenLastCalledWith('window-token', {
        attemptId: secondAttemptID,
        host: 'dev.example.test', port: 22, username: 'coding',
        auth: { kind: 'password', secret: 'transient-only' },
        confirmationId: 'confirmation-1',
        acceptHostKeyFingerprint: 'SHA256:verify-me',
      })
    })
    expect(secondAttemptID).not.toBe(connectAttemptId(desktop.app.RemoteSSHConnect, 0))
  })

  it('rejects the pending host-key id when its confirmation retry fails', async () => {
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', confirmationId: 'confirmation-1',
          fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
        })
        .mockResolvedValueOnce({ kind: 'error', message: 'confirmation failed' }),
    })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText(/此主机尚不在 known_hosts/)
    fireEvent.click(screen.getByRole('button', { name: '信任并继续' }))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHRejectHostKey).toHaveBeenCalledWith('window-token', 'confirmation-1')
      expect(screen.getByText('confirmation failed')).toBeTruthy()
    })
  })

  it.each([
    ['the Reject action', '拒绝', false],
    ['the Back action', '返回', false],
    ['dialog dismissal', '关闭', true],
  ])('rejects a pending host key through %s', async (_case, action, closes) => {
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn(async () => ({
        kind: 'host-key-confirmation', confirmationId: 'confirmation-1',
        fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
      })),
    })
    const b = mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText(/此主机尚不在 known_hosts/)
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHRejectHostKey).toHaveBeenCalledWith('window-token', 'confirmation-1')
    })
    expect(b.onClose).toHaveBeenCalledTimes(closes ? 1 : 0)
  })

  it('cancels a native attempt on Back and closes a ready result that arrives stale', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ RemoteSSHConnect: vi.fn(() => pendingConnect.promise) })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledOnce() })
    const attemptId = connectAttemptId(desktop.app.RemoteSSHConnect)
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHCancelConnect).toHaveBeenCalledWith('window-token', attemptId) })
    expect(screen.getByText('配置 SSH 连接')).toBeTruthy()

    pendingConnect.resolve({ kind: 'ready', connectionId: 'stale-connection' })
    await waitFor(() => {
      expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'stale-connection')
    })
  })

  it('rejects a confirmation returned after the dialog was dismissed', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ RemoteSSHConnect: vi.fn(() => pendingConnect.promise) })
    const b = mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledOnce() })
    const attemptId = connectAttemptId(desktop.app.RemoteSSHConnect)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(b.onClose).toHaveBeenCalledOnce()
    await waitFor(() => { expect(desktop.app.RemoteSSHCancelConnect).toHaveBeenCalledWith('window-token', attemptId) })

    pendingConnect.resolve({
      kind: 'host-key-confirmation', confirmationId: 'stale-confirmation',
      fingerprint: 'SHA256:stale', algorithm: 'ssh-ed25519',
    })
    await waitFor(() => {
      expect(desktop.app.RemoteSSHRejectHostKey).toHaveBeenCalledWith('window-token', 'stale-confirmation')
    })
  })

  it('closes a connected attempt before returning to configuration and reconnecting', async () => {
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn()
        .mockResolvedValueOnce({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })
        .mockResolvedValueOnce({ kind: 'ready', connectionId: 'connection-2', homePath: '/home/coding' }),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'connection-1')
    })

    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy()
    })
    expect(desktop.app.RemoteSSHClose).toHaveBeenCalledTimes(1)
  })

  it.each(['external close', 'unmount'])('closes an owned connection on %s', async (action) => {
    const desktop = installDesktop()
    const b = mount()
    await connectReady()
    if (action === 'external close') b.rerenderOpen(false)
    else b.unmount()
    await waitFor(() => {
      expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'connection-1')
    })
  })

  it('completes Workspace creation when directory selection commits after external close', async () => {
    const pendingSelection = deferred<unknown>()
    const createWorkspace = vi.fn(async () => workspace())
    const desktop = installDesktop({ RemoteSSHSelectDirectory: vi.fn(() => pendingSelection.promise) })
    const b = mount(createWorkspace)
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHSelectDirectory).toHaveBeenCalledOnce() })
    b.rerenderOpen(false)
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
    pendingSelection.resolve({ markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding' })
    await pendingSelection.promise
    await waitFor(() => { expect(createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' }) })
    expect(b.onPick).not.toHaveBeenCalled()
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
  })

  it('releases a selection-owned connection after external close when marker publication fails', async () => {
    const pendingSelection = deferred<unknown>()
    const desktop = installDesktop({ RemoteSSHSelectDirectory: vi.fn(() => pendingSelection.promise) })
    const b = mount()
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHSelectDirectory).toHaveBeenCalledOnce() })

    b.rerenderOpen(false)
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
    pendingSelection.reject(new Error('selection failed'))
    await waitFor(() => {
      expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'connection-1')
    })
  })

  it('keeps a reopened connection owned when an older directory selection settles', async () => {
    const pendingSelection = deferred<unknown>()
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn()
        .mockResolvedValueOnce({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })
        .mockResolvedValueOnce({ kind: 'ready', connectionId: 'connection-2', homePath: '/home/coding' }),
      RemoteSSHSelectDirectory: vi.fn(() => pendingSelection.promise),
    })
    const b = mount()
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHSelectDirectory).toHaveBeenCalledWith('window-token', 'connection-1', '/home/coding') })

    b.rerenderOpen(false)
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
    b.rerenderOpen(true)
    await waitFor(() => { expect(screen.getByLabelText('主机')).toBeTruthy() })
    await connectReady()

    pendingSelection.resolve({ markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding' })
    await waitFor(() => { expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' }) })
    await openDirectory()
    await waitFor(() => { expect(desktop.app.RemoteSSHListDirectories).toHaveBeenLastCalledWith('window-token', 'connection-2', '/home/coding') })

    b.rerenderOpen(false)
    await waitFor(() => { expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'connection-2') })
  })

  it('does not release a marker-owned connection while Workspace creation finishes after external close', async () => {
    const pendingWorkspace = deferred<WorkspaceView>()
    const createWorkspace = vi.fn(() => pendingWorkspace.promise)
    const desktop = installDesktop()
    const b = mount(createWorkspace)
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(createWorkspace).toHaveBeenCalledOnce() })

    b.rerenderOpen(false)
    await Promise.resolve()
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
    pendingWorkspace.resolve(workspace())
    await pendingWorkspace.promise
    await Promise.resolve()
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('prevents dismissal while marker selection and Workspace creation are in flight', async () => {
    const pendingWorkspace = deferred<WorkspaceView>()
    const createWorkspace = vi.fn(() => pendingWorkspace.promise)
    const desktop = installDesktop()
    const b = mount(createWorkspace)
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(createWorkspace).toHaveBeenCalledOnce() })

    const close = screen.getByRole<HTMLButtonElement>('button', { name: '关闭' })
    expect(close.disabled).toBe(true)
    fireEvent.click(close)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.onClose).not.toHaveBeenCalled()

    pendingWorkspace.resolve(workspace())
    await waitFor(() => {
      expect(b.onPick).toHaveBeenCalledWith('remote-workspace')
      expect(b.onClose).toHaveBeenCalledOnce()
    })
    expect(desktop.app.RemoteSSHClose).not.toHaveBeenCalled()
  })

  it('ignores progress events after a connect result has settled', async () => {
    const desktop = installDesktop()
    mount()
    await connectReady()
    desktop.emit({ attemptId: connectAttemptId(desktop.app.RemoteSSHConnect), phase: 'failed', message: 'stale failure' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy()
  })

  it('keeps a Windows drive root in place when the directory picker moves up', async () => {
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1', homePath: 'C:\\' })),
      RemoteSSHListDirectories: vi.fn(async () => ({ path: 'C:\\', entries: [] })),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHListDirectories).toHaveBeenCalledWith('window-token', 'connection-1', 'C:\\') })
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    expect(desktop.app.RemoteSSHListDirectories).toHaveBeenLastCalledWith('window-token', 'connection-1', 'C:\\')
  })

  it('keeps a Windows UNC share root in place when the directory picker moves up', async () => {
    const remoteRoot = '\\\\server\\share'
    const desktop = installDesktop({
      RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1', homePath: remoteRoot })),
      RemoteSSHListDirectories: vi.fn(async () => ({ path: remoteRoot, entries: [] })),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.app.RemoteSSHListDirectories).toHaveBeenCalledWith('window-token', 'connection-1', remoteRoot) })
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    expect(desktop.app.RemoteSSHListDirectories).toHaveBeenLastCalledWith('window-token', 'connection-1', remoteRoot)
  })

  it('does not offer an HTTP fallback when the desktop bridge is unavailable', () => {
    mount()
    expect(screen.getByText('Remote-SSH 仅在 Coding 桌面端中可用。')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接' }).disabled).toBe(true)
    expect(document.body.textContent).not.toContain('://')
  })

  it('rejects a URL-like SSH host before invoking the bridge', () => {
    const desktop = installDesktop()
    mount()
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'scheme://host.example.test' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'coding' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'transient-only' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(screen.getByRole('alert').textContent).toBe('请输入主机名或 IP 地址，不要使用 URL。')
    expect(desktop.app.RemoteSSHConnect).not.toHaveBeenCalled()
  })
})
