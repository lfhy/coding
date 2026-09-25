import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}))
vi.mock('electron', () => electron)

import { installRemoteIpc, type RemoteIpcHelper } from '../src/remote-ipc.ts'

const origin = 'http://127.0.0.1:45123'

function fixture() {
  const windowEvents = new EventEmitter()
  const contentsEvents = new EventEmitter()
  const frame = { url: `${origin}/`, isDestroyed: vi.fn(() => false) }
  const contents = Object.assign(contentsEvents, {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  })
  const window = Object.assign(windowEvents, {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
  }) as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const request = vi.fn(async (_method: string, _payload: unknown, _signal?: AbortSignal): Promise<unknown> => ({ kind: 'ready' }))
  let progress: ((value: { attemptId: string; phase: string; message: string }) => void) | undefined
  const stopProgress = vi.fn()
  const helper: RemoteIpcHelper = {
    request,
    onProgress(listener) { progress = listener; return stopProgress },
  }
  installRemoteIpc({ window, origin, helper })
  const handler = electron.ipcMain.handle.mock.lastCall?.[1] as
    (event: IpcMainInvokeEvent, method: unknown, payload: unknown) => Promise<unknown>
  return { window, contents, frame, event, handler, request, stopProgress, emitProgress: (value: unknown) => {
    progress?.(value as { attemptId: string; phase: string; message: string })
  } }
}

function connect() {
  return { attemptId: 'attempt-1', host: 'example.com', port: 22, username: 'coding', auth: { kind: 'password', secret: 'only-in-helper' } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function reload(contents: EventEmitter & { mainFrame: { url: string } }): void {
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/fresh` })
  contents.mainFrame.url = `${origin}/fresh`
  contents.emit('did-finish-load')
}

describe('Remote-SSH Electron 主进程 IPC', () => {
  beforeEach(() => vi.clearAllMocks())

  it('只将六个固定方法映射到 helper wire，保持一次性 secret', async () => {
    const { event, handler, request } = fixture()
    const calls = [
      ['connect', connect(), 'RemoteSSHConnect'],
      ['cancelConnect', { attemptId: 'attempt-1' }, 'RemoteSSHCancelConnect'],
      ['listDirectories', { connectionId: 'connection-1', path: '/srv' }, 'RemoteSSHListDirectories'],
      ['close', { connectionId: 'connection-1' }, 'RemoteSSHClose'],
      ['rejectHostKey', { confirmationId: 'confirmation-1' }, 'RemoteSSHRejectHostKey'],
    ] as const
    for (const [method, payload, wireMethod] of calls) {
      await expect(handler(event, method, payload)).resolves.toEqual({ kind: 'ready' })
      const helperPayload = method === 'listDirectories'
        ? { connectionId: 'connection-1', remotePath: '/srv' } : payload
      expect(request).toHaveBeenLastCalledWith(wireMethod, helperPayload,
        method === 'connect' ? undefined : expect.any(AbortSignal))
    }
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('coding:remote-ssh', expect.any(Function))
    expect(electron.ipcMain.handle).toHaveBeenCalledTimes(1)
  })

  it('跨窗口、subframe、旧 origin 以及伪装 URL 在调用 helper 前拒绝', async () => {
    const { event, handler, frame, request } = fixture()
    await expect(handler({ ...event, sender: {} } as IpcMainInvokeEvent, 'connect', connect())).rejects.toThrow('unauthorized')
    await expect(handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, 'connect', connect())).rejects.toThrow('unauthorized')
    for (const url of [
      'http://127.0.0.1:45124/', 'http://localhost:45123/',
      'http://127.0.0.1:45123.evil.test/', 'http://username@127.0.0.1:45123/',
      'http://0x7f000001:45123/',
    ]) {
      frame.url = url
      await expect(handler(event, 'connect', connect())).rejects.toThrow('unauthorized')
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('拒绝未知方法、额外字段、无效连接输入以及畸形路径', async () => {
    const { event, handler, request } = fixture()
    for (const [method, payload] of [
      ['shutdown', {}], ['invoke', { channel: 'arbitrary' }],
      ['connect', { ...connect(), secret: 'extra' }],
      ['connect', { ...connect(), port: 0 }],
      ['connect', { ...connect(), host: 'example.com@127.0.0.1' }],
      ['connect', { ...connect(), auth: { kind: 'password', secret: '', extra: true } }],
      ['connect', { ...connect(), confirmationId: 'confirmation-1' }],
      ['connect', { ...connect(), acceptHostKeyFingerprint: 'SHA256:test' }],
      ['cancelConnect', { attemptId: '' }],
      ['close', { connectionId: 'connection-1', arbitrary: true }],
      ['listDirectories', { connectionId: 'connection-1', path: '/srv\0secrets' }],
      ['selectDirectory', { connectionId: 'connection-1', path: '' }],
      ['rejectHostKey', null],
    ] as const) {
      await expect(handler(event, method, payload), method).rejects.toThrow('Invalid Remote-SSH IPC request')
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('同源重载立即取消 Connect，但保留 raw ready 并在迟到后关闭连接', async () => {
    const { event, handler, contents, request, stopProgress, emitProgress } = fixture()
    const removedBeforeReload = electron.ipcMain.removeHandler.mock.calls.length
    const raw = deferred<unknown>()
    request.mockImplementationOnce(() => raw.promise)
    const pending = handler(event, 'connect', connect())
    const signal = request.mock.calls[0]?.[2]
    expect(signal).toBeUndefined()
    emitProgress({ attemptId: 'attempt-1', phase: 'authenticating', message: '' })
    expect(contents.send).toHaveBeenCalledWith('coding:remote-ssh-progress', {
      attemptId: 'attempt-1', phase: 'authenticating', message: '',
    })
    emitProgress({ attemptId: 'attempt-1', phase: 'failed', message: 'sensitive diagnostic' })
    expect(contents.send).toHaveBeenCalledTimes(1)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/fresh` })
    expect(request).toHaveBeenCalledWith('RemoteSSHCancelConnect', { attemptId: 'attempt-1' })
    await expect(handler(event, 'close', { connectionId: 'connection-1' })).rejects.toThrow('unauthorized')
    emitProgress({ attemptId: 'attempt-1', phase: 'ready', message: '' })
    expect(contents.send).toHaveBeenCalledTimes(1)
    contents.mainFrame.url = `${origin}/fresh`
    contents.emit('did-finish-load')
    await expect(handler(event, 'close', { connectionId: 'connection-1' })).resolves.toBeDefined()
    raw.resolve({ kind: 'ready', connectionId: 'late-connection' })
    await expect(pending).rejects.toThrow('expired')
    expect(request).toHaveBeenCalledWith('RemoteSSHClose', { connectionId: 'late-connection' })
    expect(stopProgress).not.toHaveBeenCalled()
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledTimes(removedBeforeReload)
    emitProgress({ attemptId: 'attempt-2', phase: 'ready', message: '' })
    expect(contents.send).toHaveBeenCalledTimes(2)
  })

  it('Connect raw confirmation 先到但导航在微任务前发生，仍拒绝 host key', async () => {
    const { event, handler, contents, request } = fixture()
    const raw = deferred<unknown>()
    request.mockImplementationOnce(() => raw.promise)
    const pending = handler(event, 'connect', connect())
    raw.resolve({ kind: 'host-key-confirmation', confirmationId: 'late-confirmation' })
    reload(contents)
    await expect(pending).rejects.toThrow('expired')
    expect(request).toHaveBeenCalledWith('RemoteSSHCancelConnect', { attemptId: 'attempt-1' })
    expect(request).toHaveBeenCalledWith('RemoteSSHRejectHostKey', { confirmationId: 'late-confirmation' })
  })

  it('连接补偿失败只报告泛化未知状态，仍不交付旧结果', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { event, handler, contents, request } = fixture()
    const raw = deferred<unknown>()
    request.mockImplementation((method) => {
      if (method === 'RemoteSSHConnect') return raw.promise
      return Promise.reject(new Error('sensitive native path and secret'))
    })
    const pending = handler(event, 'connect', connect())
    reload(contents)
    raw.resolve({ kind: 'ready', connectionId: 'late-connection' })
    await expect(pending).rejects.toThrow('expired')
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledTimes(2) })
    expect(warning.mock.calls.flat().join(' ')).toBe('Remote-SSH connection state unknown after cleanup failure. Remote-SSH connection state unknown after cleanup failure.')
    warning.mockRestore()
  })

  it('Select 使用 main operationId，授权不变时 claim 后才交付结果', async () => {
    const { event, handler, request } = fixture()
    const claim = deferred<unknown>()
    request.mockImplementation(method => method === 'RemoteSSHClaimSelection' ? claim.promise
      : Promise.resolve({ kind: 'selected', markerPath: '/marker', remotePath: '/srv' }))
    const pending = handler(event, 'selectDirectory', { connectionId: 'connection-1', path: '/srv' })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    const operationId = (request.mock.calls[0]?.[1] as { operationId: string }).operationId
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(request.mock.calls[0]).toEqual(['RemoteSSHSelectUnclaimed', {
      operationId, connectionId: 'connection-1', remotePath: '/srv',
    }, undefined])
    expect(request).toHaveBeenCalledWith('RemoteSSHClaimSelection', { operationId })
    claim.resolve({ kind: 'claimed' })
    await expect(pending).resolves.toEqual({ markerPath: '/marker', remotePath: '/srv' })
    expect(request).not.toHaveBeenCalledWith('RemoteSSHRevokeUnclaimed', expect.anything())
  })

  it('Select 失效立即 revoke，raw 结果迟到时再次撤销且不得 claim', async () => {
    const { event, handler, contents, request } = fixture()
    const raw = deferred<unknown>()
    request.mockImplementation(method => method === 'RemoteSSHSelectUnclaimed'
      ? raw.promise : Promise.resolve({ kind: 'revoked' }))
    const pending = handler(event, 'selectDirectory', { connectionId: 'connection-1', path: '/srv' })
    const operationId = (request.mock.calls[0]?.[1] as { operationId: string }).operationId
    reload(contents)
    expect(request).toHaveBeenCalledWith('RemoteSSHRevokeUnclaimed', { operationId, connectionId: 'connection-1' })
    raw.resolve({ kind: 'selected', markerPath: '/marker', remotePath: '/srv' })
    await expect(pending).rejects.toThrow('expired')
    expect(request.mock.calls.filter(call => call[0] === 'RemoteSSHRevokeUnclaimed')).toHaveLength(2)
    expect(request).not.toHaveBeenCalledWith('RemoteSSHClaimSelection', expect.anything())
  })

  it('Select claim 期间失效，拒绝旧结果且不盲关连接或删除 marker', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { event, handler, contents, request } = fixture()
    const claim = deferred<unknown>()
    request.mockImplementation(method => method === 'RemoteSSHClaimSelection' ? claim.promise
      : Promise.resolve(method === 'RemoteSSHRevokeUnclaimed' ? { kind: 'revoked' }
        : { kind: 'selected', markerPath: '/marker', remotePath: '/srv' }))
    const pending = handler(event, 'selectDirectory', { connectionId: 'connection-1', path: '/srv' })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledWith('RemoteSSHClaimSelection', expect.anything()) })
    reload(contents)
    claim.resolve({ kind: 'claimed' })
    await expect(pending).rejects.toThrow('expired')
    expect(request).toHaveBeenCalledWith('RemoteSSHRevokeUnclaimed', expect.anything())
    expect(request).not.toHaveBeenCalledWith('RemoteSSHClose', expect.anything())
    expect(warning.mock.calls.flat().join(' ')).toBe('Remote-SSH selection state unknown after cleanup failure.')
    warning.mockRestore()
  })

  it('Select 未认领结果或非 claimed 状态不返回 marker', async () => {
    for (const outcome of [
      { select: { kind: 'revoked' }, claim: undefined },
      { select: { kind: 'selected', markerPath: '/marker', remotePath: '/srv' }, claim: { kind: 'pending' } },
      { select: { kind: 'selected', markerPath: '/marker', remotePath: '/srv' }, claim: { kind: 'missing' } },
      { select: { kind: 'selected', markerPath: '/marker', remotePath: '/srv' }, claim: { kind: 'revoked' } },
      { select: { kind: 'selected', markerPath: '/marker', remotePath: '/srv', extra: true }, claim: undefined },
    ]) {
      const { event, handler, request } = fixture()
      request.mockImplementation(method => Promise.resolve(method === 'RemoteSSHSelectUnclaimed'
        ? outcome.select : method === 'RemoteSSHClaimSelection' ? outcome.claim : { kind: 'revoked' }))
      await expect(handler(event, 'selectDirectory', { connectionId: 'connection-1', path: '/srv' }))
        .rejects.toThrow('selection state unknown')
      expect(request).toHaveBeenCalledWith('RemoteSSHRevokeUnclaimed', expect.anything())
    }
  })

  it('Select 撤销失败只报告泛化未知状态，不泄漏原生错误或返回 marker', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { event, handler, contents, request } = fixture()
    const raw = deferred<unknown>()
    request.mockImplementation(method => method === 'RemoteSSHSelectUnclaimed' ? raw.promise
      : Promise.reject(new Error('sensitive native path and secret')))
    const pending = handler(event, 'selectDirectory', { connectionId: 'connection-1', path: '/srv' })
    reload(contents)
    raw.resolve({ kind: 'selected', markerPath: '/marker', remotePath: '/srv' })
    await expect(pending).rejects.toThrow('expired')
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledTimes(2) })
    expect(warning.mock.calls.flat().join(' ')).toBe('Remote-SSH selection state unknown after cleanup failure. Remote-SSH selection state unknown after cleanup failure.')
    warning.mockRestore()
  })

  it('跨源导航永久撤销，而子 frame 与同文档导航不撤权', async () => {
    const old = fixture()
    old.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://example.com/' })
    old.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: `${origin}/#fragment` })
    await expect(old.handler(old.event, 'close', { connectionId: 'connection-1' })).resolves.toBeDefined()
    old.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/' })
    old.frame.url = `${origin}/returned`
    old.contents.emit('did-finish-load')
    await expect(old.handler(old.event, 'close', { connectionId: 'connection-1' })).rejects.toThrow('unauthorized')
    expect(old.stopProgress).toHaveBeenCalledOnce()
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith('coding:remote-ssh')
  })

  it('替换安装与窗口关闭会撤掉旧监听', async () => {
    const old = fixture()
    const current = fixture()
    expect(old.stopProgress).toHaveBeenCalledOnce()
    await expect(old.handler(old.event, 'close', { connectionId: 'connection-1' })).rejects.toThrow('unauthorized')
    ;(current.window as unknown as EventEmitter).emit('closed')
    expect(current.stopProgress).toHaveBeenCalledOnce()
    await expect(current.handler(current.event, 'close', { connectionId: 'connection-1' })).rejects.toThrow('unauthorized')
  })

  it('拒绝未验证的 Host origin，不替换现有 handler', () => {
    const old = fixture()
    expect(() => installRemoteIpc({ window: old.window, origin: 'http://localhost:45123', helper: {
      request: vi.fn(), onProgress: vi.fn(() => () => {}),
    } })).toThrow('Invalid Remote-SSH Host origin')
    expect(old.stopProgress).not.toHaveBeenCalled()
  })
})
