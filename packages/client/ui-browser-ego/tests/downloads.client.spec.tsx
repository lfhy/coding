// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserPanel, type AgentBrowserProps } from '../src/client/AgentBrowserPanel.tsx'
import type { BrowserEgoView } from '../src/client/controller.ts'
import {
  downloadsForSurface, mergeDownload, nativeEgoDownloads, parseDownload, type EgoDownloadItem,
  type EgoDownloadsBridge,
} from '../src/client/downloads.ts'
import type { EgoNativeSurface } from '../src/client/native.ts'
import { en } from '../src/client/locales.ts'

const page = { targetId: 'first', title: 'Example', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const ready: BrowserEgoView = { phase: 'ready', pages: [page], selectedId: page.targetId,
  frame: null, relayOff: false, pending: false, closing: null,
  status: { running: true, browserConnected: true }, video: { available: false, mime: null }, actions: [] }

const progressing: EgoDownloadItem = { id: 'download-1', filename: '安装包.dmg', state: 'progressing',
  receivedBytes: 40, totalBytes: 100, path: '/tmp/安装包.dmg' }
const completed: EgoDownloadItem = { id: 'download-2', filename: 'report.zip', state: 'completed',
  receivedBytes: 8, totalBytes: 8, path: '/tmp/report.zip' }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function bridge(items: EgoDownloadItem[] = [progressing, completed]) {
  let listener: ((item: EgoDownloadItem) => void) | null = null
  const downloads = {
    list: vi.fn(async () => items),
    cancel: vi.fn(async () => true),
    save: vi.fn(async () => ({ ok: true, canceled: false })),
    reveal: vi.fn(async () => undefined),
    open: vi.fn(async () => true),
    subscribe: vi.fn((next: (item: EgoDownloadItem) => void) => { listener = next; return () => { listener = null } }),
  } satisfies EgoDownloadsBridge
  return { downloads, push: (item: EgoDownloadItem) => { listener?.(item) } }
}

function mount(options: {
  downloads: EgoDownloadsBridge | null
  surface?: EgoNativeSurface | null
}) {
  const present = vi.fn(async () => undefined)
  const props = { sessionId: 'session-one',
    useTabInfo: () => ({ shown: true, tab: { id: 'browser-first', params: { targetId: 'first' } } }),
    useBrowserEgo: (choose: (snapshot: BrowserEgoView) => unknown) => choose(ready),
    useBrowserEgoSettings: (choose: (snapshot: unknown) => unknown) => choose({ backend: 'auto' }),
    show: vi.fn(), send: vi.fn(async () => true), hover: vi.fn(async () => null),
    resize: vi.fn(async () => true), navigate: vi.fn(async () => true),
    raiseWindow: vi.fn(async () => true), refresh: vi.fn(async () => {}),
    surface: options.surface === undefined ? { present } : options.surface,
    downloads: options.downloads,
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as AgentBrowserProps
  return { ...render(<AgentBrowserPanel {...props} />), props }
}

describe('工作台下载列表', () => {
  it('列出下载的进度与状态，并允许取消进行中的下载', async () => {
    const { downloads, push } = bridge()
    mount({ downloads })
    const button = await screen.findByRole('button', { name: 'Downloads' })
    // 进行中的数量出现在入口角标上。
    expect(button.textContent).toBe('1')
    fireEvent.click(button)
    expect(await screen.findByRole('dialog', { name: 'Downloads' })).toBeTruthy()
    expect(screen.getByText('安装包.dmg')).toBeTruthy()
    expect(screen.getByText('Downloading')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('report.zip')).toBeTruthy()
    expect(screen.getByText('Completed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
    await waitFor(() => { expect(downloads.cancel).toHaveBeenCalledWith('download-1') })
    await act(async () => {
      push({ ...progressing, state: 'completed', receivedBytes: 100 })
    })
    // 完成后进度条消失，两行都变成可另存为的状态。
    expect(screen.getAllByText('Completed')).toHaveLength(2)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel download' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Save as…' })).toHaveLength(2)
  })

  it('另存为与显示位置交给桌面壳，用户放弃时保持安静', async () => {
    const { downloads } = bridge([completed])
    mount({ downloads })
    fireEvent.click(await screen.findByRole('button', { name: 'Downloads' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save as…' }))
    await waitFor(() => { expect(downloads.save).toHaveBeenCalledWith('download-2') })
    downloads.save.mockResolvedValueOnce({ ok: false, canceled: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    await waitFor(() => { expect(downloads.save).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    await waitFor(() => { expect(downloads.reveal).toHaveBeenCalledWith('download-2') })
  })

  it('没有下载时给出一句话空态，Web 端不显示入口', async () => {
    const { downloads } = bridge([])
    mount({ downloads })
    fireEvent.click(await screen.findByRole('button', { name: 'Downloads' }))
    expect(await screen.findByText('No downloads yet')).toBeTruthy()
    cleanup()
    mount({ downloads: null, surface: null })
    expect(screen.queryByRole('button', { name: 'Downloads' })).toBeNull()
  })

  it('失败的操作只弹一次固定提示，不泄露底层原因', async () => {
    const { downloads } = bridge([completed])
    downloads.save.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    mount({ downloads })
    fireEvent.click(await screen.findByRole('button', { name: 'Downloads' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save as…' }))
    expect(await screen.findByText(/did not complete/u)).toBeTruthy()
    expect(document.body.textContent).not.toContain('EACCES')
  })
})

describe('下载桥的输入校验', () => {
  it('只接受字段完整且取值合法的记录', () => {
    expect(parseDownload(progressing)).toEqual(progressing)
    expect(parseDownload(null)).toBeNull()
    expect(parseDownload('download')).toBeNull()
    expect(parseDownload({ ...progressing, id: '' })).toBeNull()
    expect(parseDownload({ ...progressing, filename: '' })).toBeNull()
    expect(parseDownload({ ...progressing, state: 'paused' })).toBeNull()
    expect(parseDownload({ ...progressing, receivedBytes: -1 })).toBeNull()
    expect(parseDownload({ ...progressing, totalBytes: 1.5 })).toBeNull()
    expect(parseDownload({ ...progressing, path: 42 })).toBeNull()
  })

  it('合并时同一 id 覆盖并保留最近 50 条', () => {
    expect(mergeDownload([progressing, completed], { ...completed, state: 'canceled' }))
      .toEqual([{ ...completed, state: 'canceled' }, progressing])
    const many = Array.from({ length: 60 }, (_, index) => ({ ...completed, id: `d-${index}` }))
    expect(mergeDownload(many, { ...completed, id: 'new' })).toHaveLength(50)
  })

  it('缺少桌面壳时不提供下载入口', () => {
    expect(nativeEgoDownloads()).toBeNull()
    expect(downloadsForSurface(null)).toBeNull()
    vi.stubGlobal('codingDesktop', { egoBrowser: { downloads: { list: 'nope' } } })
    expect(nativeEgoDownloads()).toBeNull()
  })

  it('桥接层把 IPC 结果归一化，并过滤畸形条目', async () => {
    const list = vi.fn(async () => ({ ok: true, downloads: [completed, { id: '' }] }))
    const cancel = vi.fn(async (id: string) => ({ ok: id === 'download-2' }))
    const save = vi.fn(async () => ({ ok: false, canceled: true }))
    const reveal = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ ok: true }))
    const subscribe = vi.fn((listener: (payload: unknown) => void) => {
      listener({ kind: 'begin', record: progressing })
      listener({ kind: 'progress', record: { id: '' } })
      return () => {}
    })
    vi.stubGlobal('codingDesktop', { egoBrowser: { downloads: { list, cancel, save, reveal, open, subscribe } } })
    const surface: EgoNativeSurface = { present: vi.fn(async () => undefined) }
    const bridge_ = downloadsForSurface(surface)
    expect(bridge_).not.toBeNull()
    await expect(bridge_!.list()).resolves.toEqual([completed])
    await expect(bridge_!.cancel('download-2')).resolves.toBe(true)
    await expect(bridge_!.save('download-2')).resolves.toEqual({ ok: false, canceled: true })
    const seen: EgoDownloadItem[] = []
    bridge_!.subscribe(item => seen.push(item))
    expect(seen).toEqual([progressing])
  })
})
