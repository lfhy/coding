import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => 'result'), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron', () => electron)

type Bridge = {
  remoteSSH: Record<string, (...args: unknown[]) => unknown>
}

async function preload(): Promise<Bridge> {
  vi.resetModules()
  await import('../src/preload.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('codingDesktop', expect.any(Object))
  return electron.contextBridge.exposeInMainWorld.mock.lastCall?.[1] as Bridge
}

describe('Remote-SSH sandbox preload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('仅向页面暴露不可变的七项方法和两个固定 IPC channel', async () => {
    const bridge = await preload()
    expect(Object.keys(bridge)).toEqual(['remoteSSH'])
    expect(Object.keys(bridge.remoteSSH)).toEqual([
      'connect', 'cancelConnect', 'listDirectories', 'selectDirectory', 'close', 'rejectHostKey', 'subscribeProgress',
    ])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.remoteSSH)).toBe(true)
    const input = { attemptId: 'attempt-1', auth: { secret: 'one-use' } }
    await bridge.remoteSSH.connect!(input)
    await bridge.remoteSSH.cancelConnect!('attempt-1')
    await bridge.remoteSSH.listDirectories!('connection-1', '/srv')
    await bridge.remoteSSH.selectDirectory!('connection-1', '/srv')
    await bridge.remoteSSH.close!('connection-1')
    await bridge.remoteSSH.rejectHostKey!('confirmation-1')
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['coding:remote-ssh', 'connect', input],
      ['coding:remote-ssh', 'cancelConnect', { attemptId: 'attempt-1' }],
      ['coding:remote-ssh', 'listDirectories', { connectionId: 'connection-1', path: '/srv' }],
      ['coding:remote-ssh', 'selectDirectory', { connectionId: 'connection-1', path: '/srv' }],
      ['coding:remote-ssh', 'close', { connectionId: 'connection-1' }],
      ['coding:remote-ssh', 'rejectHostKey', { confirmationId: 'confirmation-1' }],
    ])
    expect(bridge.remoteSSH.invoke).toBeUndefined()
    expect(bridge.remoteSSH.ipcRenderer).toBeUndefined()
  })

  it('进度监听只订阅独立 channel，并可幂等撤销', async () => {
    const bridge = await preload()
    const listener = vi.fn()
    const dispose = bridge.remoteSSH.subscribeProgress!(listener) as () => void
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('coding:remote-ssh-progress', expect.any(Function))
    const forward = electron.ipcRenderer.on.mock.lastCall?.[1] as (_event: unknown, value: unknown) => void
    forward({ sender: 'private' }, { attemptId: 'attempt-1', phase: 'ready', message: '' })
    expect(listener).toHaveBeenCalledWith({ attemptId: 'attempt-1', phase: 'ready', message: '' })
    dispose()
    dispose()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledOnce()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('coding:remote-ssh-progress', forward)
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })
})
