// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRemoteSshBridge, RemoteSshBridgeError, RemoteSshConfigError,
  validateRemoteSshConfig,
} from '../src/client/remote.ts'

afterEach(() => { vi.unstubAllGlobals() })

const input = (overrides: Partial<Parameters<typeof validateRemoteSshConfig>[0]> = {}) => ({
  attemptId: 'attempt-1',
  host: 'dev.example.test',
  port: 22,
  username: 'coding',
  auth: { kind: 'password' as const, secret: 'transient-only' },
  ...overrides,
})

function installBridge(overrides: Partial<Record<string, unknown>> = {}) {
  let progressListener: ((value: unknown) => void) | undefined
  const app = {
    RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })),
    RemoteSSHCancelConnect: vi.fn(async () => {}),
    RemoteSSHListDirectories: vi.fn(async () => ({
      path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
    })),
    RemoteSSHSelectDirectory: vi.fn(async () => ({ markerPath: '/local/marker', remotePath: '/home/coding/project' })),
    RemoteSSHClose: vi.fn(async () => {}),
    RemoteSSHRejectHostKey: vi.fn(async () => {}),
    ...overrides,
  }
  const eventsOn = vi.fn((_name: string, listener: (value: unknown) => void) => {
    progressListener = listener
    return vi.fn()
  })
  vi.stubGlobal('__CODING_DESKTOP_BRIDGE_TOKEN', 'window-token')
  vi.stubGlobal('go', { main: { App: app } })
  vi.stubGlobal('runtime', { EventsOn: eventsOn })
  return { app, eventsOn, emit: (value: unknown) => { progressListener?.(value) } }
}

function installElectronBridge(overrides: Partial<Record<string, unknown>> = {}) {
  let progressListener: ((value: unknown) => void) | undefined
  const dispose = vi.fn(() => { progressListener = undefined })
  const remoteSSH = {
    connect: vi.fn(async () => ({ kind: 'ready', connectionId: 'electron-1' })),
    cancelConnect: vi.fn(async () => {}),
    listDirectories: vi.fn(async () => ({
      path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
    })),
    selectDirectory: vi.fn(async () => ({ markerPath: '/local/marker', remotePath: '/home/coding/project' })),
    close: vi.fn(async () => {}),
    rejectHostKey: vi.fn(async () => {}),
    subscribeProgress: vi.fn((listener: (value: unknown) => void) => {
      progressListener = listener
      return dispose
    }),
    ...overrides,
  }
  vi.stubGlobal('codingDesktop', { remoteSSH })
  return { remoteSSH, dispose, emit: (value: unknown) => { progressListener?.(value) } }
}

describe('validateRemoteSshConfig', () => {
  it('keeps a valid SSH input intact without normalizing it into a URL', () => {
    expect(validateRemoteSshConfig(input())).toEqual(input())
  })

  it.each([
    [input({ host: '' }), 'host'],
    [input({ host: 'scheme://host.example.test' }), 'host'],
    [input({ host: 'user@host.example.test' }), 'host'],
    [input({ port: 0 }), 'port'],
    [input({ port: 65_536 }), 'port'],
    [input({ port: 2.5 }), 'port'],
    [input({ username: 'coding user' }), 'username'],
    [input({ auth: { kind: 'privateKey', secret: '' } }), 'secret'],
  ] as const)('rejects invalid SSH field %s', (value, code) => {
    expect(() => validateRemoteSshConfig(value)).toThrow(RemoteSshConfigError)
    try {
      validateRemoteSshConfig(value)
    } catch (error) {
      expect(error).toMatchObject({ code })
    }
  })
})

describe('getRemoteSshBridge', () => {
  it('is absent during server rendering', () => {
    vi.stubGlobal('window', undefined)
    expect(getRemoteSshBridge()).toBeUndefined()
  })

  it('is absent outside an authorized desktop window', () => {
    expect(getRemoteSshBridge()).toBeUndefined()
    vi.stubGlobal('__CODING_DESKTOP_BRIDGE_TOKEN', 'window-token')
    expect(getRemoteSshBridge()).toBeUndefined()
    vi.stubGlobal('codingDesktop', { remoteSSH: { connect: vi.fn() } })
    expect(getRemoteSshBridge()).toBeUndefined()
  })

  it('prefers the complete Electron preload API without a Wails token or binding', async () => {
    const electron = installElectronBridge()
    expect(getRemoteSshBridge()).toBeDefined()
    const wails = installBridge()
    const bridge = getRemoteSshBridge()!
    await expect(bridge.connect(input())).resolves.toEqual({ kind: 'ready', connectionId: 'electron-1', homePath: undefined })
    await bridge.cancelConnect('attempt-1')
    await expect(bridge.listDirectories('electron-1', '/home/coding')).resolves.toMatchObject({
      entries: [{ path: '/home/coding/project' }],
    })
    await expect(bridge.selectDirectory('electron-1', '/home/coding/project')).resolves.toEqual({
      markerPath: '/local/marker', remotePath: '/home/coding/project',
    })
    await bridge.close('electron-1')
    await bridge.rejectHostKey('confirmation-1')
    expect(electron.remoteSSH.connect).toHaveBeenCalledWith(input())
    expect(electron.remoteSSH.cancelConnect).toHaveBeenCalledWith('attempt-1')
    expect(electron.remoteSSH.listDirectories).toHaveBeenCalledWith('electron-1', '/home/coding')
    expect(electron.remoteSSH.selectDirectory).toHaveBeenCalledWith('electron-1', '/home/coding/project')
    expect(electron.remoteSSH.close).toHaveBeenCalledWith('electron-1')
    expect(electron.remoteSSH.rejectHostKey).toHaveBeenCalledWith('confirmation-1')
    expect(wails.app.RemoteSSHConnect).not.toHaveBeenCalled()
  })

  it('falls back to Wails when Electron preload is incomplete', async () => {
    installElectronBridge({ rejectHostKey: undefined })
    const wails = installBridge()
    await getRemoteSshBridge()!.connect(input())
    expect(wails.app.RemoteSSHConnect).toHaveBeenCalledWith('window-token', input())
  })

  it('filters Electron progress and disposes its listener on unmount', () => {
    const electron = installElectronBridge()
    const listener = vi.fn()
    const unsubscribe = getRemoteSshBridge()!.subscribeProgress(listener)
    electron.emit({ attemptId: 'attempt-1', phase: 'uploading', message: 'agent starting' })
    electron.emit({ attemptId: 'attempt-1', phase: 'unknown', message: 'ignored' })
    electron.emit({ attemptId: 'attempt-1', phase: 'failed', message: 'ignored', secret: 'hidden' })
    electron.emit({ attemptId: '', phase: 'ready', message: 'ignored' })
    electron.emit(null)
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      attemptId: 'attempt-1', phase: 'uploading', message: 'agent starting',
    })
    unsubscribe()
    electron.emit({ attemptId: 'attempt-1', phase: 'ready', message: 'late event' })
    expect(electron.dispose).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rejects malformed Electron values and hides native errors', async () => {
    installElectronBridge({ connect: vi.fn(async () => ({ kind: 'ready', connectionId: 'id', extra: true })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: [{ path: '/bad' }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('id', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ selectDirectory: vi.fn(async () => ({ markerPath: '/marker', remotePath: '/', secret: true })) })
    await expect(getRemoteSshBridge()!.selectDirectory('id', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ close: vi.fn(async () => { throw new Error('/private/native/path') }) })
    await expect(getRemoteSshBridge()!.close('id')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: 'Remote-SSH 桌面桥接调用失败。',
    })

    installElectronBridge({ subscribeProgress: vi.fn(() => { throw new Error('/private/native/path') }) })
    expect(() => getRemoteSshBridge()!.subscribeProgress(vi.fn())).toThrow('Remote-SSH 桌面桥接调用失败。')

    installElectronBridge({ subscribeProgress: vi.fn(() => undefined) })
    expect(() => getRemoteSshBridge()!.subscribeProgress(vi.fn())).toThrow(RemoteSshBridgeError)
  })

  it('passes the per-window token to every sensitive binding and validates its results', async () => {
    const desktop = installBridge()
    const bridge = getRemoteSshBridge()
    expect(bridge).toBeDefined()
    const connected = await bridge!.connect(input())
    expect(connected).toEqual({ kind: 'ready', connectionId: 'connection-1', homePath: '/home/coding' })
    expect(desktop.app.RemoteSSHConnect).toHaveBeenCalledWith('window-token', input())
    await bridge!.cancelConnect('attempt-1')

    await expect(bridge!.listDirectories('connection-1', '/home/coding')).resolves.toEqual({
      path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
    })
    await expect(bridge!.selectDirectory('connection-1', '/home/coding/project')).resolves.toEqual({
      markerPath: '/local/marker', remotePath: '/home/coding/project',
    })
    await bridge!.close('connection-1')
    await bridge!.rejectHostKey('confirmation-1')
    expect(desktop.app.RemoteSSHCancelConnect).toHaveBeenCalledWith('window-token', 'attempt-1')
    expect(desktop.app.RemoteSSHListDirectories).toHaveBeenCalledWith('window-token', 'connection-1', '/home/coding')
    expect(desktop.app.RemoteSSHSelectDirectory).toHaveBeenCalledWith('window-token', 'connection-1', '/home/coding/project')
    expect(desktop.app.RemoteSSHClose).toHaveBeenCalledWith('window-token', 'connection-1')
    expect(desktop.app.RemoteSSHRejectHostKey).toHaveBeenCalledWith('window-token', 'confirmation-1')
  })

  it('surfaces all trusted connect result branches and ignores malformed progress events', async () => {
    const desktop = installBridge({
      RemoteSSHConnect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', confirmationId: 'confirmation-1',
          fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519',
        })
        .mockResolvedValueOnce({ kind: 'error', message: 'changed host key' }),
      RemoteSSHListDirectories: vi.fn(async () => ({
        path: '/home/coding', entries: [{ name: 'project', path: '/home/coding/project', directory: true }],
      })),
    })
    const bridge = getRemoteSshBridge()!
    await expect(bridge.connect(input())).resolves.toEqual({
      kind: 'host-key-confirmation', confirmationId: 'confirmation-1',
      fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519',
    })
    await expect(bridge.connect(input())).resolves.toEqual({ kind: 'error', message: 'changed host key' })
    await expect(bridge.listDirectories('connection-1', '/home/coding')).resolves.toMatchObject({
      entries: [{ directory: true }],
    })

    const listener = vi.fn()
    const unsubscribe = bridge.subscribeProgress(listener)
    for (const phase of ['authenticating', 'probing', 'uploading', 'starting', 'ready', 'failed'] as const) {
      desktop.emit({ attemptId: 'attempt-1', phase, message: 'safe progress' })
    }
    desktop.emit({ attemptId: 'attempt-1', phase: 'uploading', message: 3 })
    desktop.emit({ attemptId: 'attempt-1', phase: 'unknown', message: 'ignored' })
    desktop.emit({ phase: 'uploading', message: 'missing attempt id' })
    desktop.emit({ attemptId: 'attempt-1', phase: 'uploading', message: 'extra field', extra: true })
    desktop.emit(null)
    desktop.emit([])
    expect(listener).toHaveBeenCalledTimes(6)
    expect(listener).toHaveBeenCalledWith({ attemptId: 'attempt-1', phase: 'uploading', message: 'safe progress' })
    unsubscribe()
  })

  it('accepts a ready result without an optional home path', async () => {
    installBridge({
      RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1' })),
    })
    await expect(getRemoteSshBridge()!.connect(input())).resolves.toEqual({
      kind: 'ready', connectionId: 'connection-1', homePath: undefined,
    })
  })

  it.each(['wails', 'electron'] as const)('parses an optional forwarding-denied code from %s', async (shell) => {
    const result = { kind: 'error', message: 'private native diagnostic', code: 'port-forwarding-denied' }
    if (shell === 'wails') installBridge({ RemoteSSHConnect: vi.fn(async () => result) })
    else installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).resolves.toEqual(result)
  })

  it.each([
    { kind: 'error', message: 'unknown extension', code: 'future-code' },
    { kind: 'error', message: 'invalid code', code: '' },
    { kind: 'error', message: 'wrong type', code: 1 },
    { kind: 'error', message: 'unknown extra field', extra: true },
    { kind: 'ready', connectionId: 'connection-1', code: 'port-forwarding-denied' },
  ])('rejects an undeclared connect code or field: $message', async (result) => {
    installBridge({ RemoteSSHConnect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('rejects malformed cross-process results before they enter UI state', async () => {
    installBridge({
      RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: '' })),
    })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it.each([
    { kind: 'host-key-confirmation', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' },
    { kind: 'host-key-confirmation', confirmationId: '', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' },
  ])('rejects a host-key confirmation without an opaque id', async (result) => {
    installBridge({ RemoteSSHConnect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('is absent when a lifecycle-sensitive desktop binding is missing', () => {
    installBridge({ RemoteSSHCancelConnect: undefined })
    expect(getRemoteSshBridge()).toBeUndefined()

    installBridge({ RemoteSSHRejectHostKey: undefined })
    expect(getRemoteSshBridge()).toBeUndefined()
  })

  it('rejects every malformed response shape and leaves progress optional when Wails exposes no event runtime', async () => {
    installBridge({ RemoteSSHConnect: vi.fn(async () => null) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHConnect: vi.fn(async () => []) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHConnect: vi.fn(async () => ({ kind: 'unexpected' })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 3 })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHConnect: vi.fn(async () => ({ kind: 'ready', connectionId: 'connection-1', extra: true })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHListDirectories: vi.fn(async () => ({ path: '/', entries: {} })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHListDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 'dir', path: '/dir' }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHListDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 'dir', path: '/dir', isDirectory: true }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHListDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 3, path: '/dir', directory: true }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge({ RemoteSSHSelectDirectory: vi.fn(async () => 3) })
    await expect(getRemoteSshBridge()!.selectDirectory('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installBridge()
    vi.stubGlobal('runtime', {})
    const noEventListener = vi.fn()
    const withoutEvents = getRemoteSshBridge()!.subscribeProgress(noEventListener)
    withoutEvents()
    expect(noEventListener).not.toHaveBeenCalled()

    installBridge()
    vi.stubGlobal('runtime', { EventsOn: vi.fn(() => undefined) })
    const noUnsubscribeListener = vi.fn()
    const withoutUnsubscribe = getRemoteSshBridge()!.subscribeProgress(noUnsubscribeListener)
    withoutUnsubscribe()
    expect(noUnsubscribeListener).not.toHaveBeenCalled()
  })

  it('hides native binding rejection details behind the bridge error', async () => {
    installBridge({ RemoteSSHConnect: vi.fn(async () => { throw new Error('/private/native/path') }) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: 'Remote-SSH 桌面桥接调用失败。',
    })

    installBridge({ RemoteSSHListDirectories: vi.fn(async () => { throw new Error('internal directory detail') }) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: 'Remote-SSH 桌面桥接调用失败。',
    })

    installBridge({ RemoteSSHClose: vi.fn(async () => { throw new Error('internal close detail') }) })
    await expect(getRemoteSshBridge()!.close('connection-1')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: 'Remote-SSH 桌面桥接调用失败。',
    })
  })
})
