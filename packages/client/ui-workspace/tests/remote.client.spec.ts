// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRemoteSshBridge, RemoteSshBridgeError, RemoteSshConfigError,
  validateRemoteSshConfig,
} from '../src/client/remote.ts'

afterEach(() => { vi.unstubAllGlobals() })

const input = (overrides: Partial<Parameters<typeof validateRemoteSshConfig>[0]> = {}) => ({
  attemptId: 'attempt-1',
  mode: 'basic' as const,
  host: 'dev.example.test',
  port: 22,
  username: 'coding',
  auth: { kind: 'password' as const, secret: 'transient-only' },
  ...overrides,
})

function installElectronBridge(overrides: Partial<Record<string, unknown>> = {}) {
  let progressListener: ((value: unknown) => void) | undefined
  const dispose = vi.fn(() => { progressListener = undefined })
  const remoteSSH = {
    connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'electron-1' })),
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

function installLegacyBridge() {
  vi.stubGlobal('__CODING_DESKTOP_BRIDGE_TOKEN', 'window-token')
  const connect = vi.fn()
  vi.stubGlobal('go', { main: { App: {
    RemoteSSHConnect: connect,
    RemoteSSHCancelConnect: vi.fn(),
    RemoteSSHListDirectories: vi.fn(),
    RemoteSSHSelectDirectory: vi.fn(),
    RemoteSSHClose: vi.fn(),
    RemoteSSHRejectHostKey: vi.fn(),
  } } })
  return connect
}

describe('validateRemoteSshConfig', () => {
  it('keeps a valid SSH input intact without normalizing it into a URL', () => {
    expect(validateRemoteSshConfig(input())).toEqual(input())
  })

  it.each([
    [input({ mode: 'legacy' as 'basic' }), 'mode'],
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
    const legacyConnect = installLegacyBridge()
    expect(getRemoteSshBridge()).toBeUndefined()
    expect(legacyConnect).not.toHaveBeenCalled()
    vi.stubGlobal('codingDesktop', { remoteSSH: { connect: vi.fn() } })
    expect(getRemoteSshBridge()).toBeUndefined()
  })

  it('uses the complete Electron preload API without a token', async () => {
    const electron = installElectronBridge()
    expect(getRemoteSshBridge()).toBeDefined()
    const bridge = getRemoteSshBridge()!
    await expect(bridge.connect(input())).resolves.toEqual({ kind: 'ready', mode: 'basic', connectionId: 'electron-1', homePath: undefined })
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
  })

  it('does not expose an incomplete Electron preload API even if a legacy binding exists', () => {
    installElectronBridge({ rejectHostKey: undefined })
    const legacyConnect = installLegacyBridge()
    expect(getRemoteSshBridge()).toBeUndefined()
    expect(legacyConnect).not.toHaveBeenCalled()
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
    installElectronBridge({ connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'id', extra: true })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: [{ path: '/bad' }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('id', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ selectDirectory: vi.fn(async () => ({ markerPath: '/marker', remotePath: '/', secret: true })) })
    await expect(getRemoteSshBridge()!.selectDirectory('id', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ close: vi.fn(async () => { throw new Error('/private/native/path') }) })
    await expect(getRemoteSshBridge()!.close('id')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: '远程连接桌面桥接调用失败。',
    })

    installElectronBridge({ subscribeProgress: vi.fn(() => { throw new Error('/private/native/path') }) })
    expect(() => getRemoteSshBridge()!.subscribeProgress(vi.fn())).toThrow('远程连接桌面桥接调用失败。')

    installElectronBridge({ subscribeProgress: vi.fn(() => undefined) })
    expect(() => getRemoteSshBridge()!.subscribeProgress(vi.fn())).toThrow(RemoteSshBridgeError)
  })

  it('surfaces all trusted connect result branches and ignores malformed progress events', async () => {
    const desktop = installElectronBridge({
      connect: vi.fn()
        .mockResolvedValueOnce({
          kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
          fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519',
        })
        .mockResolvedValueOnce({ kind: 'error', message: 'changed host key' }),
    })
    const bridge = getRemoteSshBridge()!
    await expect(bridge.connect(input())).resolves.toEqual({
      kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
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
    installElectronBridge({
      connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'connection-1' })),
    })
    await expect(getRemoteSshBridge()!.connect(input())).resolves.toEqual({
      kind: 'ready', mode: 'basic', connectionId: 'connection-1', homePath: undefined,
    })
  })

  it('requires the requested ready mode', async () => {
    for (const mode of [undefined, 'legacy', '', 1, 'agent']) {
      const result = { kind: 'ready', connectionId: 'connection-1', mode }
      installElectronBridge({ connect: vi.fn(async () => result) })
      await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
    }
    const result = { kind: 'ready', connectionId: 'connection-1', mode: 'basic' }
    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).resolves.toMatchObject({ mode: 'basic' })

    const agentResult = { kind: 'ready', connectionId: 'agent-connection', mode: 'agent' }
    installElectronBridge({ connect: vi.fn(async () => agentResult) })
    await expect(getRemoteSshBridge()!.connect(input({ mode: 'agent' }))).resolves.toMatchObject({ mode: 'agent' })

    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input({ mode: 'agent' }))).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('accepts basic and agent host-key confirmations', async () => {
    for (const mode of ['basic', 'agent'] as const) {
      const result = {
        kind: 'host-key-confirmation', mode, confirmationId: 'confirmation-1',
        fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519',
      }
      installElectronBridge({ connect: vi.fn(async () => result) })
      await expect(getRemoteSshBridge()!.connect(input({ mode }))).resolves.toEqual(result)
    }
  })

  it('rejects invalid or mismatched host-key modes', async () => {
    for (const mode of [undefined, 'legacy', '', 1, 'agent']) {
      const result = {
        kind: 'host-key-confirmation', mode, confirmationId: 'confirmation-1',
        fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519',
      }
      installElectronBridge({ connect: vi.fn(async () => result) })
      await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
    }
  })

  it('parses an optional forwarding-denied code', async () => {
    const result = { kind: 'error', message: 'private native diagnostic', code: 'port-forwarding-denied' }
    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).resolves.toEqual(result)
  })

  it.each([
    { kind: 'error', message: 'unknown extension', code: 'future-code' },
    { kind: 'error', message: 'invalid code', code: '' },
    { kind: 'error', message: 'wrong type', code: 1 },
    { kind: 'error', message: 'unknown extra field', extra: true },
    { kind: 'ready', mode: 'basic', connectionId: 'connection-1', code: 'port-forwarding-denied' },
  ])('rejects an undeclared connect code or field: $message', async (result) => {
    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('rejects malformed cross-process results before they enter UI state', async () => {
    installElectronBridge({
      connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: '' })),
    })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it.each([
    { kind: 'host-key-confirmation', mode: 'basic', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' },
    { kind: 'host-key-confirmation', mode: 'basic', confirmationId: '', fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' },
  ])('rejects a host-key confirmation without an opaque id', async (result) => {
    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('rejects extra host-key confirmation fields', async () => {
    const result = {
      kind: 'host-key-confirmation', mode: 'basic', confirmationId: 'confirmation-1',
      fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519', unexpected: true,
    }
    installElectronBridge({ connect: vi.fn(async () => result) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('is absent when a lifecycle-sensitive preload method is missing', () => {
    installElectronBridge({ cancelConnect: undefined })
    expect(getRemoteSshBridge()).toBeUndefined()

    installElectronBridge({ rejectHostKey: undefined })
    expect(getRemoteSshBridge()).toBeUndefined()
  })

  it('rejects every malformed response shape from Electron preload', async () => {
    installElectronBridge({ connect: vi.fn(async () => null) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ connect: vi.fn(async () => []) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ connect: vi.fn(async () => ({ kind: 'unexpected' })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 3 })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ connect: vi.fn(async () => ({ kind: 'ready', mode: 'basic', connectionId: 'connection-1', extra: true })) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: {} })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 'dir', path: '/dir' }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 'dir', path: '/dir', isDirectory: true }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ listDirectories: vi.fn(async () => ({ path: '/', entries: [{ name: 3, path: '/dir', directory: true }] })) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)

    installElectronBridge({ selectDirectory: vi.fn(async () => 3) })
    await expect(getRemoteSshBridge()!.selectDirectory('connection-1', '/')).rejects.toBeInstanceOf(RemoteSshBridgeError)
  })

  it('hides native binding rejection details behind the bridge error', async () => {
    installElectronBridge({ connect: vi.fn(async () => { throw new Error('/private/native/path') }) })
    await expect(getRemoteSshBridge()!.connect(input())).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: '远程连接桌面桥接调用失败。',
    })

    installElectronBridge({ listDirectories: vi.fn(async () => { throw new Error('internal directory detail') }) })
    await expect(getRemoteSshBridge()!.listDirectories('connection-1', '/')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: '远程连接桌面桥接调用失败。',
    })

    installElectronBridge({ close: vi.fn(async () => { throw new Error('internal close detail') }) })
    await expect(getRemoteSshBridge()!.close('connection-1')).rejects.toMatchObject({
      name: 'RemoteSshBridgeError', message: '远程连接桌面桥接调用失败。',
    })
  })
})
