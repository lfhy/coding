// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { RemoteSshWizard } from '../src/client/WorkspacePicker.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
  const remoteSSH = {
    connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: '/home/coding' })),
    cancelConnect: vi.fn(async () => {}),
    listDirectories: vi.fn(async () => ({
      path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
    })),
    selectDirectory: vi.fn(async () => ({
      markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding/project',
    })),
    close: vi.fn(async () => {}),
    rejectHostKey: vi.fn(async () => {}),
    subscribeProgress: vi.fn((listener: (payload: unknown) => void) => {
      emitProgress = listener
      return () => { emitProgress = undefined }
    }),
    ...overrides,
  }
  vi.stubGlobal('codingDesktop', { remoteSSH })
  return { remoteSSH, emit: (payload: unknown) => { emitProgress?.(payload) } }
}

type CreateWorkspace = (input: { path: string }) => Promise<WorkspaceView>

function mount(createWorkspace?: CreateWorkspace, translate: WorkspacePickerProps['t'] = t) {
  const onClose = vi.fn()
  const onPick = vi.fn()
  const create = createWorkspace ?? vi.fn(async () => workspace())
  const wizard = (open: boolean) => (
    <RemoteSshWizard open={open} onClose={onClose} onPick={onPick} createWorkspace={create} t={translate} />
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
  return (call?.[0] as { attemptId: string }).attemptId
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
  it.each([
    {
      translate: t,
      capabilities: ['文件读写编辑', '前后台 Bash', 'PTY', '搜索', 'Code Mode', 'LSP 不可用', 'SFTP 扩展', '远端沙箱'],
    },
    {
      translate: makeTranslate(en, commonEn),
      capabilities: ['file read/write/edit', 'foreground and background Bash', 'PTY', 'search', 'Code Mode', 'LSP', 'SFTP extensions', 'remote sandbox'],
    },
  ])('describes Basic capabilities and limits in both wizard steps', async ({ translate, capabilities }) => {
    installDesktop()
    mount(undefined, translate)
    const description = screen.getByText(translate('picker.remote.mode.basic.description')).textContent ?? ''
    for (const capability of capabilities) expect(description).toContain(capability)

    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.host')), { target: { value: 'dev.example.test' } })
    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.username')), { target: { value: 'coding' } })
    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.password')), { target: { value: 'transient-only' } })
    fireEvent.click(screen.getByRole('button', { name: translate('picker.remote.connect') }))
    fireEvent.click(await screen.findByRole('button', { name: translate('picker.remote.progress.continue') }))
    const directoryDescription = screen.getByText(translate('picker.remote.directory.basic.description')).textContent ?? ''
    for (const capability of capabilities) expect(directoryDescription).toContain(capability)
  })

  it.each([
    { translate: t, heading: '健康检查转发被拒绝', disconnected: '工作区尚未连接' },
    { translate: makeTranslate(en, commonEn), heading: 'Health-check forwarding denied', disconnected: 'workspace is not connected' },
  ])('shows localized forwarding guidance without leaking the native message', async ({ translate, heading, disconnected }) => {
    const nativeMessage = 'remote refused direct-tcpip; password=transient-only'
    const desktop = installDesktop({
      connect: vi.fn(async () => ({ kind: 'error', code: 'port-forwarding-denied', message: nativeMessage })),
    })
    mount(undefined, translate)
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(translate('picker.remote.mode.agent')) }))
    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.host')), { target: { value: 'dev.example.test' } })
    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.username')), { target: { value: 'coding' } })
    fireEvent.change(screen.getByLabelText(translate('picker.remote.field.password')), { target: { value: 'transient-only' } })
    fireEvent.click(screen.getByRole('button', { name: translate('picker.remote.connect') }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce() })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(heading)).toBeTruthy()
    expect(alert.textContent).toContain(disconnected)
    expect(screen.getByRole('heading', { name: translate('picker.remote.forwarding.heading') })).toBeTruthy()
    expect(screen.getByText(translate('picker.remote.forwarding.summary'))).toBeTruthy()
    for (const phase of ['authenticating', 'probing', 'uploading', 'starting'] as const) {
      expect(screen.getByText(translate(`picker.remote.forwarding.${phase}`))).toBeTruthy()
      expect(screen.queryByText(translate(`picker.remote.progress.${phase}`))).toBeNull()
    }
    for (const setting of ['AllowTcpForwarding', 'DisableForwarding', 'PermitOpen', 'Match User/Group', '127.0.0.1']) {
      expect(alert.textContent).toContain(setting)
    }
    expect(within(alert).getAllByRole('listitem')).toHaveLength(4)
    expect(alert).toBe(document.activeElement)
    expect(within(alert).getByRole('button', { name: translate('picker.remote.forwarding.back') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: translate('picker.remote.back') })).toBeNull()
    expect(alert.textContent).not.toContain(nativeMessage)
    expect(document.body.textContent).not.toContain('transient-only')
    expect(screen.queryByRole('button', { name: translate('picker.remote.progress.continue') })).toBeNull()
  })

  it('does not infer forwarding advice from unclassified SSH errors and clears it on retry', async () => {
    const desktop = installDesktop({ connect: vi.fn()
      .mockResolvedValueOnce({ kind: 'error', code: 'port-forwarding-denied', message: 'sensitive native detail' })
      .mockResolvedValueOnce({ kind: 'error', message: 'administratively prohibited direct-tcpip' }),
    })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByText('健康检查转发被拒绝')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回修改 SSH 配置' }))
    expect(screen.queryByText('健康检查转发被拒绝')).toBeNull()
    expect(screen.getByLabelText('主机')).toHaveProperty('value', 'dev.example.test')
    expect(screen.getByLabelText('用户名')).toHaveProperty('value', 'coding')
    expect(document.activeElement).toBe(screen.getByLabelText('主机'))
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText('administratively prohibited direct-tcpip')).toBeTruthy()
    expect(screen.queryByText('健康检查转发被拒绝')).toBeNull()
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '连接并启动远程 agent' })).toBeTruthy()
  })

  it('keeps the default basic mode free of agent phases and forwarding advice', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ connect: vi.fn(() => pendingConnect.promise) })
    mount()
    expect(screen.getByRole('radio', { name: /基础模式/ })).toHaveProperty('checked', true)
    expect(screen.getByText(/远程文件读写编辑、前后台 Bash、PTY、搜索及 Code Mode/)).toBeTruthy()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce() })
    expect(desktop.remoteSSH.connect).toHaveBeenCalledWith(expect.objectContaining({ mode: 'basic' }))
    const attemptId = connectAttemptId(desktop.remoteSSH.connect)
    desktop.emit({ attemptId, phase: 'uploading', message: '上传远程 agent' })
    desktop.emit({ attemptId, phase: 'starting', message: '启动远程 agent' })
    expect(screen.queryByText('上传远程 agent')).toBeNull()
    expect(screen.queryByText('启动远程 agent')).toBeNull()
    expect(screen.queryByText('正在上传远程 agent')).toBeNull()
    expect(screen.getByRole('heading', { name: '连接 SSH 与 SFTP' })).toBeTruthy()
    pendingConnect.resolve({ kind: 'ready', mode: 'basic', connectionId: 'basic-connection' })
    await waitFor(() => { expect(screen.getByText('SSH 与 SFTP 已就绪')).toBeTruthy() })
    await openDirectory()
    expect(screen.getByText(/写入依赖 SFTP 扩展；远端 Bash 不受远端沙箱保护/)).toBeTruthy()
  })

  it('does not show agent-only forwarding guidance for basic failures', async () => {
    installDesktop({ connect: vi.fn(async () => ({ kind: 'error', code: 'port-forwarding-denied', message: 'private native diagnostic' })) })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByText('基础模式不需要 TCP 转发；请检查 SSH/SFTP 连接。')).toBeTruthy()
    expect(screen.queryByText('健康检查转发被拒绝')).toBeNull()
    expect(document.body.textContent).not.toContain('private native diagnostic')
  })

  it('uses the matching desktop ready mode for the directory capability description', async () => {
    installDesktop({ connect: vi.fn(async () => ({ kind: 'ready', mode: 'agent', connectionId: 'agent-connection' })) })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(screen.getByText('远程 agent 已就绪')).toBeTruthy() })
    await openDirectory()
    expect(screen.getByText(/现有工具会通过 SSH 落到远端/)).toBeTruthy()
    expect(screen.queryByText(/写入依赖 SFTP 扩展/)).toBeNull()
  })

  it('does not expose an untrusted failed-progress message before the coded result arrives', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ connect: vi.fn(() => pendingConnect.promise) })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce() })
    desktop.emit({
      attemptId: connectAttemptId(desktop.remoteSSH.connect),
      phase: 'failed', message: 'password=transient-only; private path',
    })
    expect(document.body.textContent).not.toContain('password=transient-only')
    pendingConnect.resolve({ kind: 'error', code: 'port-forwarding-denied', message: 'private path' })
    expect(await screen.findByText('健康检查转发被拒绝')).toBeTruthy()
    expect(document.body.textContent).not.toContain('private path')
  })

  it('starts at SSH configuration, reports progress, and transfers a selected marker connection', async () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({
      connect: vi.fn(() => pendingConnect.promise),
      listDirectories: vi.fn()
        .mockResolvedValueOnce({ path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }] })
        .mockResolvedValueOnce({ path: '/home/coding/project', entries: [] }),
    })
    const b = mount()
    expect(screen.getByRole('dialog', { name: '远程连接' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '远程连接步骤' })).toBeTruthy()
    expect(within(screen.getByRole('navigation')).getByText('远程连接')).toBeTruthy()
    expect(screen.getByRole('list').children).toHaveLength(3)
    expect(screen.getByRole('heading', { name: '配置 SSH 连接' })).toBeTruthy()
    expect(screen.getByLabelText('主机')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Docker')

    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    let firstAttemptID = ''
    await waitFor(() => {
      expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce()
      firstAttemptID = connectAttemptId(desktop.remoteSSH.connect)
      expect(firstAttemptID).not.toBe('')
      expect(desktop.remoteSSH.connect).toHaveBeenCalledWith({
        attemptId: firstAttemptID,
        mode: 'agent',
        host: 'dev.example.test', port: 22, username: 'coding',
        auth: { kind: 'password', secret: 'transient-only' },
        confirmationId: undefined,
        acceptHostKeyFingerprint: undefined,
      })
    })
    desktop.emit({ attemptId: firstAttemptID, phase: 'uploading', message: '正在上传安全 agent' })
    expect(await screen.findByText('正在上传安全 agent')).toBeTruthy()
    pendingConnect.resolve({ kind: 'ready', mode: 'agent', connectionId: 'connection-1', homePath: '/home/coding' })
    await waitFor(() => { expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.remoteSSH.listDirectories).toHaveBeenCalledWith('connection-1', '/home/coding') })
    fireEvent.click(await screen.findByRole('button', { name: 'project' }))
    await waitFor(() => { expect(desktop.remoteSSH.listDirectories).toHaveBeenLastCalledWith('connection-1', '/home/coding/project') })
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => {
      expect(desktop.remoteSSH.selectDirectory).toHaveBeenCalledWith('connection-1', '/home/coding/project')
      expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' })
      expect(b.onPick).toHaveBeenCalledWith('remote-workspace')
    })
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
    expect(persist.mock.calls.flat().join(' ')).not.toContain('transient-only')
  })

  it('returns the opaque host-key confirmation id with the displayed fingerprint and fresh credentials', async () => {
    const desktop = installDesktop({
      connect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', mode: 'agent', confirmationId: 'confirmation-1',
          fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
        })
        .mockResolvedValueOnce({ kind: 'ready', mode: 'agent', connectionId: 'connection-1' }),
    })
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByText(/此主机尚不在 known_hosts/)).toBeTruthy()
    expect(screen.getByText('ssh-ed25519: SHA256:verify-me')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '信任并继续' }))
    let secondAttemptID = ''
    await waitFor(() => {
      expect(desktop.remoteSSH.connect).toHaveBeenCalledTimes(2)
      secondAttemptID = connectAttemptId(desktop.remoteSSH.connect, 1)
      expect(secondAttemptID).not.toBe('')
      expect(desktop.remoteSSH.connect).toHaveBeenLastCalledWith({
        attemptId: secondAttemptID,
        mode: 'agent',
        host: 'dev.example.test', port: 22, username: 'coding',
        auth: { kind: 'password', secret: 'transient-only' },
        confirmationId: 'confirmation-1',
        acceptHostKeyFingerprint: 'SHA256:verify-me',
      })
    })
    expect(secondAttemptID).not.toBe(connectAttemptId(desktop.remoteSSH.connect, 0))
  })

  it('clears credentials, confirmation, errors, and progress when switching modes in configuration', async () => {
    const desktop = installDesktop({ connect: vi.fn(async () => ({
      kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
      fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
    })) })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText(/此主机尚不在 known_hosts/)
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => { expect(desktop.remoteSSH.rejectHostKey).toHaveBeenCalledWith('confirmation-1') })
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    expect(screen.getByLabelText('密码')).toHaveProperty('value', '')
    expect(screen.queryByText('ssh-ed25519: SHA256:verify-me')).toBeNull()
    expect(screen.queryByText('SSH 与 SFTP 已就绪')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '请输入认证信息。')
    fireEvent.click(screen.getByRole('radio', { name: /基础模式/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('radio', { name: /基础模式/ })).toHaveProperty('checked', true)
    expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce()
  })

  it('rejects the pending host-key id when its confirmation retry fails', async () => {
    const desktop = installDesktop({
      connect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
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
      expect(desktop.remoteSSH.rejectHostKey).toHaveBeenCalledWith('confirmation-1')
      expect(screen.getByText('confirmation failed')).toBeTruthy()
    })
  })

  it.each([
    ['the Reject action', '拒绝', false],
    ['the Back action', '返回', false],
    ['dialog dismissal', '关闭', true],
  ])('rejects a pending host key through %s', async (_case, action, closes) => {
    const desktop = installDesktop({
      connect: vi.fn(async () => ({
        kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
        fingerprint: 'SHA256:verify-me', algorithm: 'ssh-ed25519',
      })),
    })
    const b = mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByText(/此主机尚不在 known_hosts/)
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => {
      expect(desktop.remoteSSH.rejectHostKey).toHaveBeenCalledWith('confirmation-1')
    })
    expect(b.onClose).toHaveBeenCalledTimes(closes ? 1 : 0)
  })

  it('cancels a native attempt on Back and closes a ready result that arrives stale', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ connect: vi.fn(() => pendingConnect.promise) })
    mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce() })
    const attemptId = connectAttemptId(desktop.remoteSSH.connect)
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => { expect(desktop.remoteSSH.cancelConnect).toHaveBeenCalledWith(attemptId) })
    expect(screen.getByText('配置 SSH 连接')).toBeTruthy()

    pendingConnect.resolve({ kind: 'ready', mode: 'basic', connectionId: 'stale-connection' })
    await waitFor(() => {
      expect(desktop.remoteSSH.close).toHaveBeenCalledWith('stale-connection')
    })
  })

  it('rejects a confirmation returned after the dialog was dismissed', async () => {
    const pendingConnect = deferred<unknown>()
    const desktop = installDesktop({ connect: vi.fn(() => pendingConnect.promise) })
    const b = mount()
    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(desktop.remoteSSH.connect).toHaveBeenCalledOnce() })
    const attemptId = connectAttemptId(desktop.remoteSSH.connect)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(b.onClose).toHaveBeenCalledOnce()
    await waitFor(() => { expect(desktop.remoteSSH.cancelConnect).toHaveBeenCalledWith(attemptId) })

    pendingConnect.resolve({
      kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'stale-confirmation',
      fingerprint: 'SHA256:stale', algorithm: 'ssh-ed25519',
    })
    await waitFor(() => {
      expect(desktop.remoteSSH.rejectHostKey).toHaveBeenCalledWith('stale-confirmation')
    })
  })

  it('closes a connected attempt before returning to configuration and reconnecting', async () => {
    const desktop = installDesktop({
      connect: vi.fn()
        .mockResolvedValueOnce({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: '/home/coding' })
        .mockResolvedValueOnce({ kind: 'ready', mode: 'basic', connectionId: 'connection-2', homePath: '/home/coding' }),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => {
      expect(desktop.remoteSSH.close).toHaveBeenCalledWith('connection-1')
    })

    enterSshConfig()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => {
      expect(desktop.remoteSSH.connect).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy()
    })
    expect(desktop.remoteSSH.close).toHaveBeenCalledTimes(1)
  })

  it('does not carry an owned basic connection or credentials into agent mode', async () => {
    const desktop = installDesktop()
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => { expect(desktop.remoteSSH.close).toHaveBeenCalledWith('connection-1') })
    fireEvent.click(screen.getByRole('radio', { name: /Agent 模式/ }))
    expect(screen.getByLabelText('密码')).toHaveProperty('value', '')
    expect(screen.queryByText('SSH 与 SFTP 已就绪')).toBeNull()
    expect(screen.getByRole('radio', { name: /Agent 模式/ })).toHaveProperty('checked', true)
  })

  it.each(['external close', 'unmount'])('closes an owned connection on %s', async (action) => {
    const desktop = installDesktop()
    const b = mount()
    await connectReady()
    if (action === 'external close') b.rerenderOpen(false)
    else b.unmount()
    await waitFor(() => {
      expect(desktop.remoteSSH.close).toHaveBeenCalledWith('connection-1')
    })
  })

  it('completes Workspace creation when directory selection commits after external close', async () => {
    const pendingSelection = deferred<unknown>()
    const createWorkspace = vi.fn(async () => workspace())
    const desktop = installDesktop({ selectDirectory: vi.fn(() => pendingSelection.promise) })
    const b = mount(createWorkspace)
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.remoteSSH.selectDirectory).toHaveBeenCalledOnce() })
    b.rerenderOpen(false)
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
    pendingSelection.resolve({ markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding' })
    await pendingSelection.promise
    await waitFor(() => { expect(createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' }) })
    expect(b.onPick).not.toHaveBeenCalled()
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
  })

  it('releases a selection-owned connection after external close when marker publication fails', async () => {
    const pendingSelection = deferred<unknown>()
    const desktop = installDesktop({ selectDirectory: vi.fn(() => pendingSelection.promise) })
    const b = mount()
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.remoteSSH.selectDirectory).toHaveBeenCalledOnce() })

    b.rerenderOpen(false)
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
    pendingSelection.reject(new Error('selection failed'))
    await waitFor(() => {
      expect(desktop.remoteSSH.close).toHaveBeenCalledWith('connection-1')
    })
  })

  it('keeps a reopened connection owned when an older directory selection settles', async () => {
    const pendingSelection = deferred<unknown>()
    const desktop = installDesktop({
      connect: vi.fn()
        .mockResolvedValueOnce({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: '/home/coding' })
        .mockResolvedValueOnce({ kind: 'ready', mode: 'basic', connectionId: 'connection-2', homePath: '/home/coding' }),
      selectDirectory: vi.fn(() => pendingSelection.promise),
    })
    const b = mount()
    await connectReady()
    await openDirectory()
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    await waitFor(() => { expect(desktop.remoteSSH.selectDirectory).toHaveBeenCalledWith('connection-1', '/home/coding') })

    b.rerenderOpen(false)
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
    b.rerenderOpen(true)
    await waitFor(() => { expect(screen.getByLabelText('主机')).toBeTruthy() })
    await connectReady()

    pendingSelection.resolve({ markerPath: '/local/markers/remote-workspace', remotePath: '/home/coding' })
    await waitFor(() => { expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/local/markers/remote-workspace' }) })
    await openDirectory()
    await waitFor(() => { expect(desktop.remoteSSH.listDirectories).toHaveBeenLastCalledWith('connection-2', '/home/coding') })

    b.rerenderOpen(false)
    await waitFor(() => { expect(desktop.remoteSSH.close).toHaveBeenCalledWith('connection-2') })
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
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
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
    expect(desktop.remoteSSH.close).not.toHaveBeenCalled()
  })

  it('ignores progress events after a connect result has settled', async () => {
    const desktop = installDesktop()
    mount()
    await connectReady()
    desktop.emit({ attemptId: connectAttemptId(desktop.remoteSSH.connect), phase: 'failed', message: 'stale failure' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '选择远程目录' })).toBeTruthy()
  })

  it('keeps a Windows drive root in place when the directory picker moves up', async () => {
    const desktop = installDesktop({
      connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: 'C:\\' })),
      listDirectories: vi.fn(async () => ({ path: 'C:\\', entries: [] })),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.remoteSSH.listDirectories).toHaveBeenCalledWith('connection-1', 'C:\\') })
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    expect(desktop.remoteSSH.listDirectories).toHaveBeenLastCalledWith('connection-1', 'C:\\')
  })

  it('keeps a Windows UNC share root in place when the directory picker moves up', async () => {
    const remoteRoot = '\\\\server\\share'
    const desktop = installDesktop({
      connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: remoteRoot })),
      listDirectories: vi.fn(async () => ({ path: remoteRoot, entries: [] })),
    })
    mount()
    await connectReady()
    fireEvent.click(screen.getByRole('button', { name: '选择远程目录' }))
    await waitFor(() => { expect(desktop.remoteSSH.listDirectories).toHaveBeenCalledWith('connection-1', remoteRoot) })
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    expect(desktop.remoteSSH.listDirectories).toHaveBeenLastCalledWith('connection-1', remoteRoot)
  })

  it('does not offer an HTTP fallback when the desktop bridge is unavailable', () => {
    mount()
    expect(screen.getByText('远程连接仅在 Coding 桌面端中可用。')).toBeTruthy()
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
    expect(desktop.remoteSSH.connect).not.toHaveBeenCalled()
  })
})
