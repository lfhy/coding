import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { installBrowserIpc } from '../src/browser-ipc.ts'
import type { BrowserGuestManager } from '../src/browser-guest.ts'

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('electron', () => electron)
const origin = 'http://127.0.0.1:45670'

function fixture() {
  const frame = { url: `${origin}/`, isDestroyed: () => false }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  }) as unknown as BrowserWindow
  const present = vi.fn()
  const manager = { present } as unknown as BrowserGuestManager
  const dispose = installBrowserIpc({ window, origin, manager })
  const handler = electron.ipcMain.handle.mock.lastCall?.[1] as (event: IpcMainInvokeEvent, input: unknown) => void
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { frame, contents, window, present, dispose, handler, event }
}

const input = { sessionId: 'session-1', tabId: 'tab-1', bounds: { x: 40, y: 50, width: 500, height: 400 }, visible: true }

describe('desktop browser presentation IPC', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('只将已校验的 Session/tab 和窗口内矩形交给 guest manager', () => {
    const { handler, event, present, dispose } = fixture()
    handler(event, input)
    expect(present).toHaveBeenCalledExactlyOnceWith(input)
    for (const candidate of [
      { ...input, tabId: '../other' }, { ...input, guestId: 123 },
      { ...input, bounds: { ...input.bounds, x: -1 } },
      { ...input, bounds: { ...input.bounds, width: 970 } },
      { ...input, visible: 'true' },
    ]) expect(() => { handler(event, candidate) }).toThrow('Invalid browser presentation')
    expect(present).toHaveBeenCalledTimes(1)
    dispose()
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
  })

  it('跨窗口、subframe、同源伪装 URL 及 reload 中均不能调用', () => {
    const { handler, event, frame, contents, present, dispose } = fixture()
    expect(() => { handler({ ...event, sender: {} } as IpcMainInvokeEvent, input) }).toThrow('unauthorized')
    expect(() => { handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input) }).toThrow('unauthorized')
    frame.url = `${origin}.evil.test/`
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    frame.url = `${origin}/`
    handler(event, input)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/next` })
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
    expect(present).toHaveBeenCalledTimes(2)
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    frame.url = `${origin}/next`
    contents.emit('did-finish-load')
    handler(event, input)
    expect(present).toHaveBeenCalledTimes(3)
    dispose()
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
    expect(() => { handler(event, input) }).toThrow('unauthorized')
  })

  it('Host renderer 崩溃后隐藏旧 guest，待新主 frame 加载后恢复呈现', () => {
    const { handler, event, contents, present, dispose } = fixture()
    handler(event, input)
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
    expect(present).toHaveBeenCalledTimes(2)
    expect(() => { handler(event, input) }).toThrow('unauthorized')

    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(present).toHaveBeenCalledTimes(2)
    const nextFrame = { url: `${origin}/`, isDestroyed: () => false }
    contents.mainFrame = nextFrame
    contents.emit('did-finish-load')
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    handler({ ...event, senderFrame: nextFrame } as IpcMainInvokeEvent, input)
    expect(present).toHaveBeenLastCalledWith(input)
    expect(present).toHaveBeenCalledTimes(3)

    dispose()
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
    expect(contents.listenerCount('render-process-gone')).toBe(0)
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(present).toHaveBeenCalledTimes(4)
  })

  it('离开 Host 时立即隐藏旧原生视图，并永久撤销该窗口 IPC', () => {
    const { handler, event, contents, frame, present, dispose } = fixture()
    handler(event, input)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.test/' })
    expect(present).toHaveBeenLastCalledWith({ ...input, visible: false })
    expect(present).toHaveBeenCalledTimes(2)
    frame.url = `${origin}/return`
    contents.emit('did-finish-load')
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    dispose()
    expect(present).toHaveBeenCalledTimes(2)
  })
})
