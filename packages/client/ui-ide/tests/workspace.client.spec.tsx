// @vitest-environment jsdom
/** 工作区三栏、文件标签、版本保存与拖拽分屏的真实组件行为。 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceFilesService, WorkspaceFileEntry } from 'coding-client-ui-open-in-app/client'
import type { WorkspaceId, WorkspaceView } from 'coding-client-runtime/client'
import { IdePage, type IdePageProps } from '../src/client/IdePage.tsx'
import { createIdeStore } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'session-ide' as WorkspaceView['sessionIds'][number]
const WORKSPACE_ID = 'workspace-ide' as WorkspaceId
const WORKSPACE: WorkspaceView = {
  workspaceId: WORKSPACE_ID,
  path: '/repo', title: '示例项目', sessionIds: [SESSION],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
}
const OTHER: WorkspaceView = {
  workspaceId: 'workspace-other' as WorkspaceId,
  path: '/other', title: '另一个项目', sessionIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}
const ROOT_ENTRIES: WorkspaceFileEntry[] = [
  { name: 'src', type: 'directory', segments: ['src'] },
  { name: 'README.md', type: 'file', segments: ['README.md'] },
]
const SRC_ENTRIES: WorkspaceFileEntry[] = [
  { name: 'index.ts', type: 'file', segments: ['src', 'index.ts'], size: 16 },
  { name: 'util.ts', type: 'file', segments: ['src', 'util.ts'], size: 12 },
]

/** jsdom 的 DragEvent 不接收坐标，派生一个带指针位置的事件给落点判定使用。 */
function dragEvent(type: 'dragover' | 'drop', clientX: number, dataTransfer: object, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

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
  enter?: boolean
  workspaces?: readonly WorkspaceView[]
} = {}) {
  const instance = createIdeStore().create()
  if (options.enter !== false) {
    instance.actions.bindSession(WORKSPACE_ID, SESSION)
    instance.actions.enter(WORKSPACE_ID)
  }
  const useIdeState = <T,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => T) =>
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
  const openWorkspace = vi.fn(async (workspaceId: WorkspaceId) => {
    instance.actions.bindSession(workspaceId, (workspaceId === WORKSPACE_ID ? SESSION : 'session-other') as never)
    instance.actions.enter(workspaceId)
  })
  const workspaceFiles: WorkspaceFilesService = {
    list, read, save,
    locate: vi.fn(async () => ({ segments: ['src', 'index.ts'] })),
  }
  const props = {
    closePage,
    toggleAssistant,
    sidebarCollapsed: false,
    sidebarWidth: 280,
    assistantOpen: true,
    assistantPanelId: 'ide-assistant',
    useWorkspaces: (selector: (value: {
      items: readonly WorkspaceView[]
      phase: 'pending' | 'ready'
      state: 'idle' | 'loading' | 'error'
    }) => unknown) => selector({ items: options.workspaces ?? [WORKSPACE, OTHER], phase: 'ready', state: 'idle' }),
    workspaceFiles,
    useIdeState,
    actions: instance.actions,
    createWorkspace: vi.fn(async () => WORKSPACE),
    openWorkspace,
    leaveWorkspace: vi.fn(() => { instance.actions.enter(null) }),
    renderSlot: () => null,
    t: (key: keyof typeof zh, params?: Record<string, string | number>) => {
      const text = zh[key]
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
    },
  }
  const view = render(<IdePage {...(props as unknown as IdePageProps)} />)
  return { view, instance, list, read, save, closePage, toggleAssistant, openWorkspace }
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
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.documents['src/index.ts']?.dirty).toBe(false)
  })

  it('打开编辑器列表可激活文件并双击固定预览', async () => {
    const fixture = setup()
    await openIndex(fixture)
    const opened = within(screen.getByRole('region', { name: zh.openEditors }))
      .getByRole('button', { name: /index\.ts/ })
    fireEvent.click(opened)
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[0]?.activePath).toBe('src/index.ts')
    fireEvent.doubleClick(opened)
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[0]?.previewPath).toBeNull()
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
    fireEvent.doubleClick(screen.getByRole('tab', { name: /README\.md/ }))
    await openIndex(fixture)
    fireEvent.click(screen.getByRole('tab', { name: /README\.md/ }))
    expect(screen.getByRole('tab', { name: /README\.md/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'README.md') }))
    expect(screen.getByRole('tab', { name: /index\.ts/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'index.ts') }))
    expect(screen.getByText(zh.workspaceHeadline)).toBeTruthy()
  })

  it('拖拽新文件固定打开，目标已有标签时自动分屏', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    fireEvent.click(await screen.findByText('src'))
    await screen.findByTitle('index.ts')
    const tree = document.querySelector('button[role="listitem"][title="index.ts"]') as HTMLElement
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => {} }
    const tabs = screen.getByRole('tablist', { name: zh.openFiles })
    const tabBar = tabs.parentElement as HTMLElement
    tabBar.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 36, right: 800, bottom: 36, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.dragLeave(tabs)
    fireEvent.dragStart(tree, { dataTransfer: transfer })
    act(() => { tabs.dispatchEvent(dragEvent('dragover', 10, transfer)) })
    expect(screen.getByText(zh.dropSplit)).toBeTruthy()
    expect(screen.getByText(zh.dropSplit).getAttribute('data-side')).toBe('left')
    expect(transfer.dropEffect).toBe('copy')
    fireEvent.dragLeave(tabs, { relatedTarget: null })
    expect(screen.queryByText(zh.dropSplit)).toBeNull()
    fireEvent.dragOver(tabs, { dataTransfer: transfer })
    act(() => { tabs.dispatchEvent(dragEvent('drop', 10, transfer)) })
    expect(screen.queryByText(zh.dropSplit)).toBeNull()
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    let split = fixture.instance.getSnapshot().views[WORKSPACE_ID]
    expect(split?.panes.map(pane => ({ paths: pane.paths, previewPath: pane.previewPath }))).toEqual([
      { paths: ['src/index.ts'], previewPath: null },
      { paths: ['README.md'], previewPath: 'README.md' },
    ])

    const other = [...document.querySelectorAll('button[role="listitem"]')]
      .find(row => row.getAttribute('title') === 'util.ts') as HTMLElement
    const body = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    body.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.dragStart(other, { dataTransfer: transfer })
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: transfer })
    expect(screen.getByText(zh.dropSplit)).toBeTruthy()
    expect(transfer.dropEffect).toBe('copy')
    fireEvent.dragLeave(body, { relatedTarget: null })
    expect(screen.queryByText(zh.dropSplit)).toBeNull()
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: transfer })
    act(() => { body.dispatchEvent(dragEvent('drop', 10, transfer, 300)) })
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'util.ts') })
    split = fixture.instance.getSnapshot().views[WORKSPACE_ID]
    expect(split?.panes.map(pane => pane.paths)).toEqual([
      ['src/util.ts'], ['src/index.ts'], ['README.md'],
    ])

    const readme = document.querySelector('button[role="listitem"][title="README.md"]') as HTMLElement
    fireEvent.dragStart(readme, { dataTransfer: transfer })
    fireEvent.dragOver(screen.getAllByRole('tablist', { name: zh.openFiles })[0] as HTMLElement,
      { dataTransfer: transfer })
    expect(screen.getByText(zh.dropExisting)).toBeTruthy()
    fireEvent.drop(screen.getAllByRole('tablist', { name: zh.openFiles })[0] as HTMLElement,
      { dataTransfer: transfer })
    split = fixture.instance.getSnapshot().views[WORKSPACE_ID]
    expect(split?.panes).toHaveLength(3)
    expect(split?.panes[2]?.activePath).toBe('README.md')
    expect(split?.activePaneId).toBe(split?.panes[2]?.id)
  })

  it('文件拖到编辑区上沿形成上下分屏，并可在子分组继续嵌套', async () => {
    const fixture = setup({ list: async (_sessionId, segments) => ({
      path: segments.length === 0 ? '/repo' : `/repo/${segments.join('/')}`,
      entries: segments.length === 0
        ? [...ROOT_ENTRIES, { name: 'package.json', type: 'file' as const, segments: ['package.json'] }]
        : SRC_ENTRIES,
      truncated: false,
    }) })
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    fireEvent.doubleClick(screen.getByRole('tab', { name: /README\.md/u }))
    fireEvent.click(await screen.findByText('src'))
    fireEvent.click(await screen.findByTitle('index.ts'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => {} }
    const util = document.querySelector('button[role="listitem"][title="util.ts"]') as HTMLElement
    const body = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    body.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.dragStart(util, { dataTransfer: transfer })
    act(() => { body.dispatchEvent(dragEvent('dragover', 400, transfer, 10)) })
    expect(screen.getByText(zh.dropSplit).getAttribute('data-side')).toBe('top')
    act(() => { body.dispatchEvent(dragEvent('drop', 400, transfer, 10)) })
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'util.ts') })
    let view = fixture.instance.getSnapshot().views[WORKSPACE_ID]
    expect(view?.panes.map(pane => pane.paths)).toEqual([['src/util.ts'], ['README.md', 'src/index.ts']])
    expect(document.querySelector('[data-orientation="column"]')).toBeTruthy()

    const packageFile = document.querySelector('button[role="listitem"][title="package.json"]') as HTMLElement
    const nestedBody = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    nestedBody.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.dragStart(packageFile, { dataTransfer: transfer })
    act(() => { nestedBody.dispatchEvent(dragEvent('dragover', 790, transfer, 300)) })
    expect(screen.getByText(zh.dropSplit).getAttribute('data-side')).toBe('right')
    act(() => { nestedBody.dispatchEvent(dragEvent('drop', 790, transfer, 300)) })
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'package.json') })
    view = fixture.instance.getSnapshot().views[WORKSPACE_ID]
    expect(view?.panes.map(pane => pane.paths)).toEqual([
      ['src/util.ts'], ['package.json'], ['README.md', 'src/index.ts'],
    ])
    expect(document.querySelector('[data-orientation="row"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-orientation="column"]')).toHaveLength(1)
  })

  it('空分组拖拽文件直接固定打开，不创建额外分组', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByTitle('index.ts')
    const row = document.querySelector('button[role="listitem"][title="index.ts"]') as HTMLElement
    const body = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => {} }
    fireEvent.dragStart(row, { dataTransfer: transfer })
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: transfer })
    expect(screen.getByText(zh.dropFile)).toBeTruthy()
    fireEvent.drop(body, { clientX: 10, dataTransfer: transfer })
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes).toHaveLength(1)
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[0]).toMatchObject({
      paths: ['src/index.ts'], previewPath: null,
    })
  })

  it('拖动文件时显示打开提示而不显示拆分提示，拖拽结束后回收状态', async () => {
    setup()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByTitle('index.ts')
    const row = document.querySelector('button[role="listitem"][title="index.ts"]') as HTMLElement
    const main = screen.getByRole('main', { name: zh.title })
    const body = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => {} }
    fireEvent.dragStart(row, { dataTransfer: transfer })
    expect(main.getAttribute('data-dragging')).toBe('file')
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: transfer })
    expect(screen.getByText(zh.dropFile)).toBeTruthy()
    expect(screen.queryByText(zh.dropLeft)).toBeNull()
    fireEvent.dragEnd(row)
    expect(main.hasAttribute('data-dragging')).toBe(false)
    expect(screen.queryByText(zh.dropFile)).toBeNull()
  })

  it('Escape 取消文件拖拽且不离开页面', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByTitle('index.ts')
    const row = document.querySelector('button[role="listitem"][title="index.ts"]') as HTMLElement
    const body = screen.getAllByRole('region', { name: /编辑器分组/u })[0]?.querySelector('[data-pane-body]') as HTMLElement
    fireEvent.dragStart(row, { dataTransfer: { effectAllowed: 'none', dropEffect: 'none', setData: () => {} } })
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: { effectAllowed: 'none', dropEffect: 'none', setData: () => {} } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(zh.dropFile)).toBeNull()
    expect(fixture.closePage).not.toHaveBeenCalled()
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
    fireEvent.click(document.querySelector('button[role="listitem"][title="index.ts"]') as Element)
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

  it('切换工作区保留另一个工作区已打开的标签并按工作区重新读取', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByText('README.md'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    expect(screen.getByRole('heading', { name: WORKSPACE.title })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    fireEvent.click(await screen.findByRole('menuitem', { name: OTHER.title }))
    await waitFor(() => { expect(fixture.openWorkspace).toHaveBeenCalledWith(OTHER.workspaceId) })
    await screen.findByRole('heading', { name: OTHER.title })

    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    fireEvent.click(await screen.findByRole('menuitem', { name: WORKSPACE.title }))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'README.md') })
    expect(fixture.instance.getSnapshot().views[OTHER.workspaceId]?.panes[0]?.paths).toEqual([])
  })

  it('拖动标签到编辑区侧边形成新分组，拖动到另一组标签栏则移动标签', async () => {
    const fixture = setup()
    await openIndex(fixture)
    fireEvent.doubleClick(screen.getByRole('tab', { name: /index\.ts/ }))
    fireEvent.click(screen.getByText('util.ts'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'util.ts') })
    const transfer = { effectAllowed: 'none', setData: () => {} }
    const dragTab = (name: RegExp): Element =>
      screen.getByRole('tab', { name }).closest('[draggable="true"]') as Element
    const bodyOf = (index: number): HTMLElement =>
      screen.getAllByRole('region', { name: zh.paneLabel.replace('{index}', String(index + 1)) })[0]
        ?.querySelector('[data-pane-body]') as HTMLElement

    const body = bodyOf(0)
    body.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    fireEvent.dragStart(dragTab(/util\.ts/u), { dataTransfer: transfer })
    fireEvent.dragOver(body, { clientX: 900, dataTransfer: transfer })
    fireEvent.dragOver(body, { clientX: 10, dataTransfer: transfer })
    fireEvent.dragOver(body, { clientX: 900, dataTransfer: transfer })
    fireEvent.dragLeave(body)
    act(() => { body.dispatchEvent(dragEvent('dragover', 790, transfer, 300)) })
    act(() => { body.dispatchEvent(dragEvent('drop', 790, transfer, 300)) })
    const split = fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []
    expect(split).toHaveLength(2)
    expect(split[1]?.paths).toEqual(['src/util.ts'])

    // 拖到另一组的标签栏把标签移过去，而不是再拆一屏。
    fireEvent.dragStart(dragTab(/index\.ts/u), { dataTransfer: transfer })
    const targetTabs = screen.getAllByRole('tablist')[1] as HTMLElement
    fireEvent.dragOver(targetTabs, { dataTransfer: transfer })
    fireEvent.drop(targetTabs, { dataTransfer: transfer })
    // 源分组被搬空后随之收起，标签都留在目标分组里。
    const moved = fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []
    expect(moved.map(pane => pane.paths)).toEqual([['src/util.ts', 'src/index.ts']])

    // 没有拖动时落点忽略事件。
    fireEvent.dragOver(targetTabs, { dataTransfer: transfer })
    fireEvent.drop(targetTabs, { dataTransfer: transfer })
    fireEvent.drop(bodyOf(0), { clientX: 900, dataTransfer: transfer })

    // 只有一个分组时不渲染关闭按钮。
    expect(screen.queryByRole('button', { name: zh.closePane.replace('{index}', '1') })).toBeNull()
  })
})

describe('IDE 编辑器分组交互', () => {
  it('拖动落点按指针所在半区判定，未拖动时落点与拖出事件都不改状态', async () => {
    const fixture = setup()
    await openIndex(fixture)
    fireEvent.doubleClick(screen.getByRole('tab', { name: /index\.ts/ }))
    fireEvent.click(screen.getByText('util.ts'))
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'util.ts') })
    const transfer = { effectAllowed: 'none', setData: () => {} }
    const paneRegion = (index: number): HTMLElement =>
      screen.getByRole('region', { name: zh.paneLabel.replace('{index}', String(index + 1)) })
    const tabsOf = (index: number): HTMLElement =>
      paneRegion(index).querySelector('[role="tablist"]') as HTMLElement
    const bodyOf = (index: number): HTMLElement =>
      paneRegion(index).querySelector('[data-pane-body]') as HTMLElement

    // 没有拖动时，标签栏与编辑区的落点事件都被忽略。
    fireEvent.dragOver(tabsOf(0), { dataTransfer: transfer })
    fireEvent.drop(tabsOf(0), { dataTransfer: transfer })
    fireEvent.drop(bodyOf(0), { clientX: 900, dataTransfer: transfer })
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []).toHaveLength(1)

    // 指针停在左半区时提示出现，随后落点按该侧拆分。
    // jsdom 没有布局，`fireEvent` 也不带 pointer 坐标：这里给出内容区矩形并直接派发带 clientX 的事件。
    const dragTab = screen.getByRole('tab', { name: /util\.ts/u }).closest('[draggable="true"]') as Element
    fireEvent.dragStart(dragTab, { dataTransfer: transfer })
    const body = bodyOf(0)
    body.getBoundingClientRect = () => ({
      left: 0, width: 800, top: 0, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    })
    act(() => { body.dispatchEvent(dragEvent('dragover', 10, transfer, 300)) })
    expect(screen.getByText(zh.dropLeft)).toBeTruthy()
    act(() => { body.dispatchEvent(dragEvent('drop', 10, transfer, 300)) })
    const leftSplit = fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []
    expect(leftSplit.map(pane => pane.paths)).toEqual([['src/util.ts'], ['src/index.ts']])
    expect(leftSplit[0]?.paths).toEqual(['src/util.ts'])

    // 提示归属另一个分组时，在别的分组上离开不清除提示。
    const regionsAfter = screen.getAllByRole('region', { name: /编辑器分组/u })
    fireEvent.dragStart(dragTab, { dataTransfer: transfer })
    fireEvent.dragOver(regionsAfter[0]?.querySelector('[data-pane-body]') as HTMLElement,
      { clientX: 900, dataTransfer: transfer })
    fireEvent.dragLeave(regionsAfter[1]?.querySelector('[data-pane-body]') as HTMLElement)
    fireEvent.dragEnd(dragTab)
    // 没有拖动时在内容区上移动指针被忽略。
    fireEvent.dragOver(regionsAfter[0]?.querySelector('[data-pane-body]') as HTMLElement, { clientX: 900 })

    // 关闭第二个分组后回到单栏。
    fireEvent.click(screen.getByRole('button', { name: zh.closePane.replace('{index}', '2') }))
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []).toHaveLength(1)
  })

  it('页头拆分、保存与分组聚焦按钮各自触发对应动作', async () => {
    const fixture = setup()
    await openIndex(fixture)
    fireEvent.click(screen.getByRole('button', { name: zh.split }))
    const split = fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []
    expect(split.map(pane => pane.paths)).toEqual([['src/index.ts'], ['src/index.ts']])

    // 两个分组各有一份编辑器；点到哪一组就把焦点交给哪一组。
    const regions = screen.getAllByRole('region', { name: /编辑器分组/u })
    expect(regions).toHaveLength(2)
    fireEvent.focus(screen.getAllByRole('textbox')[1] as HTMLElement)
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.activePaneId)
      .toBe(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[1]?.id)
    fireEvent.pointerDown(regions[0] as HTMLElement)
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.activePaneId)
      .toBe(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[0]?.id)

    const editor = screen.getAllByRole('textbox')[0] as HTMLElement
    fireEvent.change(editor, { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(fixture.save).toHaveBeenCalledOnce() })
  })

  it('切换工作区失败时留在原工作区，不弹确认也不丢状态', async () => {
    const fixture = setup()
    await openIndex(fixture)
    fixture.openWorkspace.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    fireEvent.click(await screen.findByRole('menuitem', { name: OTHER.title }))
    await waitFor(() => { expect(fixture.openWorkspace).toHaveBeenCalledWith(OTHER.workspaceId) })
    expect(screen.getByRole('heading', { name: WORKSPACE.title })).toBeTruthy()
    expect(fixture.instance.getSnapshot().workspaceId).toBe(WORKSPACE_ID)
  })

  it('重新进入工作区时补读上次被中断的正文', async () => {
    const read = vi.fn<WorkspaceFilesService['read']>(async (_sessionId, segments) => ({
      path: `/repo/${segments.join('/')}`,
      version: 'v1',
      content: { kind: 'code' as const, text: 'const value = 1\n', language: 'ts' },
    }))
    const instance = createIdeStore().create()
    instance.actions.bindSession(WORKSPACE_ID, SESSION)
    instance.actions.enter(WORKSPACE_ID)
    // 模拟上次读取被中断：标签停在 loading，正文为空。
    instance.actions.openTab(WORKSPACE_ID, 'src/index.ts', 'index.ts', ['src', 'index.ts'])
    const useIdeState = <T,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => T) =>
      useSyncExternalStore(listener => instance.subscribe(listener), () => selector(instance.getSnapshot()),
        () => selector(instance.getSnapshot()))
    const workspaceFiles: WorkspaceFilesService = {
      list: async () => ({ path: '/repo', entries: ROOT_ENTRIES, truncated: false }),
      read,
      save: vi.fn(),
      locate: vi.fn(),
    }
    const props = {
      closePage: vi.fn(), toggleAssistant: vi.fn(), sidebarCollapsed: false, sidebarWidth: 280,
      assistantOpen: true, assistantPanelId: 'ide-assistant',
      useWorkspaces: (selector: (value: { items: readonly WorkspaceView[]; phase: 'ready'; state: 'idle' }) => unknown) =>
        selector({ items: [WORKSPACE], phase: 'ready', state: 'idle' }),
      workspaceFiles, useIdeState, actions: instance.actions,
      createWorkspace: vi.fn(), openWorkspace: vi.fn(), leaveWorkspace: vi.fn(),
      renderSlot: () => null,
      t: (key: keyof typeof zh, params?: Record<string, string | number>) => {
        const text = zh[key]
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
      },
    }
    render(<IdePage {...(props as unknown as IdePageProps)} />)
    await screen.findByRole('textbox', { name: zh.editorLabel.replace('{name}', 'index.ts') })
    expect(read).toHaveBeenCalledWith(SESSION, ['src', 'index.ts'], expect.any(AbortSignal))
  })

  it('切换菜单选中当前工作区时不重复进入，分组标签可点击与取消拖动', async () => {
    const fixture = setup()
    await openIndex(fixture)
    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    // 菜单也可以直接收起而不选任何项。
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    fireEvent.click(await screen.findByRole('menuitem', { name: WORKSPACE.title }))
    expect(fixture.openWorkspace).not.toHaveBeenCalled()

    const transfer = { effectAllowed: 'none', setData: () => {} }
    const dragTab = screen.getByRole('tab', { name: /index\.ts/u }).closest('[draggable="true"]') as Element
    fireEvent.dragStart(dragTab, { dataTransfer: transfer })
    fireEvent.dragEnd(dragTab)
    // 拖动取消后落点不再生效。
    fireEvent.drop(screen.getAllByRole('tablist')[0] as HTMLElement, { dataTransfer: transfer })
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes ?? []).toHaveLength(1)

    fireEvent.click(screen.getByRole('tab', { name: /index\.ts/u }))
    expect(fixture.instance.getSnapshot().views[WORKSPACE_ID]?.panes[0]?.activePath).toBe('src/index.ts')
  })
})

describe('IDE 欢迎页与状态独立', () => {
  it('没有记住工作区时先进欢迎页，不因为对话页已有工作区就进入三栏', async () => {
    const fixture = setup({ enter: false })
    expect(screen.getByRole('heading', { name: zh.headline })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: WORKSPACE.title })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /示例项目/u }))
    await waitFor(() => { expect(fixture.openWorkspace).toHaveBeenCalledWith(WORKSPACE_ID) })
    expect(await screen.findByRole('heading', { name: WORKSPACE.title })).toBeTruthy()
  })

  it('页头菜单可以回到欢迎页重新选择文件夹', async () => {
    const fixture = setup()
    fireEvent.click(screen.getByRole('button', { name: zh.switchWorkspace }))
    fireEvent.click(await screen.findByRole('menuitem', { name: zh.openOtherFolder }))
    expect(fixture.instance.getSnapshot().workspaceId).toBeNull()
    expect(await screen.findByRole('button', { name: zh.openFolder })).toBeTruthy()
  })
})
