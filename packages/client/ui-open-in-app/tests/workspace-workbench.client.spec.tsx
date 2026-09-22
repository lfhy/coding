// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkbenchStore } from '../src/client/store.ts'
import {
  formatBytes,
  sortTreeEntries,
  WorkspaceWorkbench,
  type WorkspaceWorkbenchProps,
} from '../src/client/WorkspaceWorkbench.tsx'
import { zh } from '../src/client/locales.ts'
import type { WorkspaceFileEntry, WorkspaceFilePayload, WorkspaceFilesPayload } from '../src/client/wire.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'workbench-session' as SessionId
const t: WorkspaceWorkbenchProps['t'] = makeTranslate(zh)

function listing(path: string, entries: readonly WorkspaceFileEntry[], truncated = false): WorkspaceFilesPayload {
  return { path, entries, truncated }
}

function bench(over: {
  shown?: boolean
  fullscreen?: boolean
  bottomOpen?: boolean
  filesOpen?: boolean
  listFiles?: WorkspaceWorkbenchProps['listFiles']
  readFile?: WorkspaceWorkbenchProps['readFile']
} = {}) {
  const instance = createWorkbenchStore().create()
  const closeWorkbench = vi.fn()
  const toggleWorkbenchFullscreen = vi.fn()
  const listFiles = vi.fn(over.listFiles ?? (async () => listing('/workspace', [])))
  const readFile = vi.fn(over.readFile ?? (async (): Promise<WorkspaceFilePayload> => ({
    path: '/workspace/file', content: { kind: 'text', text: '' },
  })))
  const props = {
    sessionId: SESSION,
    shown: over.shown ?? true,
    fullscreen: over.fullscreen ?? false,
    bottomOpen: over.bottomOpen ?? false,
    filesOpen: over.filesOpen ?? true,
    closeWorkbench,
    toggleWorkbenchFullscreen,
    useStore: bindSnapshotSelector(instance.store),
    actions: instance.actions,
    listFiles,
    readFile,
    t,
  } as unknown as WorkspaceWorkbenchProps
  return { instance, props, closeWorkbench, toggleWorkbenchFullscreen, listFiles, readFile }
}

describe('workspace workbench helpers', () => {
  it('sorts directories first and formats every size band', () => {
    const entries: WorkspaceFileEntry[] = [
      { name: 'z.ts', type: 'file', segments: ['z.ts'] },
      { name: 'beta', type: 'directory', segments: ['beta'] },
      { name: 'alpha', type: 'directory', segments: ['alpha'] },
      { name: 'a.ts', type: 'file', segments: ['a.ts'] },
    ]
    expect(sortTreeEntries(entries).map(entry => entry.name)).toEqual(['alpha', 'beta', 'a.ts', 'z.ts'])
    expect([
      formatBytes(undefined), formatBytes(42), formatBytes(2 * 1024), formatBytes(20 * 1024),
      formatBytes(2 * 1024 * 1024), formatBytes(20 * 1024 * 1024),
      formatBytes(2 * 1024 * 1024 * 1024),
    ]).toEqual(['', '42 B', '2.0 KiB', '20 KiB', '2.0 MiB', '20 MiB', '2.0 GiB'])
  })
})

describe('WorkspaceWorkbench shell', () => {
  it('waits for the workbench to be shown before reading the workspace root', async () => {
    const b = bench({ shown: false })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    expect(b.listFiles).not.toHaveBeenCalled()
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown />)
    await waitFor(() => {
      expect(b.listFiles).toHaveBeenCalledExactlyOnceWith([], expect.any(AbortSignal))
    })
  })

  it('keeps only the maximize and close controls in the top bar', () => {
    const b = bench({ fullscreen: true, bottomOpen: true, filesOpen: true })
    render(<WorkspaceWorkbench {...b.props} />)
    const fullscreen = screen.getByRole('button', { name: zh['workbench.fullscreen.exit'] })
    expect(fullscreen.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(fullscreen)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.close'] }))
    expect(b.toggleWorkbenchFullscreen).toHaveBeenCalledOnce()
    expect(b.closeWorkbench).toHaveBeenCalledOnce()
    // 文件侧栏与终端底栏常驻在侧边栏品牌行：顶栏不再提供这两个开关。
    for (const label of [
      zh['workbench.bottom.show'], zh['workbench.bottom.hide'],
      zh['workbench.files.show'], zh['workbench.files.hide'],
    ]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    const topbar = screen.getByRole('region', { name: zh['workbench.label'] })
      .querySelector('header') as HTMLElement
    expect(within(topbar).getAllByRole('button')
      .filter(button => !button.classList.contains('tabSelect') && !button.classList.contains('tabClose')))
      .toHaveLength(2)
  })

  it('hides the file sidebar when the owner closes it and keeps its state across visibility changes', async () => {
    const b = bench({ filesOpen: false })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    await screen.findByText(zh['files.empty'])
    expect(mounted.container.querySelector('aside')?.hidden).toBe(true)
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} filesOpen={false} />)
    b.instance.actions.setFilesQuery('kept')
    expect(mounted.container.querySelector('aside')?.hidden).toBe(true)
    expect(b.instance.getSnapshot()).toMatchObject({ filesQuery: 'kept' })
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown filesOpen />)
    await waitFor(() => { expect(mounted.container.querySelector('aside')?.hidden).toBe(false) })

    expect(b.listFiles).toHaveBeenCalledExactlyOnceWith([], expect.any(AbortSignal))
  })

  it('lazily expands provider segments, filters files, refreshes, and opens a tab', async () => {
    const listFiles = vi.fn(async (segments: readonly string[]) => segments.length === 0
      ? listing('/remote/project', [
        { name: 'README.md', type: 'file', size: 1_536, segments: ['opaque-root', 'README.md'] },
        { name: 'src', type: 'directory', segments: ['opaque-root', 'src'] },
        { name: 'alpha.txt', type: 'file', segments: ['opaque-root', 'alpha.txt'] },
        { name: 'pipe', type: 'other', segments: ['opaque-root', 'pipe'] },
      ], true)
      : listing('/remote/project/src', [
        { name: 'main.ts', type: 'file', size: 42, segments: ['opaque-root', 'src', 'main.ts'] },
      ]))
    const readFile = vi.fn(async (segments: readonly string[]) => ({
      path: `/provider/${segments.at(-1) ?? ''}`,
      content: { kind: 'text' as const, text: 'first line\nsecond line' },
    }))
    const b = bench({ listFiles, readFile })
    render(<WorkspaceWorkbench {...b.props} />)

    await screen.findByRole('button', { name: 'src' })
    const tree = screen.getByRole('tree', { name: zh['files.label'] })
    const rows = within(tree).getAllByRole('button')
    expect(rows.map(row => row.textContent).slice(0, 3)).toEqual(['src', 'alpha.txt', 'README.md1.5 KiB'])
    expect(screen.getByText(zh['files.truncated'])).toBeDefined()

    const filter = screen.getByRole('searchbox', { name: zh['files.filter'] })
    fireEvent.change(filter, { target: { value: 'read' } })
    expect(screen.queryByRole('button', { name: /alpha\.txt/ })).toBeNull()
    expect(screen.getByRole('button', { name: /README\.md/ })).toBeDefined()
    fireEvent.change(filter, { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    const child = await screen.findByRole('button', { name: /main\.ts/ })
    expect(listFiles).toHaveBeenLastCalledWith(['opaque-root', 'src'], expect.any(AbortSignal))
    fireEvent.click(child)
    const tab = await screen.findByRole('tab', { name: /main\.ts/ })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    await screen.findByText((_, element) => element?.tagName === 'PRE'
      && element.textContent === 'first line\nsecond line')
    expect(readFile).toHaveBeenCalledExactlyOnceWith(
      ['opaque-root', 'src', 'main.ts'], expect.any(AbortSignal),
    )

    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    expect(listFiles).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.close'].replace('{name}', 'main.ts') }))
    expect(await screen.findByText(zh['workbench.empty.detail'])).toBeDefined()

    const calls = listFiles.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: zh['preview.refresh'] }))
    expect(screen.getByText(zh['files.loading'])).toBeDefined()
    await waitFor(() => { expect(listFiles.mock.calls.length).toBeGreaterThan(calls) })
  })

  it('renders Markdown, code, text, image, and unsupported previews in switchable tabs', async () => {
    const payloads: Record<string, WorkspaceFilePayload> = {
      'doc.md': { path: '/w/doc.md', content: { kind: 'markdown', text: '# Heading' } },
      'code.ts': { path: '/w/code.ts', content: { kind: 'code', text: 'const x = 1\n', language: 'ts' } },
      'notes.txt': { path: '/w/notes.txt', content: { kind: 'text', text: 'plain\ntext' } },
      'logo.png': { path: '/w/logo.png', content: { kind: 'image', mimeType: 'image/png', data: 'AAAA' } },
      'archive.zip': { path: '/w/archive.zip', content: { kind: 'unsupported', mimeType: 'application/zip' } },
      'unknown.bin': { path: '/w/unknown.bin', content: { kind: 'unsupported' } },
    }
    const b = bench({
      readFile: async segments => payloads[segments.at(-1) ?? ''] as WorkspaceFilePayload,
    })
    for (const name of Object.keys(payloads)) b.instance.actions.openFile({ name, segments: [name] })
    render(<WorkspaceWorkbench {...b.props} />)
    await screen.findByText('Heading')

    for (const name of Object.keys(payloads)) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) }))
      const article = screen.getByRole('article', { name })
      expect(article.hidden).toBe(false)
      if (name === 'code.ts') expect(within(article).getByText('const x = 1')).toBeDefined()
      if (name === 'notes.txt') {
        expect(within(article).getByText((_, element) => element?.tagName === 'PRE'
          && element.textContent === 'plain\ntext')).toBeDefined()
      }
      if (name === 'logo.png') {
        const image = within(article).getByRole('img', { name: 'logo.png' }) as HTMLImageElement
        expect(image.src).toContain('data:image/png;base64,AAAA')
      }
      if (name === 'archive.zip') {
        expect(within(article).getByText(
          zh['preview.unsupported.mime'].replace('{mime}', 'application/zip'),
        )).toBeDefined()
      }
      if (name === 'unknown.bin') expect(within(article).getByText(zh['preview.unsupported'])).toBeDefined()
      if (name === 'doc.md') {
        const calls = b.readFile.mock.calls.length
        fireEvent.click(within(article).getByRole('button', { name: zh['preview.refresh'] }))
        await waitFor(() => { expect(b.readFile.mock.calls.length).toBeGreaterThan(calls) })
      }
    }
  })

  it('shows recoverable tree and preview errors', async () => {
    const listFiles = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(listing('/w', [
        { name: 'bad.txt', type: 'file', segments: ['bad.txt'] },
      ]))
    const readFile = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ path: '/w/bad.txt', content: { kind: 'text', text: 'recovered' } })
    const b = bench({ listFiles, readFile })
    render(<WorkspaceWorkbench {...b.props} />)
    expect((await screen.findByRole('alert')).textContent).toContain(zh['files.error'])
    fireEvent.click(screen.getByRole('button', { name: zh['files.retry'] }))
    fireEvent.click(await screen.findByRole('button', { name: /bad\.txt/ }))
    expect((await screen.findByRole('alert')).textContent).toContain(zh['preview.error'])
    fireEvent.click(screen.getByRole('button', { name: zh['preview.retry'] }))
    expect(await screen.findByText('recovered')).toBeDefined()
  })

  it('drops late directory and file settlements after unmount', async () => {
    const signals: AbortSignal[] = []
    let rejectList: (error: Error) => void = () => {}
    const reads: Array<{
      resolve: (payload: WorkspaceFilePayload) => void
      reject: (error: Error) => void
    }> = []
    const b = bench({
      listFiles: (_segments, signal) => {
        if (signal !== undefined) signals.push(signal)
        return new Promise((_resolve, reject) => { rejectList = reject })
      },
      readFile: (_segments, signal) => {
        if (signal !== undefined) signals.push(signal)
        return new Promise((resolve, reject) => { reads.push({ resolve, reject }) })
      },
    })
    b.instance.actions.openFile({ name: 'resolve.txt', segments: ['resolve.txt'] })
    b.instance.actions.openFile({ name: 'reject.txt', segments: ['reject.txt'] })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    await waitFor(() => { expect(signals).toHaveLength(3) })
    mounted.unmount()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    rejectList(new Error('late list failure'))
    reads[0]?.resolve({ path: '/resolve.txt', content: { kind: 'text', text: 'late' } })
    reads[1]?.reject(new Error('late read failure'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('supersedes an in-flight refresh of the same provider segment key', async () => {
    const requests: Array<{
      signal: AbortSignal | undefined
      resolve: (value: WorkspaceFilesPayload) => void
    }> = []
    const b = bench({
      listFiles: (_segments, signal) => new Promise((resolve) => { requests.push({ signal, resolve }) }),
    })
    render(<WorkspaceWorkbench {...b.props} />)
    await waitFor(() => { expect(requests).toHaveLength(1) })
    fireEvent.click(screen.getByRole('button', { name: zh['preview.refresh'] }))
    await waitFor(() => { expect(requests).toHaveLength(2) })
    expect(requests[0]?.signal?.aborted).toBe(true)
    requests[0]?.resolve(listing('/stale', []))
    requests[1]?.resolve(listing('/fresh', [
      { name: 'fresh.txt', type: 'file', segments: ['fresh.txt'] },
    ]))
    expect(await screen.findByRole('button', { name: /fresh\.txt/ })).toBeDefined()
  })
})
