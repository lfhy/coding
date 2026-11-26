// @vitest-environment jsdom
/** 工作区三栏、文件标签、版本保存与冲突恢复的真实组件行为。 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceFilesService, WorkspaceFileEntry } from 'coding-client-ui-open-in-app/client'
import type { WorkspaceView } from 'coding-client-runtime/client'
import { IdePage, type IdePageProps } from '../src/client/IdePage.tsx'
import { createIdeWorkspaceStore } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'session-ide' as WorkspaceView['sessionIds'][number]
const WORKSPACE: WorkspaceView = {
  workspaceId: 'workspace-ide' as WorkspaceView['workspaceId'],
  path: '/repo', title: '示例项目', sessionIds: [SESSION],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
}
const ROOT_ENTRIES: WorkspaceFileEntry[] = [
  { name: 'src', type: 'directory', segments: ['src'] },
  { name: 'README.md', type: 'file', segments: ['README.md'] },
]
const SRC_ENTRIES: WorkspaceFileEntry[] = [
  { name: 'index.ts', type: 'file', segments: ['src', 'index.ts'], size: 16 },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(options: {
  read?: WorkspaceFilesService['read']
  save?: WorkspaceFilesService['save']
  list?: WorkspaceFilesService['list']
} = {}) {
  const instance = createIdeWorkspaceStore().create(SESSION)
  const useStore = <T,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => T) =>
    useSyncExternalStore(listener => instance.subscribe(listener), () => selector(instance.getSnapshot()),
      () => selector(instance.getSnapshot()))
  const list = vi.fn(options.list ?? (async (_sessionId, segments) => ({
    path: segments.length === 0 ? '/repo' : `/repo/${segments.join('/')}`,
    entries: segments.length === 0 ? ROOT_ENTRIES : SRC_ENTRIES,
    truncated: false,
  })))
  const read = vi.fn(options.read ?? (async (_sessionId, segments) => ({
    path: `/repo/${segments.join('/')}`,
    version: 'v1',
    content: { kind: 'code' as const, text: 'const value = 1\n', language: 'ts' },
  })))
  const save = vi.fn(options.save ?? (async () => ({
    ok: true as const,
    value: { path: '/repo/src/index.ts', version: 'v2', operation: 'update' as const },
  })))
  const closePage = vi.fn()
  const toggleAssistant = vi.fn()
  const workspaceFiles: WorkspaceFilesService = {
    list, read, save,
    locate: vi.fn(async () => ({ segments: ['src', 'index.ts'] })),
  }
  const props = {
    sessionId: SESSION,
    closePage,
    toggleAssistant,
    sidebarCollapsed: false,
    sidebarWidth: 280,
    assistantOpen: true,
    assistantPanelId: 'ide-assistant',
    useWorkspaces: (selector: (value: { items: readonly WorkspaceView[]; phase: 'pending' | 'ready'; state: 'idle' | 'loading' | 'error' }) => unknown) =>
      selector({ items: [WORKSPACE], phase: 'ready', state: 'idle' }),
    workspaceFiles,
    useStore,
    actions: instance.actions,
    createWorkspace: vi.fn(),
    openWorkspace: vi.fn(async () => {}),
    renderSlot: () => null,
    t: (key: keyof typeof zh, params?: Record<string, string | number>) => {
      const text = zh[key]
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
    },
  }
  const view = render(<IdePage {...(props as unknown as IdePageProps)} />)
  return { view, instance, list, read, save, closePage, toggleAssistant }
}

async function openIndex(_fixture: ReturnType<typeof setup>): Promise<void> {
  fireEvent.click(await screen.findByText('src'))
  fireEvent.click(await screen.findByText('index.ts'))
  await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
}

describe('IDE 工作区三栏', () => {
  it('加载根目录，显示文件树与空编辑区，并复用页面助手开关', async () => {
    const fixture = setup()
    expect(await screen.findByText('README.md')).toBeTruthy()
    expect(fixture.list).toHaveBeenCalledWith(SESSION, [], expect.any(AbortSignal))
    expect(screen.getByRole('heading', { name: WORKSPACE.title })).toBeTruthy()
    expect(screen.getByText(zh.workspaceHeadline)).toBeTruthy()
    const assistant = screen.getByRole('button', { name: zh.assistant })
    expect(assistant.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(assistant)
    expect(fixture.toggleAssistant).toHaveBeenCalledOnce()
  })

  it('按需展开目录、打开标签，并用快捷键按版本保存', async () => {
    const fixture = setup()
    await openIndex(fixture)
    expect(fixture.list).toHaveBeenCalledWith(SESSION, ['src'], expect.any(AbortSignal))
    expect(fixture.read).toHaveBeenCalledWith(SESSION, ['src', 'index.ts'], expect.any(AbortSignal))
    await act(async () => { window.dispatchEvent(new Event('blur')) })
    expect(fixture.save).not.toHaveBeenCalled()
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'const value = 2\n' } })
    expect(screen.getByText(zh.unsaved)).toBeTruthy()
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(fixture.save).toHaveBeenCalledWith(SESSION, ['src', 'index.ts'], 'v1', 'const value = 2\n')
    })
    await screen.findByText(zh.saved)
    expect(fixture.instance.getSnapshot().tabs[0]?.dirty).toBe(false)
  })

  it('保存冲突保留草稿，确认重新载入后恢复服务端内容', async () => {
    const fixture = setup({
      save: async () => ({ ok: false, error: { status: 409, code: 'file-conflict' } }),
    })
    await openIndex(fixture)
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await screen.findByText(zh.conflictKept)
    expect(editor).toHaveProperty('value', 'draft')
    fireEvent.change(editor, { target: { value: 'draft2' } })
    expect(screen.getByText(zh.conflictKept)).toBeTruthy()
    expect(editor).toHaveProperty('value', 'draft2')
    fireEvent.click(screen.getByRole('button', { name: zh.reload }))
    const dialog = screen.getByRole('dialog', { name: zh.reloadTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.reload }))
    await waitFor(() => { expect(fixture.read).toHaveBeenCalledTimes(2) })
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') }))
        .toHaveProperty('value', 'const value = 1\n')
    })
  })

  it('关闭未保存标签前要求确认，取消保留、确认丢弃', async () => {
    const fixture = setup()
    await openIndex(fixture)
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'index.ts') }))
    expect(screen.getByRole('dialog', { name: zh.discardTitle })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.discardTitle })).getByRole('button', { name: zh.cancel }))
    expect(screen.getByRole('tab', { name: /index\.ts/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'index.ts') }))
    fireEvent.click(screen.getByRole('button', { name: zh.discard }))
    expect(screen.queryByRole('tab', { name: /index\.ts/ })).toBeNull()
    expect(screen.getByText(zh.workspaceHeadline)).toBeTruthy()
  })

  it('Escape 先保存草稿，保存成功后离开 IDE 页', async () => {
    const fixture = setup()
    await openIndex(fixture)
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(fixture.closePage).toHaveBeenCalledOnce() })
    expect(fixture.save).toHaveBeenCalledOnce()
  })

  it('保存失败时保留页面与草稿，重试重新提交', async () => {
    const save = vi.fn<WorkspaceFilesService['save']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: { path: '/repo/src/index.ts', version: 'v2', operation: 'update' } })
    const fixture = setup({ save })
    await openIndex(fixture)
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    await screen.findByText(zh.draftKept)
    expect(fixture.closePage).not.toHaveBeenCalled()
    expect(editor).toHaveProperty('value', 'draft')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
  })

  it('目录读取失败显示重试，恢复后展示文件', async () => {
    const list = vi.fn<WorkspaceFilesService['list']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ path: '/repo', entries: ROOT_ENTRIES, truncated: false })
    const fixture = setup({ list })
    await screen.findByRole('alert')
    expect(screen.getByText(zh.treeError)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(await screen.findByText('README.md')).toBeTruthy()
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })

  it('非文本与过大文件只显示明确状态，不进入编辑', async () => {
    const first = setup({
      read: async () => ({ path: '/repo/image.png', version: 'v1', content: { kind: 'image', mimeType: 'image/png', data: 'AA==' } }),
    })
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByText(zh.unsupported)
    expect(screen.queryByRole('textbox')).toBeNull()
    first.view.unmount()

    setup({
      read: async () => ({ path: '/repo/big.bin', version: 'v1', content: { kind: 'unsupported', reason: 'too-large' } }),
    })
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByText(zh.tooLarge)
  })

  it('文件读取失败后可重试，成功后进入编辑', async () => {
    const read = vi.fn<WorkspaceFilesService['read']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ path: '/repo/README.md', version: 'v1', content: { kind: 'text', text: '# Readme' } })
    const fixture = setup({ read })
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByText(zh.loadError)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    expect(fixture.read).toHaveBeenCalledTimes(2)
  })

  it('多个标签切换与关闭后选中相邻标签', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    await openIndex(fixture)
    fireEvent.click(screen.getByRole('tab', { name: /README\.md/ }))
    expect(screen.getByRole('tab', { name: /README\.md/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'README.md') }))
    expect(screen.getByRole('tab', { name: /index\.ts/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'index.ts') }))
    expect(screen.getByText(zh.workspaceHeadline)).toBeTruthy()
  })

  it('失焦自动保存活动草稿', async () => {
    const fixture = setup()
    await openIndex(fixture)
    const editor = screen.getByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    fireEvent.change(editor, { target: { value: 'draft' } })
    await act(async () => { window.dispatchEvent(new Event('blur')) })
    await waitFor(() => { expect(fixture.save).toHaveBeenCalledOnce() })
  })

  it('重复打开已加载标签不重复读取，目录折叠与重开也不重复请求', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('src'))
    fireEvent.click(await screen.findByText('index.ts'))
    await screen.findByRole('textbox')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByTitle('index.ts'))
    expect(fixture.list.mock.calls.filter(call => call[1].length === 1)).toHaveLength(1)
    expect(fixture.read).toHaveBeenCalledOnce()
  })

  it('快速重开目录会取消旧请求，只接受最后一次目录结果', async () => {
    const first = deferred<Awaited<ReturnType<WorkspaceFilesService['list']>>>()
    const second = deferred<Awaited<ReturnType<WorkspaceFilesService['list']>>>()
    const list = vi.fn<WorkspaceFilesService['list']>()
      .mockResolvedValueOnce({ path: '/repo', entries: ROOT_ENTRIES, truncated: false })
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    setup({ list })
    fireEvent.click(await screen.findByText('src'))
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('src'))
    await act(async () => { first.reject(new Error('cancelled')) })
    expect(screen.queryByText('index.ts')).toBeNull()
    await act(async () => { second.resolve({ path: '/repo/src', entries: SRC_ENTRIES, truncated: false }) })
    expect(await screen.findByText('index.ts')).toBeTruthy()
  })

  it('关闭页面会取消在途目录与文件读取，迟到响应不再写入', async () => {
    const root = deferred<Awaited<ReturnType<WorkspaceFilesService['list']>>>()
    const rootFixture = setup({ list: () => root.promise })
    rootFixture.view.unmount()
    await act(async () => { root.resolve({ path: '/repo', entries: ROOT_ENTRIES, truncated: false }) })

    const read = deferred<Awaited<ReturnType<WorkspaceFilesService['read']>>>()
    const fileFixture = setup({ read: () => read.promise })
    fireEvent.click(await screen.findByText('README.md'))
    fileFixture.view.unmount()
    await act(async () => {
      read.resolve({ path: '/repo/README.md', version: 'v1', content: { kind: 'text', text: 'late' } })
    })

    const failedRead = deferred<Awaited<ReturnType<WorkspaceFilesService['read']>>>()
    const failedFixture = setup({ read: () => failedRead.promise })
    fireEvent.click(await screen.findByText('README.md'))
    failedFixture.view.unmount()
    await act(async () => { failedRead.reject(new Error('cancelled')) })
  })

  it('普通保存拒绝、重复保存与卸载在途保存都保持草稿安全', async () => {
    const rejected = setup({ save: async () => ({ ok: false, error: { status: 500, code: 'workspace-save-failed' } }) })
    await openIndex(rejected)
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await screen.findByText(zh.draftKept)
    expect(editor).toHaveProperty('value', 'draft')
    rejected.view.unmount()

    const pending = deferred<Awaited<ReturnType<WorkspaceFilesService['save']>>>()
    const save = vi.fn<WorkspaceFilesService['save']>(() => pending.promise)
    const fixture = setup({ save })
    await openIndex(fixture)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect(screen.getByText(zh.saving)).toBeTruthy()
    fireEvent.keyDown(field, { key: 's', ctrlKey: true })
    expect(save).toHaveBeenCalledOnce()
    fixture.view.unmount()
    await act(async () => {
      pending.resolve({ ok: true, value: { path: '/repo/src/index.ts', version: 'v2', operation: 'update' } })
    })
  })

  it('离开前拦截仅在有草稿时触发，Escape 不抢占弹层或已取消事件', async () => {
    const fixture = setup()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    await act(async () => { window.dispatchEvent(new Event('blur')) })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(fixture.closePage).toHaveBeenCalledOnce() })

    await openIndex(fixture)
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'draft' } })
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    const cancelled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    cancelled.preventDefault()
    document.dispatchEvent(cancelled)
    expect(fixture.closePage).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'index.ts') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fixture.closePage).toHaveBeenCalledTimes(1)
  })

  it('重载确认层可以通过关闭或取消退出，不丢失冲突草稿', async () => {
    const fixture = setup({ save: async () => ({ ok: false, error: { status: 409, code: 'file-conflict' } }) })
    await openIndex(fixture)
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'draft' } })
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    await screen.findByText(zh.conflictKept)
    fireEvent.click(screen.getByRole('button', { name: zh.reload }))
    let dialog = screen.getByRole('dialog', { name: zh.reloadTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.reload }))
    dialog = screen.getByRole('dialog', { name: zh.reloadTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(editor).toHaveProperty('value', 'draft')
  })
})
