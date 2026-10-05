import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => 'result'), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron', () => electron)

type Bridge = {
  remoteSSH: Record<string, (...args: unknown[]) => unknown>
  browser: { available: boolean; present(input: unknown): Promise<void> }
}

async function preload(): Promise<Bridge> {
  vi.resetModules()
  await import('../src/preload.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('codingDesktop', expect.any(Object))
  return electron.contextBridge.exposeInMainWorld.mock.lastCall?.[1] as Bridge
}

describe('Remote-SSH sandbox preload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('仅向页面暴露不可变的 Remote-SSH 和浏览器呈现入口', async () => {
    const bridge = await preload()
    expect(Object.keys(bridge)).toEqual(['remoteSSH', 'browser'])
    expect(Object.keys(bridge.remoteSSH)).toEqual([
      'connect', 'cancelConnect', 'listDirectories', 'selectDirectory', 'close', 'rejectHostKey', 'subscribeProgress',
    ])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.remoteSSH)).toBe(true)
    expect(Object.keys(bridge.browser)).toEqual(['available', 'present'])
    expect(Object.isFrozen(bridge.browser)).toBe(true)
    expect(bridge.browser.available).toBe(true)
    const input = { attemptId: 'attempt-1', mode: 'basic', auth: { secret: 'one-use' } }
    await bridge.remoteSSH.connect!(input)
    await bridge.remoteSSH.cancelConnect!('attempt-1')
    await bridge.remoteSSH.listDirectories!('connection-1', '/srv')
    await bridge.remoteSSH.selectDirectory!('connection-1', '/srv')
    await bridge.remoteSSH.close!('connection-1')
    await bridge.remoteSSH.rejectHostKey!('confirmation-1')
    const placement = { sessionId: 'session-1', tabId: 'tab-1', bounds: { x: 0, y: 0, width: 500, height: 300 }, visible: true }
    await bridge.browser.present(placement)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['coding:remote-ssh', 'connect', input],
      ['coding:remote-ssh', 'cancelConnect', { attemptId: 'attempt-1' }],
      ['coding:remote-ssh', 'listDirectories', { connectionId: 'connection-1', path: '/srv' }],
      ['coding:remote-ssh', 'selectDirectory', { connectionId: 'connection-1', path: '/srv' }],
      ['coding:remote-ssh', 'close', { connectionId: 'connection-1' }],
      ['coding:remote-ssh', 'rejectHostKey', { confirmationId: 'confirmation-1' }],
      ['coding:browser-present', placement],
    ])
    expect(bridge.remoteSSH.invoke).toBeUndefined()
    expect(bridge.remoteSSH.ipcRenderer).toBeUndefined()
    expect((bridge.browser as unknown as Record<string, unknown>).invoke).toBeUndefined()
    expect((bridge.browser as unknown as Record<string, unknown>).navigate).toBeUndefined()
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
