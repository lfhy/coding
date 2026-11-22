import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { EGO_DOWNLOADS_EVENT, installEgoDownloadsIpc } from '../src/ego-downloads-ipc.ts'
import type { EgoDownloadEvent, EgoDownloadRecord, EgoPageHostHandle } from '../src/ego-page-host.ts'

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
}))
vi.mock('electron', () => electron)
const origin = 'http://127.0.0.1:45672'

const download: EgoDownloadRecord = {
  id: 'download-1', contextId: 'desktop-default', filename: '报告.zip',
  path: '/tmp/报告.zip', url: 'https://example.test/报告.zip', state: 'completed',
  receivedBytes: 8, totalBytes: 8, startedAt: 1,
}

function fixture() {
  const frame = { url: `${origin}/` }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: (): boolean => false, send: vi.fn(),
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false,
  }) as unknown as BrowserWindow
  const downloads: EgoDownloadRecord[] = [download]
  const listeners = new Set<(event: EgoDownloadEvent) => void>()
  const cancelDownload = vi.fn(() => true)
  const saveDownload = vi.fn(async (_id: string, target: string) => target)
  const pages = {
    downloads: () => downloads,
    cancelDownload,
    saveDownload,
    onDownload: (listener: (event: EgoDownloadEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as EgoPageHostHandle
  const dispose = installEgoDownloadsIpc({ window, origin, pages })
  const handler = electron.ipcMain.handle.mock.lastCall?.[1] as
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { contents, window, frame, pages, downloads, listeners, dispose, handler, event,
    cancelDownload, saveDownload }
}

describe('桌面下载列表 IPC', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('返回下载列表并只对指定项执行动作', async () => {
    const { handler, event, cancelDownload } = fixture()
    await expect(handler(event, { action: 'list' })).resolves.toEqual({ ok: true, downloads: [download] })
    await expect(handler(event, { action: 'cancel', id: 'download-1' })).resolves.toEqual({ ok: true })
    expect(cancelDownload).toHaveBeenCalledWith('download-1')
    await expect(handler(event, { action: 'reveal', id: 'download-1' })).resolves.toEqual({ ok: true })
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('/tmp/报告.zip')
    electron.shell.openPath.mockResolvedValueOnce('')
    await expect(handler(event, { action: 'open', id: 'download-1' })).resolves.toEqual({ ok: true })
    expect(electron.shell.openPath).toHaveBeenCalledWith('/tmp/报告.zip')
    await expect(handler(event, { action: 'cancel', id: 'missing' })).resolves.toEqual({ ok: false })
  })

  it('另存为只在用户确认后复制，取消时不改动文件', async () => {
    const { handler, event, saveDownload } = fixture()
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/Users/me/报告.zip' })
    await expect(handler(event, { action: 'save', id: 'download-1' }))
      .resolves.toEqual({ ok: true, path: '/Users/me/报告.zip' })
    expect(saveDownload).toHaveBeenCalledWith('download-1', '/Users/me/报告.zip')
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    await expect(handler(event, { action: 'save', id: 'download-1' }))
      .resolves.toEqual({ ok: false, canceled: true })
    expect(saveDownload).toHaveBeenCalledTimes(1)
  })

  it('拒绝越权来源与畸形载荷', async () => {
    const { handler, event, contents, frame } = fixture()
    await expect(handler({ ...event, sender: {} } as IpcMainInvokeEvent, { action: 'list' }))
      .rejects.toThrow('unauthorized')
    await expect(handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, { action: 'list' }))
      .rejects.toThrow('unauthorized')
    frame.url = `${origin}.evil.test/`
    await expect(handler(event, { action: 'list' })).rejects.toThrow('unauthorized')
    frame.url = `${origin}/`
    contents.isDestroyed = () => true
    await expect(handler(event, { action: 'list' })).rejects.toThrow('unauthorized')
    contents.isDestroyed = () => false
    for (const invalid of [
      null, 'list', { action: 'list', extra: 1 }, { action: 'delete' },
      { action: 'cancel' }, { action: 'cancel', id: '../x' }, { action: 'cancel', id: 'ok', extra: 1 },
    ]) await expect(handler(event, invalid)).rejects.toThrow('Invalid Agent download request')
  })

  it('把下载事件推给页面，卸载后停止推送', () => {
    const { contents, listeners, dispose, event, handler, window } = fixture()
    expect(listeners.size).toBe(1)
    for (const listener of [...listeners]) listener({ kind: 'begin', record: download })
    expect(contents.send).toHaveBeenCalledWith(EGO_DOWNLOADS_EVENT, { kind: 'begin', record: download })
    dispose()
    expect(listeners.size).toBe(0)
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith('coding:ego-downloads')
    expect(() => { dispose() }).not.toThrow()
    void handler(event, { action: 'list' }).catch(() => undefined)
    window.emit('closed')
  })

  it('只接受回环 Host origin', () => {
    const window = { webContents: new EventEmitter(), isDestroyed: () => false } as unknown as BrowserWindow
    const pages = { downloads: () => [], onDownload: () => () => {} } as unknown as EgoPageHostHandle
    expect(() => installEgoDownloadsIpc({ window, origin: 'https://127.0.0.1:45672', pages }))
      .toThrow('Invalid Agent download origin')
  })
})
