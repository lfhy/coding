import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { installEgoPresentationIpc } from '../src/ego-presentation-ipc.ts'
import type { EgoPageHostHandle } from '../src/ego-page-host.ts'

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('electron', () => electron)
const origin = 'http://127.0.0.1:45671'
const input = { targetId: 'target-1', visible: true, bounds: { x: 40, y: 50, width: 500, height: 400 } }

function fixture() {
  const frame = { url: `${origin}/` }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  }) as unknown as BrowserWindow
  const present = vi.fn()
  const conceal = vi.fn()
  const pages = { present, conceal } as unknown as EgoPageHostHandle
  const dispose = installEgoPresentationIpc({ window, origin, pages })
  const handler = (electron.ipcMain.handle.mock.lastCall?.[1]
    ?? (() => {})) as (event: IpcMainInvokeEvent, value: unknown) => void
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { contents, window, frame, present, dispose, handler, event }
}

describe('桌面 Agent 页面呈现 IPC', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('把校验过的矩形交给页面宿主，撤回时报告不可见', () => {
    const { handler, event, present, dispose } = fixture()
    handler(event, input)
    expect(present).toHaveBeenCalledExactlyOnceWith({ targetId: 'target-1', bounds: input.bounds, visible: true })
    handler(event, { ...input, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    expect(present).toHaveBeenLastCalledWith({
      targetId: 'target-1', bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false,
    })
    dispose()
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith('coding:ego-present')
  })

  it('拒绝越界、越权来源与畸形载荷，且不改动现有呈现', () => {
    const { handler, event, present, window, frame, dispose } = fixture()
    for (const candidate of [
      { ...input, targetId: '../other' },
      { ...input, extra: 1 },
      { ...input, visible: 'true' },
      { ...input, bounds: { ...input.bounds, x: -1 } },
      { ...input, bounds: { ...input.bounds, width: 961 } },
      { ...input, bounds: { ...input.bounds, height: 1.5 } },
      { ...input, bounds: { x: 0, y: 0, width: 0, height: 0 } },
    ]) expect(() => { handler(event, candidate) }).toThrow('Invalid Agent browser presentation')
    expect(present).not.toHaveBeenCalled()
    expect(() => { handler({ ...event, sender: {} } as IpcMainInvokeEvent, input) }).toThrow('unauthorized')
    expect(() => { handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input) }).toThrow('unauthorized')
    frame.url = `${origin}.evil.test/`
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    frame.url = `${origin}/`
    ;(window as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    ;(window as unknown as { isDestroyed: () => boolean }).isDestroyed = () => false
    dispose()
  })

  it('换页撤下呈现，卸载后不再接受上报', () => {
    const { handler, event, present, contents, dispose } = fixture()
    handler(event, input)
    present.mockClear()
    contents.emit('did-start-navigation', {}, { isMainFrame: true, isSameDocument: false })
    expect(present).toHaveBeenCalledWith({
      targetId: 'target-1', bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false,
    })
    dispose()
    expect(() => { handler(event, input) }).toThrow('unauthorized')
    expect(() => { dispose() }).not.toThrow()
  })

  it('只允许回环 Host origin', () => {
    const window = { webContents: new EventEmitter(), isDestroyed: () => false } as unknown as BrowserWindow
    const pages = { present: vi.fn(), conceal: vi.fn() } as unknown as EgoPageHostHandle
    expect(() => installEgoPresentationIpc({ window, origin: 'https://127.0.0.1:45671', pages }))
      .toThrow('Invalid Agent browser presentation origin')
    expect(() => installEgoPresentationIpc({ window, origin: 'http://localhost:45671', pages }))
      .toThrow('Invalid Agent browser presentation origin')
  })
})
