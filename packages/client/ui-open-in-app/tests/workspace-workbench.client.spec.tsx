// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkbenchStore, createRetainedWorkbenchStore } from '../src/client/store.ts'
import {
  formatBytes,
  sortTreeEntries,
  WorkspaceWorkbench,
  type WorkspaceWorkbenchProps,
} from '../src/client/WorkspaceWorkbench.tsx'
import { zh } from '../src/client/locales.ts'
vi.mock('../src/client/TerminalPanel.tsx', () => ({
  TerminalPanel: ({ shown, panelId }: { shown: boolean; panelId: string }) =>
    <section hidden={!shown} id={panelId} data-testid="right-terminal" />,
}))

import type { WorkspaceFileEntry, WorkspaceFilePayload, WorkspaceFilesPayload } from '../src/client/wire.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
  listFiles?: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilesPayload>
  readFile?: (segments: readonly string[], signal?: AbortSignal) => Promise<WorkspaceFilePayload>
  initialView?: 'menu' | 'files' | 'browser'
} = {}) {
  const rootInstance = createRetainedWorkbenchStore().create()
  rootInstance.actions.initSession(SESSION)
  const instance = {
    store: { getSnapshot: () => rootInstance.store.getSnapshot().sessions[SESSION]! },
    getSnapshot: () => rootInstance.store.getSnapshot().sessions[SESSION]!,
    actions: Object.fromEntries(Object.entries(rootInstance.actions)
      .map(([key, action]) => [key, (...args: never[]) => { action(SESSION as never, ...args) }])) as ReturnType<ReturnType<typeof createWorkbenchStore>['create']>['actions'],
  }
  if (over.initialView !== undefined) instance.actions.setView(over.initialView)
  const closeWorkbench = vi.fn()
  const toggleWorkbenchFullscreen = vi.fn()
  const toggleBottom = vi.fn()
  const openWorkbench = vi.fn()
  const renderSlot = vi.fn((name: string) => <div data-testid={name === 'workbench.browser'
    ? 'browser-contribution' : 'browser-tabs-contribution'} />)
  const listFiles = vi.fn(over.listFiles ?? (async () => listing('/workspace', [])))
  const readFile = vi.fn(over.readFile ?? (async (): Promise<WorkspaceFilePayload> => ({
    path: '/workspace/file', content: { kind: 'text', text: '' },
  })))
  const props = {
    sessionId: SESSION,
    shown: over.shown ?? true,
    fullscreen: over.fullscreen ?? false,
    bottomOpen: over.bottomOpen ?? false,
    closeWorkbench,
    openWorkbench,
    toggleWorkbenchFullscreen,
    toggleBottom,
    useStore: bindSnapshotSelector(rootInstance.store),
    actions: rootInstance.actions,
    useSessions: (selector: (state: { ids: readonly SessionId[]; current: SessionId }) => unknown) =>
      selector({ ids: [SESSION], current: SESSION }),
    renderSlot,
    listFiles: (_sessionId: SessionId, segments: readonly string[], signal?: AbortSignal) => listFiles(segments, signal),
    readFile: (_sessionId: SessionId, segments: readonly string[], signal?: AbortSignal) => readFile(segments, signal),
    terminalUrl: (id: SessionId) => `ws://test/terminal?sessionId=${id}`,
    t,
  } as unknown as WorkspaceWorkbenchProps
  return { instance, props, closeWorkbench, openWorkbench, renderSlot,
    toggleWorkbenchFullscreen, toggleBottom, listFiles, readFile }
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
  it('功能菜单的终端与其他入口采用同尺寸线性 SVG', () => {
    const b = bench()
    render(<WorkspaceWorkbench {...b.props} />)
    const menu = screen.getByRole('navigation', { name: zh['workbench.menu.label'] })
    const icons = within(menu).getAllByRole('button', { hidden: true })
      .map(button => button.querySelector('svg'))
    expect(icons).toHaveLength(5)
    for (const icon of icons) {
      expect(icon?.getAttribute('width')).toBe('18')
      expect(icon?.getAttribute('height')).toBe('18')
    }
    const terminal = within(menu).getByRole('button', { name: zh['workbench.menu.terminal'] })
    expect(terminal.querySelector('svg rect')?.getAttribute('stroke')).toBe('currentColor')
    expect(terminal.querySelector('.semi-icon')).toBeNull()
  })

  it('waits for the workbench to be shown before reading the workspace root', async () => {
    const b = bench({ shown: false, initialView: 'files' })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    expect(b.listFiles).not.toHaveBeenCalled()
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown />)
    await waitFor(() => {
      expect(b.listFiles).toHaveBeenCalledExactlyOnceWith([], expect.any(AbortSignal))
    })
  })

  it('keeps the terminal panel control in the top bar when fullscreen hides the conversation header', () => {
    const b = bench({ fullscreen: true, bottomOpen: true, initialView: 'files' })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    const fullscreen = screen.getByRole('button', { name: zh['workbench.fullscreen.exit'] })
    expect(fullscreen.getAttribute('aria-pressed')).toBe('true')
    const bottom = screen.getByRole('button', { name: zh['workbench.bottom.hide'] })
    expect(bottom.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: /文件侧栏/ })).toBeNull()
    fireEvent.click(bottom)
    expect(b.toggleBottom).toHaveBeenCalledOnce()
    mounted.rerender(<WorkspaceWorkbench {...b.props} bottomOpen={false} />)
    const showBottom = screen.getByRole('button', { name: zh['workbench.bottom.show'] })
    expect(showBottom.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(showBottom)
    expect(b.toggleBottom).toHaveBeenCalledTimes(2)
    fireEvent.click(fullscreen)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.close'] }))
    expect(b.toggleWorkbenchFullscreen).toHaveBeenCalledOnce()
    expect(b.closeWorkbench).toHaveBeenCalledOnce()
    const topbar = screen.getByRole('region', { name: zh['workbench.label'] })
      .querySelector('header') as HTMLElement
    expect(topbar.hasAttribute('data-window-drag-region')).toBe(true)
    expect(within(topbar).getAllByRole('button')
      .filter(button => !button.classList.contains('tabSelect') && !button.classList.contains('tabClose')))
      .toHaveLength(5)
  })

  it('switches browser and files without unmounting the browser child or clearing file tabs', async () => {
    const b = bench()
    b.instance.actions.openFile({ name: 'kept.txt', segments: ['kept.txt'] })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    const browser = screen.getByTestId('browser-contribution')
    act(() => { b.instance.actions.syncBrowserTabs([{ id: 'kept-page', name: 'Kept page' }], 'kept-page') })
    const browserTabs = screen.getByTestId('browser-tabs-contribution')
    const topbar = mounted.container.querySelector('header') as HTMLElement
    expect(topbar.contains(browserTabs)).toBe(true)
    expect(browserTabs.parentElement?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    expect(b.openWorkbench).toHaveBeenCalledOnce()
    expect(b.instance.store.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:kept-page' })
    expect(screen.getByTestId('browser-contribution')).toBe(browser)
    expect(screen.getByTestId('browser-tabs-contribution')).toBe(browserTabs)
    expect(browserTabs.parentElement?.hasAttribute('hidden')).toBe(false)
    const browserPanel = browser.closest('[role="tabpanel"]') as HTMLElement
    expect(browserPanel.id).not.toBe('')
    expect(b.renderSlot).toHaveBeenCalledWith('workbench.browser.tabs', expect.objectContaining({
      tabId: 'kept-page', tabDomId: browserPanel.getAttribute('aria-labelledby'), panelDomId: browserPanel.id,
    }))
    expect(b.renderSlot).toHaveBeenLastCalledWith('workbench.browser', expect.objectContaining({ shown: true }))
    expect(b.renderSlot).toHaveBeenCalledWith('workbench.browser.tabs', expect.objectContaining({ shown: true }))
    expect((mounted.container.querySelector('main > div:first-child') as HTMLElement).hidden).toBe(true)
    expect(mounted.container.querySelector('main > div:first-child')?.hasAttribute('inert')).toBe(true)
    expect(mounted.container.querySelector('aside')?.hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    expect(b.instance.store.getSnapshot().view).toBe('files')
    expect(b.renderSlot).toHaveBeenLastCalledWith('workbench.browser', expect.objectContaining({ shown: false }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    const owner = (b.renderSlot as unknown as { mock: { lastCall?: [string, {
      openBrowser: () => void
    }] } }).mock.lastCall?.[1]
    expect(owner).toBeDefined()
    if (!owner) throw new Error('browser slot owner was not registered')
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    expect(b.instance.store.getSnapshot().view).toBe('menu')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    act(() => { owner.openBrowser() })
    expect(b.instance.store.getSnapshot().view).toBe('browser')
    expect(b.openWorkbench).toHaveBeenCalledTimes(3)
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} />)
    expect(b.renderSlot).toHaveBeenLastCalledWith('workbench.browser', expect.objectContaining({ shown: false }))
    expect(screen.getByTestId('browser-contribution')).toBe(browser)
  })

  it('retains consumed browser requests and never focuses a disabled or hidden browser tab', () => {
    const b = bench()
    b.renderSlot.mockImplementation(name => name === 'workbench.browser.tabs'
      ? <button type="button" role="tab" data-browser-tab-id="new-page">New page</button>
      : <div data-testid="browser-contribution" />)
    render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    const owner = (b.renderSlot as unknown as { mock: { lastCall?: [string, {
      newTabRequest: number
      handledTabRequest: number
      markTabRequestHandled: (request: number) => void
      focusBrowserTab: (tabId: string) => void
      focusPendingBrowserTab: (tabId: string) => void
      syncBrowserTabs: (tabs: readonly { id: string; name: string }[], activeId: string) => void
    }] } }).mock.lastCall?.[1]
    if (!owner) throw new Error('browser slot owner was not registered')
    expect(owner.newTabRequest).toBe(1)
    act(() => { owner.markTabRequestHandled(1) })
    expect(b.renderSlot).toHaveBeenLastCalledWith('workbench.browser', expect.objectContaining({
      newTabRequest: 1, handledTabRequest: 1,
    }))
    act(() => { owner.focusBrowserTab('new-page') })
    act(() => { owner.focusPendingBrowserTab('unrelated-page') })
    act(() => { owner.syncBrowserTabs([{ id: 'new-page', name: 'New page' }], 'new-page') })
    const tab = screen.getByRole('tab', { name: 'New page' })
    expect(document.activeElement).toBe(tab)
    screen.getByRole('button', { name: zh['workbench.fullscreen.enter'] }).focus()
    ;(tab as HTMLButtonElement).disabled = true
    act(() => { owner.focusBrowserTab('new-page') })
    expect(document.activeElement).not.toBe(tab)
    ;(tab as HTMLButtonElement).disabled = false
    act(() => { owner.focusPendingBrowserTab('new-page') })
    expect(document.activeElement).toBe(tab)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.add'] }))
    const menu = screen.getByRole('button', { name: zh['workbench.menu.terminal'] })
    expect(document.activeElement).toBe(menu)
    act(() => { owner.focusBrowserTab('new-page') })
    expect(document.activeElement).toBe(menu)
  })

  it('tolerates a browser focus reply arriving after the workbench is unmounted', () => {
    const b = bench()
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    const owner = (b.renderSlot as unknown as { mock: { lastCall?: [string, {
      focusBrowserTab: (tabId: string) => void
    }] } }).mock.lastCall?.[1]
    if (!owner) throw new Error('browser slot owner was not registered')
    mounted.unmount()
    expect(() => { owner.focusBrowserTab('late-page') }).not.toThrow()
  })

  it('keeps one browser content instance while reassigning the active page panel relationship', () => {
    const b = bench()
    b.instance.actions.syncBrowserTabs([{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }], 'first')
    b.instance.actions.setView('browser')
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    const browser = screen.getByTestId('browser-contribution')
    const firstPanel = browser.closest('[role="tabpanel"]') as HTMLElement
    const firstPanelId = firstPanel.id
    expect(firstPanel.getAttribute('aria-labelledby')).not.toBeNull()
    act(() => { b.instance.actions.activateTab('browser:second') })
    const secondPanel = browser.closest('[role="tabpanel"]') as HTMLElement
    expect(secondPanel).toBe(firstPanel)
    expect(secondPanel.id).not.toBe(firstPanelId)
    expect(mounted.container.querySelectorAll('[role="tabpanel"][id]')).toHaveLength(2)
    expect((mounted.container.querySelector(`[id="${firstPanelId}"]`) as HTMLElement).hidden).toBe(true)
    expect(screen.getByTestId('browser-contribution')).toBe(browser)
  })

  it('only reveals a browser page when its interaction is still current', () => {
    const b = bench()
    b.instance.actions.syncBrowserTabs([{ id: 'page', name: 'Page' }], 'page')
    render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    const owner = (b.renderSlot as unknown as { mock: { lastCall?: [string, {
      interactionEpoch: number
      requestAutoReveal: (epoch: number) => boolean
      autoRevealBrowser: (tabId: string, epoch: number) => void
    }] } }).mock.lastCall?.[1]
    if (!owner) throw new Error('browser slot owner was not registered')
    expect(owner.requestAutoReveal(owner.interactionEpoch + 1)).toBe(false)
    expect(b.openWorkbench).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    const current = (b.renderSlot as unknown as { mock: { lastCall?: [string, typeof owner] } }).mock.lastCall?.[1]
    if (!current) throw new Error('browser slot owner was not registered')
    expect(current.requestAutoReveal(owner.interactionEpoch)).toBe(false)
    expect(current.requestAutoReveal(current.interactionEpoch)).toBe(true)
    act(() => { current.autoRevealBrowser('page', current.interactionEpoch) })
    expect(b.instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:page', browserAutoRevealed: true })
    expect(b.openWorkbench).toHaveBeenCalledTimes(2)
    act(() => { b.instance.actions.recordInteraction() })
    const afterInteraction = (b.renderSlot as unknown as { mock: { lastCall?: [string, typeof owner] } }).mock.lastCall?.[1]
    if (!afterInteraction) throw new Error('browser slot owner was not registered')
    expect(afterInteraction.requestAutoReveal(current.interactionEpoch)).toBe(false)
    expect(b.openWorkbench).toHaveBeenCalledTimes(2)
  })

  it('navigates workbench tabs by arrow, Home and End without changing the feature menu on other keys', () => {
    const b = bench()
    render(<WorkspaceWorkbench {...b.props} />)
    const tabs = screen.getByRole('tablist', { name: zh['tabs.label'] })
    fireEvent.keyDown(tabs, { key: 'ArrowLeft' })
    expect(b.instance.getSnapshot().view).toBe('menu')
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    act(() => { b.instance.actions.openFile({ name: 'note.txt', segments: ['note.txt'] }) })
    const manager = screen.getByRole('tab', { name: zh['files.tab'] })
    const preview = screen.getByRole('tab', { name: 'note.txt' })
    fireEvent.keyDown(preview, { key: 'ArrowLeft' })
    expect(manager.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(manager)
    fireEvent.keyDown(manager, { key: 'ArrowRight' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(preview, { key: 'Home' })
    expect(manager.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(manager, { key: 'End' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(preview, { key: 'Escape' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('button', { name: zh['tabs.add'] }), { key: 'ArrowLeft' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
  })

  it('并排模式不显示遗留文件侧栏开关，也不重复终端底栏开关', () => {
    const b = bench({ fullscreen: false, bottomOpen: true, initialView: 'files' })
    render(<WorkspaceWorkbench {...b.props} />)
    const topbar = screen.getByRole('region', { name: zh['workbench.label'] })
      .querySelector('header') as HTMLElement
    expect(within(topbar).queryByRole('button', { name: /文件侧栏/ })).toBeNull()
    expect(within(topbar).queryByRole('button', { name: zh['workbench.bottom.hide'] })).toBeNull()
    expect(screen.getByRole('complementary', { name: zh['files.label'] }).parentElement?.hidden).toBe(false)
    expect(b.toggleBottom).not.toHaveBeenCalled()
  })

  it('starts on a keyboard-operable function menu and only enters wired features', async () => {
    const b = bench()
    render(<WorkspaceWorkbench {...b.props} />)
    const menu = screen.getByRole('navigation', { name: zh['workbench.menu.label'] })
    const topbar = screen.getByRole('region', { name: zh['workbench.label'] })
      .querySelector('header') as HTMLElement
    expect(within(topbar).getAllByRole('button')).toHaveLength(3)
    expect(within(topbar).queryByRole('button', { name: /文件侧栏/ })).toBeNull()
    expect(within(topbar).getByRole('button', { name: zh['tabs.add'] })).toBeDefined()
    expect(within(topbar).queryByRole('button', { name: zh['workbench.menu.back'] })).toBeNull()
    expect(b.instance.store.getSnapshot().view).toBe('menu')
    expect(b.listFiles).not.toHaveBeenCalled()
    const items = within(menu).getAllByRole('button')
    expect(items.map(item => item.textContent)).toEqual([
      '审查未接入', '终端', '浏览器', '文件', '侧边聊天未接入',
    ])
    expect(items[0]?.hasAttribute('disabled')).toBe(true)
    expect(items[4]?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(items[0] as HTMLButtonElement)
    expect(b.instance.store.getSnapshot().view).toBe('menu')
    fireEvent.click(items[1] as HTMLButtonElement)
    expect(b.toggleBottom).not.toHaveBeenCalled()
    expect(b.instance.store.getSnapshot().view).toBe('terminal')
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('right-terminal').hasAttribute('hidden')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(items[3] as HTMLButtonElement)
    expect(b.instance.store.getSnapshot().view).toBe('files')
    expect(screen.getByRole('tab', { name: zh['files.tab'] }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(b.listFiles).toHaveBeenCalledOnce() })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.back'] }))
    fireEvent.click(within(menu).getByRole('button', { name: zh['workbench.menu.browser'] }))
    expect(b.renderSlot).toHaveBeenLastCalledWith('workbench.browser', expect.objectContaining({ shown: true }))
  })

  it('uses one shared add action to reopen the feature menu without discarding existing tabs', () => {
    const b = bench()
    b.instance.actions.openFile({ name: 'note.txt', segments: ['note.txt'] })
    b.instance.actions.syncBrowserTabs([{ id: 'page', name: 'Page' }], 'page')
    render(<WorkspaceWorkbench {...b.props} />)
    const add = screen.getByRole('button', { name: zh['tabs.add'] })
    expect(screen.getAllByRole('button', { name: zh['tabs.add'] })).toHaveLength(1)
    fireEvent.click(add)
    expect(b.instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: '["note.txt"]' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    expect(screen.getByRole('tab', { name: 'note.txt' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    expect(b.instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['file', 'browser', 'terminal'])
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    expect(b.instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
    expect(screen.getByRole('tab', { name: zh['files.tab'] }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    expect(b.instance.getSnapshot().tabs.filter(tab => tab.type === 'file-manager')).toHaveLength(1)
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.browser'] }))
    expect(b.instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:page' })
    expect(b.instance.getSnapshot().tabs).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.close'].replace('{name}', zh['files.tab']) }))
    expect(screen.queryByRole('tab', { name: zh['files.tab'] })).toBeNull()
    expect(screen.getByRole('tab', { name: 'note.txt' })).toBeDefined()
  })

  it('preserves the file manager while hidden and focuses the adjacent preview after closing it', () => {
    const b = bench()
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    const manager = screen.getByRole('tab', { name: zh['files.tab'] })
    expect(manager.getAttribute('aria-selected')).toBe('true')
    act(() => { b.instance.actions.openFile({ name: 'note.txt', segments: ['note.txt'] }) })
    fireEvent.click(manager)
    expect(manager.getAttribute('aria-selected')).toBe('true')
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} />)
    mounted.rerender(<WorkspaceWorkbench {...b.props} />)
    expect(screen.getByRole('tab', { name: zh['files.tab'] })).toBe(manager)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.close'].replace('{name}', zh['files.tab']) }))
    const preview = screen.getByRole('tab', { name: 'note.txt' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(preview)
  })

  it('窄屏预览独占内容，返回文件管理器仍保留目录筛选与展开', async () => {
    let resize: ResizeObserverCallback | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe(): void {}
      disconnect(): void {}
    })
    const b = bench({ listFiles: async segments => segments.length === 0
      ? listing('/workspace', [
        { name: 'src', type: 'directory', segments: ['src'] },
        { name: 'note.txt', type: 'file', segments: ['note.txt'] },
      ])
      : listing('/workspace/src', [
        { name: 'nested.txt', type: 'file', segments: ['src', 'nested.txt'] },
      ]) })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
    act(() => { resize?.([], {} as ResizeObserver) })
    act(() => {
      resize?.([{ contentRect: { width: 0 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(screen.getByRole('region', { name: zh['workbench.label'] }).hasAttribute('data-narrow')).toBe(false)
    act(() => {
      resize?.([{ contentRect: { width: 440 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    const region = screen.getByRole('region', { name: zh['workbench.label'] })
    expect(region.getAttribute('data-narrow')).toBe('true')
    const tree = screen.getByRole('complementary', { name: zh['files.label'] }).parentElement as HTMLElement
    expect(tree.hidden).toBe(false)
    const manager = screen.getByRole('tab', { name: zh['files.tab'] })
    expect(manager.getAttribute('aria-selected')).toBe('true')
    const managerId = manager.getAttribute('aria-controls')
    expect(managerId).not.toBeNull()
    const managerPanels = () => mounted.container.querySelectorAll(`[id="${managerId}"][role="tabpanel"]`)
    expect(managerPanels()).toHaveLength(1)
    expect(managerPanels()[0]?.hasAttribute('hidden')).toBe(false)
    expect(managerPanels()[0]?.querySelector('[role="tree"]')).not.toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await screen.findByRole('button', { name: 'nested.txt' })
    const filter = screen.getByRole('searchbox', { name: zh['files.filter'] })
    fireEvent.change(filter, { target: { value: 'note' } })
    fireEvent.click(await screen.findByRole('button', { name: 'note.txt' }))
    expect(screen.getByRole('tab', { name: 'note.txt' }).getAttribute('aria-selected')).toBe('true')
    expect(tree.hidden).toBe(true)
    expect(managerPanels()).toHaveLength(1)
    expect(managerPanels()[0]?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByRole('button', { name: /文件侧栏/ })).toBeNull()
    expect(b.instance.getSnapshot().filesExpanded).toContain(JSON.stringify(['src']))
    fireEvent.click(manager)
    expect(tree.hidden).toBe(false)
    expect(managerPanels()).toHaveLength(1)
    expect(managerPanels()[0]?.hasAttribute('hidden')).toBe(false)
    expect(filter).toHaveProperty('value', 'note')
    fireEvent.change(filter, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'nested.txt' })).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'note.txt' }))
    expect(tree.hidden).toBe(true)
    act(() => {
      resize?.([{ contentRect: { width: 800 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(region.hasAttribute('data-narrow')).toBe(false)
    expect(tree.hidden).toBe(false)
    expect(managerPanels()).toHaveLength(1)
    expect(managerPanels()[0]?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByRole('button', { name: /文件侧栏/ })).toBeNull()
  })

  it('工作台隐藏后保留目录与筛选状态，恢复时不重复读取', async () => {
    const b = bench({ initialView: 'files' })
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    await screen.findByText(zh['files.empty'])
    expect(mounted.container.querySelector('aside')?.hidden).toBe(false)
    act(() => { b.instance.actions.setFilesQuery('kept') })
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} />)
    expect(mounted.container.querySelector('section')?.hidden).toBe(true)
    expect(b.instance.getSnapshot()).toMatchObject({ filesQuery: 'kept' })
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown />)
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
    const b = bench({ listFiles, readFile, initialView: 'files' })
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
    expect(screen.getByRole('navigation', { name: zh['workbench.menu.label'] })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.files'] }))
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
    const b = bench({ initialView: 'files',
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
    const b = bench({ listFiles, readFile, initialView: 'files' })
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
    const b = bench({ initialView: 'files',
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
    const b = bench({ initialView: 'files',
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
