// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyWorkbench, inject as workbenchInject } from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import type { BrowserHumanCommand } from '@deepseek-ai/dsh-browser/types'
import { apply, inject } from '../src/client/index.ts'
import { id, otherId, state } from './browser-fixtures.ts'

const addedId = '032ef1b7-466b-45a7-8d57-3288cf12b8b1'
const secondAddedId = '641c045c-421f-4a10-b00b-987bf39c37bf'

vi.mock('../../ui-open-in-app/node_modules/@xterm/xterm', () => ({ Terminal: class {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  textarea: HTMLTextAreaElement | undefined
  loadAddon(): void {}
  open(node: HTMLElement): void {
    this.textarea = document.createElement('textarea')
    node.append(this.textarea)
  }
  onData() { return { dispose: vi.fn() } }
  focus(): void {}
  dispose(): void {}
} }))
vi.mock('../../ui-open-in-app/node_modules/@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

let runtime: SlotTestRuntime | undefined

beforeEach(() => {
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL(): string { return 'blob:browser-workbench-frame' }
    static override revokeObjectURL(): void {}
  })
  vi.stubGlobal('WebSocket', class extends EventTarget {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    readyState = 0
    close(): void { this.readyState = 3 }
  })
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  vi.unstubAllGlobals()
})

/** 挂实际两插件，以 Host JSON、人工 RPC 与截图作为外部边界。 */
async function bench(initiallyEmpty = false, pauseNewTab?: () => Promise<void>) {
  runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.provide('layout', {
    openWorkbench: vi.fn(), closeWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(), toggleWorkbenchFiles: vi.fn(), toggleWorkbenchBottom: vi.fn(),
    workbench: () => createSnapshotStore({ open: true, fullscreen: false, bottomOpen: false, filesOpen: true }),
  })
  let hostState: ReturnType<typeof state> | null = initiallyEmpty
    ? null : { ...state(), observation: null, hasFrame: false }
  let addedCount = 0
  const control = vi.fn(async ({ command }: { command: BrowserHumanCommand }) => {
    if (command.kind === 'select-tab') {
      if (hostState === null) throw new Error('Cannot select a page without a browser')
      hostState = { ...hostState, activeTabId: command.tabId, stateRevision: hostState.stateRevision + 1 }
    } else if (command.kind === 'new-tab') {
      await pauseNewTab?.()
      const current = hostState ?? { ...state(), tabs: [], observation: null, hasFrame: false }
      const nextId = addedCount++ === 0 ? addedId : secondAddedId
      hostState = { ...current, activeTabId: nextId, stateRevision: current.stateRevision + 1,
        tabs: [...current.tabs, { id: nextId, generation: 'human-added', url: 'about:blank', title: 'Added',
          canGoBack: false, canGoForward: false }] }
    } else if (command.kind === 'close-tab') {
      if (hostState === null) throw new Error('Cannot close a page without a browser')
      const tabs = hostState.tabs.filter(tab => tab.id !== command.tabId)
      hostState = { ...hostState, tabs, activeTabId: tabs.at(-1)!.id, stateRevision: hostState.stateRevision + 1 }
    }
    return { result: { ok: true, value: hostState } }
  })
  runtime.provide('connection', { api: { browser: { control } } })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('/browser-use/frame')
    ? new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    : hostState === null ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(hostState), { status: 200 })))
  await runtime.sessions.add({ id: 'browser-workbench-session' })
  await runtime.declare({ workbench: { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...workbenchInject], apply: applyWorkbench })
  const browserProvider = await runtime.mount({ inject: [...inject], apply })
  const workbench = runtime.renderSlot('workbench', {
    shown: true, fullscreen: false, bottomOpen: false, filesOpen: true,
  })
  if (!initiallyEmpty) await waitFor(() => {
    expect(workbench.view.getByRole('tab', { name: 'Example' })).toBeTruthy()
    expect(workbench.view.getByRole('tab', { name: '新标签页' })).toBeTruthy()
  })
  else await waitFor(() => { expect(workbench.view.getByRole('navigation', { name: '工作台功能' })).toBeTruthy() })
  return { workbench, control, hostState: () => hostState!,
    publish: (next: ReturnType<typeof state>) => { hostState = next },
    remountBrowser: async () => {
      await browserProvider.dispose()
      await runtime!.mount({ inject: [...inject], apply })
    } }
}

describe('typed workbench with the browser provider', () => {
  it('selects the adjacent Host page after closing a terminal and sends only one command for a page click', async () => {
    const { workbench, control, hostState } = await bench()
    expect(control).not.toHaveBeenCalled()
    fireEvent.click(workbench.view.getByRole('button', { name: '终端' }))
    expect(workbench.view.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(workbench.view.getByRole('button', { name: '关闭 coding 1' }))
    await waitFor(() => {
      expect(hostState().activeTabId).toBe(otherId)
      expect(workbench.view.getByRole('tab', { name: '新标签页' }).getAttribute('aria-selected')).toBe('true')
    })
    expect(control).toHaveBeenCalledTimes(1)
    expect(control).toHaveBeenLastCalledWith(expect.objectContaining({
      command: { kind: 'select-tab', tabId: otherId },
    }), expect.any(AbortSignal))
    expect(workbench.view.getAllByRole('tablist')).toHaveLength(1)

    fireEvent.click(workbench.view.getByRole('tab', { name: 'Example' }))
    await waitFor(() => {
      expect(hostState().activeTabId).toBe(id)
      expect(workbench.view.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true')
    })
    expect(control).toHaveBeenCalledTimes(2)
    expect(control).toHaveBeenLastCalledWith(expect.objectContaining({
      command: { kind: 'select-tab', tabId: id },
    }), expect.any(AbortSignal))

    fireEvent.click(workbench.view.getByRole('button', { name: '添加工作台标签' }))
    expect(workbench.view.getByRole('navigation', { name: '工作台功能' })).toBeTruthy()
    expect(document.activeElement).toBe(workbench.view.getByRole('button', { name: '终端' }))
    expect(workbench.view.queryByRole('button', { name: '新建标签页' })).toBeNull()
    expect(control).toHaveBeenCalledTimes(2)
    fireEvent.click(workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => {
      expect(workbench.view.getByRole('tab', { name: 'Added' }).getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(workbench.view.getByRole('tab', { name: 'Added' }))
    })
    expect(control).toHaveBeenCalledTimes(3)
    expect(control).toHaveBeenLastCalledWith(expect.objectContaining({ command: { kind: 'new-tab' } }),
      expect.any(AbortSignal))
    expect(workbench.view.getByRole('tab', { name: 'Example' })).toBeTruthy()
    fireEvent.click(workbench.view.getByRole('button', { name: '添加工作台标签' }))
    fireEvent.click(workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => {
      expect(hostState().tabs).toHaveLength(4)
      expect(hostState().activeTabId).toBe(secondAddedId)
      expect(document.activeElement).toBe(workbench.view.getAllByRole('tab', { name: 'Added' })[1])
    })
    expect(control).toHaveBeenCalledTimes(4)
  })

  it('creates exactly one blank page from an empty browser when the feature menu is selected', async () => {
    const { workbench, control, hostState } = await bench(true)
    fireEvent.click(workbench.view.getByRole('button', { name: '添加工作台标签' }))
    expect(control).not.toHaveBeenCalled()
    fireEvent.click(workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => {
      expect(hostState().tabs).toHaveLength(1)
      expect(workbench.view.getByRole('tab', { name: 'Added' }).getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(workbench.view.getByRole('tab', { name: 'Added' }))
    })
    expect(control).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: { kind: 'new-tab' } }),
      expect.any(AbortSignal))
  })

  it('does not steal focus when the user switches to files before a new page resolves', async () => {
    let resolveNewTab!: () => void
    const pause = new Promise<void>((resolve) => { resolveNewTab = resolve })
    const b = await bench(false, () => pause)
    fireEvent.click(b.workbench.view.getByRole('button', { name: '添加工作台标签' }))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => { expect(b.control).toHaveBeenCalledWith(expect.objectContaining({
      command: { kind: 'new-tab' },
    }), expect.any(AbortSignal)) })
    fireEvent.click(b.workbench.view.getByRole('button', { name: '添加工作台标签' }))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '文件' }))
    const files = b.workbench.view.getByRole('tab', { name: '文件管理器' })
    const focus = document.activeElement
    expect(focus).toBe(b.workbench.view.getByRole('button', { name: '返回功能菜单' }))
    resolveNewTab()
    await waitFor(() => { expect(b.workbench.view.getByRole('tab', { name: 'Added' })).toBeTruthy() })
    expect(files.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(focus)
  })

  it('does not replay completed menu requests when the browser slot unloads and remounts', async () => {
    const b = await bench()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '添加工作台标签' }))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => { expect(b.hostState().tabs).toHaveLength(3) })
    await b.remountBrowser()
    await waitFor(() => { expect(b.workbench.view.getByRole('tab', { name: 'Added' })).toBeTruthy() })
    expect(b.control).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      command: { kind: 'new-tab' },
    }), expect.any(AbortSignal))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '添加工作台标签' }))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '浏览器' }))
    await waitFor(() => { expect(b.hostState().tabs).toHaveLength(4) })
    expect(b.control).toHaveBeenCalledTimes(2)
  })

  it('opens a newly observed model page from a terminal without selecting the remembered old page', async () => {
    const b = await bench()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '终端' }))
    const observed = state(2)
    const next = { ...observed, activeTabId: addedId,
      tabs: [...observed.tabs, { id: addedId, generation: 'model-added', url: 'https://model.example/', title: 'Model page',
        canGoBack: false, canGoForward: false }],
      observation: { ...observed.observation!, tabId: addedId, generation: 'model-added',
        url: 'https://model.example/', title: 'Model page' } }
    b.publish(next)
    await waitFor(() => {
      expect(b.workbench.view.getByRole('tab', { name: 'Model page' }).getAttribute('aria-selected')).toBe('true')
    }, { timeout: 2_000 })
    expect(b.hostState().activeTabId).toBe(addedId)
    expect(b.control).not.toHaveBeenCalled()
    expect(b.workbench.view.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('false')
  })
})
