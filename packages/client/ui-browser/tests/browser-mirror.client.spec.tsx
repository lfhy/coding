// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserMirror, BrowserTabs, type BrowserMirrorProps } from '../src/client/BrowserMirror.tsx'
import type { BrowserView } from '../src/client/controller.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../src/client/locales.ts'
import { id, otherId, state } from './browser-fixtures.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const observers: MockResizeObserver[] = []
class MockResizeObserver {
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  fire(width: number, height: number) {
    this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}
function mockResizeObserver() {
  observers.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
}
const t = (key: keyof typeof en, args?: { name: string }) => en[key].replace('{name}', args?.name ?? '')
type LinkedState = Awaited<ReturnType<BrowserMirrorProps['openUrl']>>
function mount(view: BrowserView, shown = true, useSession = sessionHook([])) {
  const command = vi.fn(async () => true)
  const ensureTab = vi.fn(async () => {})
  const start = vi.fn(() => vi.fn())
  const syncBrowserTabs = vi.fn()
  let opener: ((url: string, pendingId: string, isCurrent: () => boolean, shouldReveal: () => boolean,
    click: { interactionEpoch: number; selectedTabId?: string }) => Promise<void>) | undefined
  let clickState: (() => { interactionEpoch: number; selectedTabId?: string }) | undefined
  const registerLinkOpener = vi.fn((_sessionId: string, open: typeof opener, _begin: (id: string, url: string) => void,
    _clear: () => void,
    currentClick: () => { interactionEpoch: number; selectedTabId?: string }) => {
    opener = open
    clickState = currentClick
    return () => { if (opener === open) opener = undefined }
  })
  const openUrl = vi.fn(async (): Promise<LinkedState> => state(2, otherId) as never)
  const retryLink = vi.fn(async () => {})
  const props = { sessionId: 'session-a', shown, browserShown: shown, newTabRequest: 0,
    handledTabRequest: 0, markTabRequestHandled: vi.fn(), focusBrowserTab: vi.fn(),
    focusPendingBrowserTab: vi.fn(),
    interactionEpoch: 0, browserAutoRevealed: false,
    requestAutoReveal: vi.fn(() => true), autoRevealBrowser: vi.fn(),
    useSession,
    openBrowser: vi.fn(), syncBrowserTabs, start, command, ensureTab, openUrl, registerLinkOpener,
    beginBrowserLink: vi.fn(), completeBrowserLink: vi.fn(), failBrowserLink: vi.fn(), clearBrowserLinks: vi.fn(),
    selectPendingBrowserLink: vi.fn(), closePendingBrowserLink: vi.fn(), retryLink,
    retry: vi.fn(), useBrowserMirror: <S,>(selector: (snapshot: BrowserView) => S): S => selector(view),
    t } as unknown as BrowserMirrorProps
  const result = render(<BrowserMirror {...props} />)
  return { ...result, props, command, ensureTab, start, syncBrowserTabs, openUrl, retryLink,
    openLink: (url: string, shouldReveal = () => true, click = clickState!()) =>
      opener!(url, 'browser-link:unit', () => opener !== undefined, shouldReveal, click) }
}
const ready = (revision = 1): BrowserView => ({
  phase: 'ready', state: state(revision) as never, frameUrl: 'blob:frame', pending: false,
})
const empty: BrowserView = { phase: 'empty', state: null, frameUrl: null, pending: false }
const loading: BrowserView = { phase: 'loading', state: null, frameUrl: null, pending: false }
const stoppedNavigation = 'browser navigation timed out; loading stopped, take a new snapshot of the current page'
function viewHook(view: BrowserView): BrowserMirrorProps['useBrowserMirror'] {
  return selector => selector(view)
}
function sessionHook(nodes: readonly ToolCallBlock[], openState = 'open'): BrowserMirrorProps['useSession'] {
  return selector => selector({ nodes, runningCalls: [], openState } as never)
}
function result(seq: number, name: string, tabId: string, options: {
  isError?: boolean
  action?: string
  content?: string
  subCalls?: readonly ToolCallBlock[]
} = {}): ToolCallBlock {
  return { kind: 'tool-result', seq, callId: `call-${String(seq)}`, time: seq,
    call: { name, argsRaw: '{}' }, callTime: 0, callView: null, resultView: null,
    isError: options.isError ?? false,
    content: [{ type: 'text', text: options.content ?? JSON.stringify({ action: options.action ?? 'navigate',
      observation: { tabId } }) }], subCalls: options.subCalls ?? [],
  }
}
function browserTabsRow(props: BrowserMirrorProps, view: BrowserView) {
  return <div role="tablist" aria-label="Workbench tabs">
    {view.state?.tabs.map(tab => <BrowserTabs key={tab.id} {...props} tabId={tab.id}
      useBrowserMirror={viewHook(view)} />)}
  </div>
}
function browserWorkbench(props: BrowserMirrorProps, view: BrowserView, selected: string) {
  return <>
    <div role="tablist" aria-label="Workbench tabs">
      {view.state?.tabs.map(tab => <BrowserTabs key={tab.id} {...props} tabId={tab.id}
        shown browserShown={tab.id === selected} useBrowserMirror={viewHook(view)} />)}
    </div>
    <div role="tabpanel" aria-label="Selected browser panel">
      <BrowserMirror {...props} shown selectedTabId={selected} useBrowserMirror={viewHook(view)} />
    </div>
  </>
}
function navigated(url: string, revision: number): BrowserView {
  const value = state(revision, otherId)
  return { phase: 'ready', state: {
    ...value, tabs: value.tabs.map(tab => tab.id === otherId ? { ...tab, url } : tab),
  } as never, frameUrl: null, pending: false }
}

describe('browser UI', () => {
  it('shows the destination and loading status in the address bar before the first Host result', () => {
    const browser = mount(ready())
    const pendingBrowserLink = { id: 'browser-link:1', url: 'https://slow.example/' }
    browser.rerender(<>
      <div role="tablist"><BrowserTabs {...browser.props} pendingBrowserLink={pendingBrowserLink}
        tabDomId="link-tab" panelDomId="link-panel" browserShown /></div>
      <BrowserMirror {...browser.props} pendingBrowserLink={pendingBrowserLink} />
    </>)
    expect(screen.getByRole('tab', { selected: true }).getAttribute('data-browser-pending-id')).toBe('browser-link:1')
    const address = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement
    expect(address.value).toBe('https://slow.example/')
    expect(address.title).toBe('https://slow.example/')
    expect(screen.getByTestId('browser-canvas').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').closest('form')).toBe(address.closest('form'))
    expect(screen.getByRole('status').closest('[aria-busy="true"]')).toBeNull()
    expect(screen.getByTestId('browser-link-loading').closest('form')).toBe(address.closest('form'))
    expect(screen.getByTestId('browser-canvas').textContent).not.toContain('https://slow.example/')
    expect(screen.queryByAltText('Browser page screenshot')).toBeNull()
    expect(browser.ensureTab).not.toHaveBeenCalled()
    expect(browser.command).not.toHaveBeenCalled()

    browser.rerender(<BrowserMirror {...browser.props} pendingBrowserLink={{ ...pendingBrowserLink,
      error: 'HTTP 503' }} />)
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
    expect(screen.getByRole('alert').textContent).not.toContain('https://slow.example/')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Address' }).value).toBe('https://slow.example/')
    expect(screen.getByTestId('browser-canvas').getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByTestId('browser-link-loading')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(browser.props.retryLink).toHaveBeenCalledExactlyOnceWith('https://slow.example/', 'browser-link:1')
    browser.retryLink.mockRejectedValueOnce(new Error('Too many pending links'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    return waitFor(() => { expect(browser.props.failBrowserLink)
      .toHaveBeenCalledExactlyOnceWith('browser-link:1', 'Too many pending links') })
  })

  it('replaces the pending Assistant tab after syncing the exact Host tabs', async () => {
    const browser = mount(ready(), false)
    const order: string[] = []
    browser.syncBrowserTabs.mockImplementation(() => { order.push('sync') })
    browser.props.completeBrowserLink = vi.fn(() => { order.push('complete') })
    browser.rerender(<BrowserMirror {...browser.props} />)
    await act(async () => { await browser.openLink('https://linked.example/') })
    expect(browser.openUrl).toHaveBeenCalledExactlyOnceWith('https://linked.example/')
    expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith([
      { id, name: 'Example' }, { id: otherId, name: 'New tab' },
    ], otherId)
    expect(browser.props.completeBrowserLink).toHaveBeenCalledExactlyOnceWith('browser-link:unit', otherId)
    expect(order).toEqual(['sync', 'complete'])
    expect(browser.command).not.toHaveBeenCalled()
    expect(browser.props.markTabRequestHandled).not.toHaveBeenCalled()
  })

  it('syncs superseded pages without revealing them, then selects the last accepted link', async () => {
    const browser = mount(ready())
    browser.rerender(<BrowserMirror {...browser.props} selectedTabId={id} />)
    const lastId = '032ef1b7-466b-45a7-8d57-3288cf12b8b1'
    const last = { ...state(3), activeTabId: lastId, observation: null, hasFrame: false,
      tabs: [...state().tabs, { id: lastId, generation: 'linked', url: 'https://second.example/',
        title: 'Second', canGoBack: false, canGoForward: false }] }
    browser.openUrl.mockResolvedValueOnce(state(2, otherId) as never).mockResolvedValueOnce(last as never)
    await act(async () => { await browser.openLink('https://first.example/', () => false) })
    expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), id)
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
    expect(browser.command).not.toHaveBeenCalled()
    await act(async () => { await browser.openLink('https://second.example/') })
    expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), lastId)
    expect(browser.props.completeBrowserLink).toHaveBeenLastCalledWith('browser-link:unit', lastId)
  })

  it('keeps the prior selected tab while a superseded Host state arrives before its frame settles', async () => {
    let finish!: (value: LinkedState) => void
    let newest = true
    const browser = mount(ready())
    browser.rerender(<BrowserMirror {...browser.props} selectedTabId={id} />)
    browser.syncBrowserTabs.mockClear()
    browser.openUrl.mockImplementation(() => new Promise<LinkedState>((resolve) => { finish = resolve }))
    const opening = browser.openLink('https://first.example/', () => newest)
    newest = false
    browser.rerender(<BrowserMirror {...browser.props} selectedTabId={id}
      useBrowserMirror={viewHook({ phase: 'ready', state: state(2, otherId) as never,
        frameUrl: null, pending: true })} />)
    expect(browser.syncBrowserTabs).not.toHaveBeenCalled()
    await act(async () => { finish(state(2, otherId) as never); await opening })
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
    expect(browser.command).not.toHaveBeenCalled()
  })

  it('keeps the selected tab and panel aligned while a queued link supersedes the Host page', async () => {
    const browser = mount(ready())
    let finish!: (value: LinkedState) => void
    let newest = true
    const firstState = { ...state(2, otherId), hasFrame: true,
      tabs: state().tabs.map(tab => tab.id === otherId
        ? { ...tab, url: 'https://first.example/', title: 'First' } : tab),
      observation: { ...state().observation!, tabId: otherId, generation: 'tab-g2',
        url: 'https://first.example/', title: 'First' } }
    const lastId = '032ef1b7-466b-45a7-8d57-3288cf12b8b1'
    const lastState = { ...state(3), activeTabId: lastId, observation: null, hasFrame: false,
      tabs: [...firstState.tabs, { id: lastId, generation: 'tab-g3', url: 'https://last.example/',
        title: 'Last', canGoBack: false, canGoForward: false }] }
    const firstView: BrowserView = { phase: 'ready', state: firstState as never,
      frameUrl: 'blob:first', pending: true }
    const lastView: BrowserView = { phase: 'ready', state: lastState as never,
      frameUrl: null, pending: false }
    browser.rerender(browserWorkbench(browser.props, ready(), id))
    browser.openUrl.mockImplementationOnce(() => new Promise<LinkedState>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(lastState as never)
    const opening = browser.openLink('https://first.example/', () => newest)
    newest = false
    browser.rerender(browserWorkbench(browser.props, firstView, id))
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Selected browser panel' })
      .querySelector('[role="status"]')?.textContent).toBe('Loading browser state…')
    expect(screen.getByRole('status').closest('form')).not.toBeNull()
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()
    expect(screen.queryByAltText('Browser page screenshot')).toBeNull()
    expect(browser.command).not.toHaveBeenCalled()
    await act(async () => { finish(firstState as never); await opening })
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
    await act(async () => { await browser.openLink('https://last.example/') })
    browser.rerender(browserWorkbench(browser.props, lastView, lastId))
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Last' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Selected browser panel' })
      .querySelector('[role="status"]')).toBeNull()
    expect(browser.props.completeBrowserLink).toHaveBeenLastCalledWith('browser-link:unit', lastId)
    expect(browser.command).not.toHaveBeenCalled()
  })

  it('conceals a stale desktop guest until the manually selected tab becomes Host active', () => {
    const present = vi.fn(async () => {})
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 80, right: 900, bottom: 680,
    } as DOMRect)
    const browser = mount(ready())
    browser.rerender(browserWorkbench(browser.props, ready(), id))
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: id, visible: true }))
    const hostFirst: BrowserView = { phase: 'ready', state: state(2, otherId) as never,
      frameUrl: null, pending: true }
    browser.rerender(browserWorkbench(browser.props, hostFirst, id))
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading browser state…')
    expect(screen.queryByLabelText('Browser page')).toBeNull()
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: id, visible: false }))
    browser.rerender(browserWorkbench(browser.props, { ...ready(3), state: state(3) as never }, id))
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: id, visible: true }))
    expect(browser.command).not.toHaveBeenCalled()
    browser.unmount()
    bounds.mockRestore()
  })

  it('respects a manual workbench change made after a queued click but before its Host turn', async () => {
    const browser = mount(ready(), true)
    const originalClick = { interactionEpoch: 0 }
    browser.rerender(<BrowserMirror {...browser.props} shown={false} interactionEpoch={1} />)
    await act(async () => { await browser.openLink('https://queued.example/', () => true, originalClick) })
    expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), otherId)
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
  })

  it('does not reveal a stale session or switch the old selected page during the link command', async () => {
    let finish!: (value: LinkedState) => void
    const browser = mount(ready())
    browser.openUrl.mockImplementation(() => new Promise<LinkedState>((resolve) => { finish = resolve }))
    const opening = browser.openLink('https://linked.example/')
    browser.rerender(<BrowserMirror {...browser.props} selectedTabId={otherId} />)
    expect(browser.command).not.toHaveBeenCalled()
    browser.unmount()
    finish(state(2, otherId) as never)
    await expect(opening).rejects.toThrow('会话已切换')
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
  })

  it.each([
    { choice: '关闭或转到文件/终端', shown: false, selectedTabId: undefined },
    { choice: '切换浏览器页面', shown: true, selectedTabId: id },
  ])('keeps a newer workbench choice ($choice) after a delayed link result', async ({ shown, selectedTabId }) => {
    let finish!: (value: LinkedState) => void
    const browser = mount(ready(), true)
    browser.openUrl.mockImplementation(() => new Promise<LinkedState>((resolve) => { finish = resolve }))
    const opening = browser.openLink('https://linked.example/')
    browser.rerender(<BrowserMirror {...browser.props} shown={shown}
      {...selectedTabId === undefined ? {} : { selectedTabId }}
      interactionEpoch={1} />)
    await act(async () => {
      finish(state(2, otherId) as never)
      await opening
    })
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
    if (selectedTabId !== undefined) {
      expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), selectedTabId)
      const hostState = state(2, otherId) as never
      browser.rerender(<BrowserMirror {...browser.props} shown selectedTabId={selectedTabId}
        interactionEpoch={1} useBrowserMirror={viewHook({ phase: 'error', state: hostState,
          frameUrl: null, pending: false, message: '画面 HTTP 503' })} />)
      expect(browser.command).not.toHaveBeenCalled()
      browser.rerender(<BrowserMirror {...browser.props} shown selectedTabId={selectedTabId}
        interactionEpoch={1} useBrowserMirror={viewHook({ phase: 'ready', state: hostState,
          frameUrl: null, pending: false })} />)
      expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), selectedTabId)
      expect(browser.command).toHaveBeenCalledExactlyOnceWith({ kind: 'select-tab', tabId: selectedTabId })
    } else {
      expect(browser.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), otherId)
      expect(browser.command).not.toHaveBeenCalled()
    }
  })

  it('does not reveal a tab after a Host error and permits a later attempt', async () => {
    const browser = mount(ready(), false)
    browser.openUrl.mockRejectedValueOnce(new Error('远程工作区不支持人工浏览器'))
    await expect(browser.openLink('https://linked.example/')).rejects.toThrow('远程工作区')
    expect(browser.props.openBrowser).not.toHaveBeenCalled()
    await act(async () => { await browser.openLink('https://linked.example/') })
    expect(browser.props.completeBrowserLink).toHaveBeenLastCalledWith('browser-link:unit', otherId)
  })

  it('positions the native guest on resize and scroll without screenshot or viewport commands', () => {
    mockResizeObserver()
    const present = vi.fn(async () => {})
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    const result = mount(ready())
    const area = screen.getByLabelText('Browser page')
    expect(screen.queryByAltText('Browser page screenshot')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Type' })).toBeNull()
    const bounds = vi.spyOn(screen.getByTestId('browser-canvas'), 'getBoundingClientRect').mockReturnValue({
      left: 12.2, top: 84.5, right: 1012.3, bottom: 684.5,
    } as DOMRect)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(present).toHaveBeenLastCalledWith({ sessionId: 'session-a', tabId: id,
      bounds: { x: 12, y: 84, width: 1001, height: 601 }, visible: true })
    act(() => { observers[0]!.fire(1000, 600); window.dispatchEvent(new Event('scroll')) })
    expect(result.command).not.toHaveBeenCalled()
    bounds.mockReturnValue({ left: 12, top: 84, right: 150, bottom: 200 } as DOMRect)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    bounds.mockReturnValue({ left: 13, top: 85, right: 1013, bottom: 685 } as DOMRect)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true,
      bounds: { x: 13, y: 85, width: 1000, height: 600 } }))
    expect(area.isConnected).toBe(true)
    result.unmount()
    expect(present).toHaveBeenLastCalledWith({ sessionId: 'session-a', tabId: id,
      bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false })
  })

  it('hides the old native guest on tab switch, concealment, and session remount despite late IPC replies', async () => {
    let resolveFirst!: () => void
    const present = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(undefined)
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 80, right: 900, bottom: 680,
    } as DOMRect)
    const result = mount(ready())
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', tabId: id, visible: true }))
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook({
      ...ready(2), state: state(2, otherId) as never,
    })} />)
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ tabId: id, visible: false }))
    result.rerender(<BrowserMirror {...result.props} shown={false} useBrowserMirror={viewHook({
      ...ready(2), state: state(2, otherId) as never,
    })} />)
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ tabId: otherId, visible: false }))
    result.unmount()
    const next = mount(ready(), true)
    next.rerender(<BrowserMirror {...next.props} sessionId={'session-b' as never} />)
    resolveFirst()
    await act(async () => { await Promise.resolve() })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-b', tabId: id, visible: true }))
    next.unmount()
    bounds.mockRestore()
  })

  it('keeps native URL errors and pending status above the guest bounds while preserving Web placement', () => {
    const present = vi.fn(async () => {})
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      left: 10, top: document.querySelector('[data-native-notice="true"]') ? 120 : 80,
      right: 900, bottom: 680,
    } as DOMRect))
    const result = mount(ready())
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 10, y: 80,
      width: 890, height: 600 }, visible: true }))
    const address = screen.getByRole('textbox', { name: 'Address' })
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(address.closest('form')!)
    const error = screen.getByRole('alert')
    expect(error.id).toBe('browser-address-error')
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 10, y: 120,
      width: 890, height: 560 }, visible: true }))
    expect(error.parentElement!.compareDocumentPosition(screen.getByTestId('browser-canvas'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook({ ...ready(), pending: true })} />)
    const pending = screen.getByRole('status', { name: '' })
    expect(pending.textContent).toBe('Opening page…')
    expect(pending.closest('form')).toBe(address.closest('form'))
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()
    result.unmount()
    bounds.mockRestore()
    vi.unstubAllGlobals()
    const web = mount(ready())
    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Address' }).closest('form')!)
    expect(screen.getByRole('alert').parentElement).toBe(screen.getByTestId('browser-canvas'))
    web.unmount()
  })

  it('hides the native guest for a document modal and restores it when the modal closes', async () => {
    const present = vi.fn(async () => {})
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 80, right: 900, bottom: 680,
    } as DOMRect)
    const result = mount(ready())
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    await act(async () => { document.body.append(dialog); await Promise.resolve() })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    await act(async () => { dialog.remove(); await Promise.resolve() })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    result.unmount()
    bounds.mockRestore()
  })

  it('keeps the image mirror in Web without the native preload', () => {
    const result = mount(ready())
    expect(screen.getByAltText('Browser page screenshot')).toBeTruthy()
    expect(screen.queryByLabelText('Browser page')).toBeNull()
    result.unmount()
  })
  it('projects page tabs while retaining them across unknown, busy and hidden states', () => {
    const result = mount(loading, false)
    expect(result.syncBrowserTabs).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(result.syncBrowserTabs).toHaveBeenLastCalledWith([
      { id, name: 'Example' }, { id: otherId, name: 'New tab' },
    ], id)
    result.syncBrowserTabs.mockClear()
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook({
      phase: 'busy', state: null, frameUrl: null, pending: false,
    })} />)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook({
      phase: 'error', state: null, frameUrl: null, pending: false, message: 'HTTP 503',
    })} />)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(loading)} />)
    expect(result.syncBrowserTabs).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(empty)} />)
    expect(result.syncBrowserTabs).toHaveBeenLastCalledWith([], null)
    expect(result.start).toHaveBeenCalledTimes(1)
  })

  it('does not reveal a page merely because the Host revision changes', () => {
    const result = mount(ready())
    result.rerender(<BrowserMirror {...result.props} shown={false} />)
    expect(result.start).toHaveBeenCalledTimes(1)
    result.rerender(<BrowserMirror {...result.props} shown={false} useBrowserMirror={viewHook({
      ...ready(2), state: state(2, otherId) as never,
    })} />)
    expect(result.props.requestAutoReveal).not.toHaveBeenCalled()
    expect(result.props.autoRevealBrowser).not.toHaveBeenCalled()
    expect(result.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), otherId)
  })

  it('reveals only a new settled navigate result once its exact Host page exists', () => {
    const browser = mount(ready(), false)
    const navigation = result(8, 'browser_navigate', otherId)
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([navigation])}
      useBrowserMirror={viewHook(ready(2))} />)
    expect(browser.props.requestAutoReveal).not.toHaveBeenCalled()
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([navigation])}
      useBrowserMirror={viewHook({ phase: 'error', state: state(3, otherId) as never,
        frameUrl: null, pending: false, message: 'frame unavailable' })} />)
    expect(browser.props.requestAutoReveal).toHaveBeenCalledExactlyOnceWith(0)
    expect(browser.props.autoRevealBrowser).toHaveBeenCalledExactlyOnceWith(otherId, 0)
    expect(browser.command).not.toHaveBeenCalled()
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([navigation])}
      useBrowserMirror={viewHook(ready(3))} browserAutoRevealed shown selectedTabId={otherId} />)
    expect(browser.command).not.toHaveBeenCalled()
    expect(browser.props.autoRevealBrowser).toHaveBeenCalledTimes(1)
  })

  it('recognizes nested Code Mode navigation but ignores history, errors and other tools', () => {
    const historical = result(10, 'browser_navigate', id)
    const browser = mount(loading, false, sessionHook([historical], 'loading'))
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([historical])}
      useBrowserMirror={viewHook(ready())} />)
    expect(browser.props.autoRevealBrowser).not.toHaveBeenCalled()
    const ignored = [result(11, 'browser_snapshot', id), result(12, 'browser_navigate', id, { isError: true }),
      result(13, 'browser_navigate', id, { action: 'snapshot' }),
      result(14, 'browser_navigate', id, { content: 'not json' })]
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([historical, ...ignored])} />)
    expect(browser.props.autoRevealBrowser).not.toHaveBeenCalled()
    const nested = result(16, 'code', id, { subCalls: [result(15, 'browser_navigate', otherId)] })
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([historical, ...ignored, nested])}
      useBrowserMirror={viewHook({ ...ready(2), state: state(2, otherId) as never })} />)
    expect(browser.props.autoRevealBrowser).toHaveBeenCalledExactlyOnceWith(otherId, 0)
  })

  it('lets an intervening manual choice or close cancel a pending navigation reveal', () => {
    const browser = mount(ready(), false)
    const navigation = result(8, 'browser_navigate', otherId)
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([navigation])}
      useBrowserMirror={viewHook(loading)} />)
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([navigation])}
      useBrowserMirror={viewHook(ready(2))} interactionEpoch={1} />)
    expect(browser.props.autoRevealBrowser).not.toHaveBeenCalled()
  })

  it('reveals the inspectable active native page after a recoverable navigation timeout', () => {
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const browser = mount(ready(), false)
    const timeout = result(8, 'browser_navigate', otherId,
      { isError: true, content: `Error: ${stoppedNavigation}` })
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([timeout])}
      useBrowserMirror={viewHook(loading)} />)
    expect(browser.props.requestAutoReveal).not.toHaveBeenCalled()
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([timeout])}
      useBrowserMirror={viewHook({ phase: 'error', state: state(2, otherId) as never,
        frameUrl: null, pending: false, message: 'frame unavailable' })} />)
    expect(browser.props.requestAutoReveal).toHaveBeenCalledExactlyOnceWith(0)
    expect(browser.props.autoRevealBrowser).toHaveBeenCalledExactlyOnceWith(otherId, 0)
    expect(browser.ensureTab).not.toHaveBeenCalled()
    expect(browser.command).not.toHaveBeenCalled()
  })

  it('recognizes a Code Mode child timeout without its registry error prefix', () => {
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const browser = mount(ready(), false)
    const child = result(9, 'browser_navigate', id, { isError: true, content: stoppedNavigation })
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([
      result(10, 'run_code', id, { subCalls: [child] }),
    ])} />)
    expect(browser.props.autoRevealBrowser).toHaveBeenCalledExactlyOnceWith(id, 0)
    expect(browser.command).not.toHaveBeenCalled()
  })

  it('does not reveal native pages for denial, invalid URL, unsafe timeout, or unrelated errors', () => {
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const browser = mount(ready(), false)
    const failures = [
      'Error: browser_navigate: approval rejected',
      'Error: browser_navigate: url must be a plain absolute HTTP(S) URL',
      'Error: browser navigation timed out and could not be stopped safely; browser session closed',
      'Error: browser action timed out',
      `Error: ${stoppedNavigation} (extra)`,
    ]
    for (const [index, content] of failures.entries()) {
      browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([
        result(index + 8, 'browser_navigate', id, { isError: true, content }),
      ])} />)
    }
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([
      result(20, 'browser_snapshot', id, { isError: true, content: `Error: ${stoppedNavigation}` }),
    ])} />)
    expect(browser.props.autoRevealBrowser).not.toHaveBeenCalled()
  })

  it('does not reveal a timeout in Web or after the user changes their workbench choice', () => {
    const timeout = result(8, 'browser_navigate', id, { isError: true, content: `Error: ${stoppedNavigation}` })
    const web = mount(ready(), false)
    web.rerender(<BrowserMirror {...web.props} useSession={sessionHook([timeout])} />)
    expect(web.props.autoRevealBrowser).not.toHaveBeenCalled()
    web.unmount()
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const native = mount(loading, false)
    native.rerender(<BrowserMirror {...native.props} useSession={sessionHook([timeout])} />)
    native.rerender(<BrowserMirror {...native.props} useSession={sessionHook([timeout])}
      useBrowserMirror={viewHook(ready(2))} interactionEpoch={1} />)
    expect(native.props.autoRevealBrowser).not.toHaveBeenCalled()
  })

  it('treats an already settled native timeout in loaded history as baseline only', () => {
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const timeout = result(8, 'browser_navigate', id, { isError: true, content: `Error: ${stoppedNavigation}` })
    const browser = mount(loading, false, sessionHook([timeout], 'loading'))
    browser.rerender(<BrowserMirror {...browser.props} useSession={sessionHook([timeout])}
      useBrowserMirror={viewHook(ready())} />)
    expect(browser.props.autoRevealBrowser).not.toHaveBeenCalled()
  })

  it('aligns a workbench fallback to its browser page without overriding new Host observations', () => {
    const result = mount(ready(), false)
    result.rerender(<BrowserMirror {...result.props} shown selectedTabId={otherId} />)
    expect(result.command).toHaveBeenCalledExactlyOnceWith({ kind: 'select-tab', tabId: otherId })
    result.rerender(<BrowserMirror {...result.props} shown selectedTabId={otherId}
      useBrowserMirror={viewHook(ready(2))} />)
    expect(result.command).toHaveBeenCalledTimes(1)
    expect(result.syncBrowserTabs).toHaveBeenLastCalledWith(expect.any(Array), id)
  })

  it('lets Host hydration and pending manual selection settle without sending duplicate page commands', () => {
    const result = mount(loading)
    result.rerender(<BrowserMirror {...result.props} selectedTabId={otherId} />)
    result.rerender(<BrowserMirror {...result.props} selectedTabId={otherId}
      useBrowserMirror={viewHook(ready())} />)
    expect(result.command).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} selectedTabId={id}
      useBrowserMirror={viewHook({ ...ready(), pending: true })} />)
    expect(result.command).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} selectedTabId={otherId}
      useBrowserMirror={viewHook({ ...ready(), state: { ...state(), operationActive: true } as never })} />)
    expect(result.command).not.toHaveBeenCalled()
  })

  it('mounts hidden without creating a tab and ensures first tab when displayed empty', () => {
    const hidden = mount(empty, false)
    expect(screen.getByRole('region', { hidden: true }).hasAttribute('hidden')).toBe(true)
    expect(hidden.ensureTab).not.toHaveBeenCalled()
    hidden.unmount()
    const shown = mount(empty)
    expect(shown.ensureTab).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Start browsing')).toBeTruthy()
    expect(screen.getByText('Enter a URL to open a page')).toBeTruthy()
    expect(screen.getByText('Start browsing').parentElement?.querySelector('svg')).not.toBeNull()
  })

  it('uses an explicit workbench request to create a page without also ensuring an empty tab', () => {
    const result = mount(empty, false)
    result.rerender(<BrowserMirror {...result.props} shown newTabRequest={1} />)
    expect(result.command).toHaveBeenCalledExactlyOnceWith({ kind: 'new-tab' })
    expect(result.ensureTab).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} shown newTabRequest={1} />)
    expect(result.command).toHaveBeenCalledTimes(1)
  })

  it('acknowledges the issued request so a remounted content slot does not replay it', () => {
    const result = mount(ready(), false)
    result.rerender(<BrowserMirror {...result.props} shown newTabRequest={1} />)
    expect(result.command).toHaveBeenCalledExactlyOnceWith({ kind: 'new-tab' })
    expect(result.props.markTabRequestHandled).toHaveBeenCalledExactlyOnceWith(1)
    result.unmount()
    const remounted = render(<BrowserMirror {...result.props} shown newTabRequest={1} handledTabRequest={1} />)
    expect(result.command).toHaveBeenCalledTimes(1)
    remounted.rerender(<BrowserMirror {...result.props} shown newTabRequest={2} handledTabRequest={1} />)
    expect(result.command).toHaveBeenCalledTimes(2)
    expect(result.props.markTabRequestHandled).toHaveBeenLastCalledWith(2)
  })

  it('retries a pending browser-tab focus only after the tab becomes enabled', () => {
    const result = mount(ready())
    const busy: BrowserView = { ...ready(), pending: true }
    const tab = render(<BrowserTabs {...result.props} tabId={id} useBrowserMirror={viewHook(busy)} />)
    expect(result.props.focusPendingBrowserTab).not.toHaveBeenCalled()
    tab.rerender(<BrowserTabs {...result.props} tabId={id} useBrowserMirror={viewHook(ready())} />)
    expect(result.props.focusPendingBrowserTab).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('consumes the entry opportunity when an existing tab loads, so closing the last tab never recreates it', async () => {
    const sole = { ...state(), tabs: [state().tabs[0]] }
    const existing: BrowserView = { phase: 'ready', state: sole as never, frameUrl: 'blob:frame', pending: false }
    const result = mount(loading)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(existing)} />)
    expect(result.ensureTab).not.toHaveBeenCalled()
    render(browserTabsRow(result.props, existing))
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(empty)} />)
    await Promise.resolve()
    expect(result.command).toHaveBeenCalledWith({ kind: 'close-tab', tabId: id })
    expect(result.syncBrowserTabs).toHaveBeenLastCalledWith([], null)
    expect(result.ensureTab).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} shown={false} useBrowserMirror={viewHook(empty)} />)
    result.rerender(<BrowserMirror {...result.props} shown useBrowserMirror={viewHook(empty)} />)
    expect(result.ensureTab).toHaveBeenCalledTimes(1)
  })

  it('waits through loading or an unknown error until the menu entry finds an empty browser', () => {
    const result = mount(loading, false)
    result.rerender(<BrowserMirror {...result.props} shown useBrowserMirror={viewHook(loading)} />)
    result.rerender(<BrowserMirror {...result.props} shown useBrowserMirror={viewHook({
      phase: 'error', state: null, frameUrl: null, pending: false, message: 'HTTP 503',
    })} />)
    expect(result.ensureTab).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} shown useBrowserMirror={viewHook(empty)} />)
    expect(result.ensureTab).toHaveBeenCalledTimes(1)
    result.rerender(<BrowserMirror {...result.props} shown useBrowserMirror={viewHook(empty)} />)
    expect(result.ensureTab).toHaveBeenCalledTimes(1)
  })

  it('sizes a real tab from the desktop and narrow pane, without duplicate commands', async () => {
    mockResizeObserver()
    const result = mount(ready())
    const observer = observers[0]!
    expect(observer.observe).toHaveBeenCalledWith(screen.getByTestId('browser-canvas'))
    act(() => { observer.fire(940, 620) })
    await act(async () => { await vi.advanceTimersByTimeAsync(199) })
    expect(result.command).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.command).toHaveBeenCalledWith({ kind: 'set-viewport', width: 940, height: 620 })
    act(() => { observer.fire(940, 620) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).toHaveBeenCalledTimes(1)
    const resized: BrowserView = { ...ready(2), state: { ...state(2), viewport: { width: 940, height: 620 } } as never }
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(resized)} />)
    act(() => { observer.fire(375, 680) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).toHaveBeenLastCalledWith({ kind: 'set-viewport', width: 375, height: 680 })
    expect(result.command).toHaveBeenCalledTimes(2)
  })

  it('retains a pending resize through navigation and cancels old tab or hidden measurements', async () => {
    mockResizeObserver()
    const initial: BrowserView = { ...ready(), pending: true }
    const result = mount(initial)
    const first = observers[0]!
    act(() => { first.fire(900, 600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready(2))} />)
    expect(result.command).toHaveBeenCalledWith({ kind: 'set-viewport', width: 900, height: 600 })
    act(() => { first.fire(375, 700) })
    const switched: BrowserView = { phase: 'ready', state: state(3, otherId) as never, frameUrl: null, pending: false }
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(switched)} />)
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).toHaveBeenCalledTimes(1)
    const second = observers[1]!
    act(() => { second.fire(375, 680) })
    result.rerender(<BrowserMirror {...result.props} shown={false} useBrowserMirror={viewHook(switched)} />)
    expect(second.disconnect).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).toHaveBeenCalledTimes(1)
    expect(result.ensureTab).not.toHaveBeenCalled()
  })

  it('retries a failed viewport command at the same revision after explicit Retry, then stops after success', async () => {
    mockResizeObserver()
    const result = mount(ready())
    result.command.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    act(() => { observers[0]!.fire(900, 600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).toHaveBeenCalledTimes(1)
    const failed: BrowserView = { phase: 'error', state: state() as never,
      frameUrl: 'blob:frame', pending: false, message: 'HTTP 503' }
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(failed)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(result.props.retry).toHaveBeenCalledTimes(1)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(result.command).toHaveBeenNthCalledWith(2, { kind: 'set-viewport', width: 900, height: 600 })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.command).toHaveBeenCalledTimes(2)
  })

  it('backs off a transient failure and cancels retries on hide or unmount', async () => {
    mockResizeObserver()
    const result = mount(ready())
    result.command.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    act(() => { observers[0]!.fire(900, 600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    await act(async () => { await vi.advanceTimersByTimeAsync(799) })
    expect(result.command).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.command).toHaveBeenCalledTimes(2)
    result.unmount()

    const hidden = mount(ready())
    hidden.command.mockResolvedValueOnce(false)
    act(() => { observers[1]!.fire(375, 680) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    hidden.rerender(<BrowserMirror {...hidden.props} shown={false} useBrowserMirror={viewHook(ready())} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(hidden.command).toHaveBeenCalledTimes(1)
    hidden.unmount()

    const disposed = mount(ready())
    disposed.command.mockResolvedValueOnce(false)
    act(() => { observers[2]!.fire(375, 680) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    disposed.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(disposed.command).toHaveBeenCalledTimes(1)
  })

  it('caps automatic retries for a persistently failing viewport without a tight loop', async () => {
    mockResizeObserver()
    const result = mount(ready())
    result.command.mockResolvedValue(false)
    act(() => { observers[0]!.fire(900, 600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    for (let n = 0; n < 10; n++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    }
    expect(result.command).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(result.command).toHaveBeenCalledTimes(4)
  })

  it('never observes or resizes a browser with no tab', () => {
    mockResizeObserver()
    const result = mount(empty)
    expect(result.ensureTab).toHaveBeenCalledTimes(1)
    expect(observers).toHaveLength(0)
    expect(result.command).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} shown={false} useBrowserMirror={viewHook(empty)} />)
    expect(observers).toHaveLength(0)
  })

  it('navigates a domain with Enter and rejects unsafe input explicitly', () => {
    const result = mount(ready())
    const address = screen.getByRole('textbox', { name: 'Address' })
    expect(address.getAttribute('placeholder')).toBe('Enter URL or domain')
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'deepseek.com' } })
    fireEvent.submit(address.closest('form')!)
    expect(result.command).toHaveBeenCalledWith({ kind: 'navigate', url: 'https://deepseek.com/' })
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(address.closest('form')!)
    expect(screen.getByRole('alert').textContent).toContain('valid HTTP(S)')
    expect(result.command).toHaveBeenCalledTimes(1)
  })

  it('compacts a submitted URL after pending and Host reconciliation without prefixing the next fill', () => {
    const origin = 'http://127.0.0.1:5678'
    const blank = navigated('about:blank', 1)
    const result = mount(blank)
    const address = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: origin } })
    fireEvent.submit(address.closest('form')!)
    expect(result.command).toHaveBeenCalledWith({ kind: 'navigate', url: `${origin}/` })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook({ ...blank, pending: true })} />)
    expect(address.disabled).toBe(true)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(navigated(`${origin}/`, 2))} />)
    fireEvent.blur(address)
    expect(address.value).toBe('127.0.0.1')
    expect(address.closest('form')?.getAttribute('data-compact')).toBe('true')

    fireEvent.focus(address)
    expect(address.value).toBe(`${origin}/`)
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(address.value.length)
    fireEvent.change(address, { target: { value: `${origin}/second` } })
    expect(address.value).toBe(`${origin}/second`)
    fireEvent.submit(address.closest('form')!)
    expect(result.command).toHaveBeenLastCalledWith({ kind: 'navigate', url: `${origin}/second` })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(navigated(`${origin}/second`, 3))} />)
    fireEvent.blur(address)
    expect(address.value).toBe('127.0.0.1')
    expect(address.closest('form')?.getAttribute('data-compact')).toBe('true')
    fireEvent.focus(address)
    expect(address.value).toBe(`${origin}/second`)
  })

  it('does not overwrite an editing URL when parent state updates', () => {
    const result = mount(ready())
    const address = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement
    expect(address.value).toBe('example.com')
    expect(address.closest('form')?.getAttribute('data-compact')).toBe('true')
    fireEvent.focus(address)
    expect(address.value).toBe('https://example.com/')
    expect(address.closest('form')?.getAttribute('data-compact')).toBe('false')
    fireEvent.change(address, { target: { value: 'my.draft' } })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={selector => selector(ready(2))} />)
    expect(address.value).toBe('my.draft')
    fireEvent.blur(address)
    expect(address.value).toBe('my.draft')
    fireEvent.focus(address)
    expect(address.value).toBe('my.draft')
  })

  it('exposes history and agent pointer without embedding page DOM', () => {
    const result = mount(ready())
    for (const label of ['Back', 'Forward', 'Reload', 'Open address']) {
      const button = screen.getByRole('button', { name: label })
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.textContent).toBe('')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'back' })
    expect(screen.getByRole('button', { name: 'Forward' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'reload' })
    expect(screen.getByRole('img', { name: 'Browser page screenshot' }).getAttribute('src')).toBe('blob:frame')
    expect(screen.getByRole('img', { name: 'Browser page screenshot' }).parentElement?.parentElement?.getAttribute('style'))
      .toContain('width: 1280px; aspect-ratio: 1280 / 720')
    expect(screen.getByRole('img', { name: 'Click' }).getAttribute('style')).toContain('left: 25%')
    expect(result.container.querySelector('iframe, webview')).toBeNull()
  })

  it.each([1, 2])('maps %ix screenshot clicks, wheel gestures and text input in CSS viewport coordinates', (scale) => {
    const result = mount(ready())
    const img = screen.getByRole('img', { name: 'Browser page screenshot' }) as HTMLImageElement
    const button = screen.getByRole('button', { name: /Click the page screenshot/ })
    expect(button.hasAttribute('disabled')).toBe(true)
    Object.defineProperties(img, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1280 * scale },
      naturalHeight: { configurable: true, value: 720 * scale },
    })
    img.getBoundingClientRect = () => ({ left: 100, top: 30, right: 740, bottom: 390,
      width: 640, height: 360 } as DOMRect)
    fireEvent.load(img)
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button, { clientX: 260, clientY: 210, detail: 1 })
    const target = { browserGeneration: 'g1', stateRevision: 1, tabId: id,
      generation: 'tab-g1', revision: 1, viewport: { width: 1280, height: 720 } }
    expect(result.command).toHaveBeenCalledWith({ kind: 'click', target, x: 320, y: 360 })
    fireEvent.click(button, { clientX: 90, clientY: 210, detail: 1 })
    expect(result.command).toHaveBeenCalledTimes(1)
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: 420, clientY: 120, deltaY: 240 })
    act(() => { button.dispatchEvent(wheel) })
    expect(wheel.defaultPrevented).toBe(true)
    expect(result.command).toHaveBeenCalledWith({ kind: 'scroll', target, x: 640, y: 180,
      direction: 'down', pixels: 240 })
    fireEvent.click(screen.getByRole('button', { name: 'Type' }))
    fireEvent.click(button, { clientX: 260, clientY: 210, detail: 1 })
    const text = screen.getByRole('textbox', { name: 'Insert text at the selected location' })
    fireEvent.change(text, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'type', target, x: 320, y: 360, text: 'hello' })
  })

  it('disables all manual actions while the agent owns the browser and rejects mismatched frames', () => {
    const busy = { ...state(), operationActive: true }
    const result = mount({ phase: 'ready', state: busy as never, frameUrl: 'blob:frame', pending: false })
    expect(screen.getByRole('status').textContent).toContain('AI is using the browser')
    expect(screen.getByRole('textbox', { name: 'Address' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Type' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Click the page screenshot/ }).hasAttribute('disabled')).toBe(true)
    render(browserTabsRow(result.props, { phase: 'ready', state: busy as never, frameUrl: 'blob:frame', pending: false }))
    expect(screen.getByRole('tab', { name: 'Example' }).hasAttribute('disabled')).toBe(true)
    result.unmount()
    const lock = mount({ phase: 'busy', state: null, frameUrl: null, pending: false })
    expect(lock.ensureTab).not.toHaveBeenCalled()
    expect(screen.getByText('AI is using the browser. Manual controls resume when it finishes.')).toBeTruthy()
  })

  it('accepts 1x fallback and 2x image pixels but rejects mismatched or arbitrary scales', () => {
    const result = mount(ready())
    const img = screen.getByRole('img', { name: 'Browser page screenshot' }) as HTMLImageElement
    const action = screen.getByRole('button', { name: /Click the page screenshot/ })
    Object.defineProperties(img, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1280 },
      naturalHeight: { configurable: true, value: 721 },
    })
    fireEvent.load(img)
    expect(action.hasAttribute('disabled')).toBe(true)
    Object.defineProperties(img, {
      naturalWidth: { configurable: true, value: 1920 },
      naturalHeight: { configurable: true, value: 1080 },
    })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(action.hasAttribute('disabled')).toBe(true)
    Object.defineProperties(img, {
      naturalWidth: { configurable: true, value: 2560 },
      naturalHeight: { configurable: true, value: 720 },
    })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(action.hasAttribute('disabled')).toBe(true)
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1440 })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(action.hasAttribute('disabled')).toBe(false)
    const mismatched: BrowserView = { ...ready(), state: { ...state(), viewport: { width: 940, height: 620 } } as never }
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(mismatched)} />)
    expect(action.hasAttribute('disabled')).toBe(true)
    Object.defineProperties(img, {
      naturalWidth: { configurable: true, value: 1280 },
      naturalHeight: { configurable: true, value: 720 },
    })
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(action.hasAttribute('disabled')).toBe(false)
  })

  it('pauses automatic viewport resizing during agent work and resumes when released', async () => {
    mockResizeObserver()
    const locked: BrowserView = { ...ready(), state: { ...state(), operationActive: true } as never }
    const result = mount(locked)
    act(() => { observers[0]!.fire(940, 620) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(result.command).not.toHaveBeenCalled()
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(ready())} />)
    expect(result.command).toHaveBeenCalledWith({ kind: 'set-viewport', width: 940, height: 620 })
  })

  it('disables controls while pending and displays actionable error', () => {
    const pending = mount({ ...ready(), pending: true })
    expect(screen.getByRole('status').textContent).toContain('Opening')
    expect(screen.getByTestId('browser-canvas').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').closest('[aria-busy="true"]')).toBeNull()
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true)
    pending.unmount()
    const error = mount({ phase: 'error', state: null, frameUrl: null, pending: false, message: 'HTTP 503' })
    expect(screen.getByRole('alert').textContent).toContain('503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(error.props.retry).toHaveBeenCalledTimes(1)
  })

  it('keeps manual navigation, reload and initial loading feedback in the address bar', () => {
    const browser = mount(ready())
    const address = screen.getByRole<HTMLInputElement>('textbox', { name: 'Address' })
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'https://next.example/long/path' } })
    fireEvent.submit(address.closest('form')!)
    expect(browser.command).toHaveBeenCalledWith({ kind: 'navigate', url: 'https://next.example/long/path' })
    browser.rerender(<BrowserMirror {...browser.props} useBrowserMirror={viewHook({ ...ready(), pending: true })} />)
    expect(address.value).toBe('https://next.example/long/path')
    expect(screen.getByRole('status').closest('form')).toBe(address.closest('form'))
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()
    browser.rerender(<BrowserMirror {...browser.props} useBrowserMirror={viewHook(ready())} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(browser.command).toHaveBeenCalledWith({ kind: 'reload' })
    browser.rerender(<BrowserMirror {...browser.props} useBrowserMirror={viewHook({ ...ready(), pending: true })} />)
    expect(screen.getByRole('status').closest('form')).toBe(address.closest('form'))
    browser.rerender(<BrowserMirror {...browser.props} useBrowserMirror={viewHook(loading)} />)
    expect(screen.getByRole('status').textContent).toBe('Loading browser state…')
    expect(screen.getByRole('status').closest('form')).toBe(address.closest('form'))
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()
  })

  it('tracks native page loading after the navigation command settles until the page stops loading', () => {
    vi.stubGlobal('codingDesktop', { browser: { available: true, present: vi.fn(async () => {}) } })
    const tabLoading = { ...state(), tabs: state().tabs.map(tab => ({ ...tab, loading: tab.id === id })) }
    const browser = mount({ phase: 'ready', state: tabLoading as never, frameUrl: null, pending: false })
    const address = screen.getByRole('textbox', { name: 'Address' })
    expect(screen.getByTestId('browser-canvas').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').closest('form')).toBe(address.closest('form'))
    expect(screen.getByTestId('browser-canvas').querySelector('[role="status"]')).toBeNull()

    const stopped = { ...tabLoading, tabs: tabLoading.tabs.map(tab => ({ ...tab, loading: false })) }
    browser.rerender(<BrowserMirror {...browser.props}
      useBrowserMirror={viewHook({ phase: 'ready', state: stopped as never, frameUrl: null, pending: false })} />)
    expect(screen.getByTestId('browser-canvas').getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByTestId('browser-link-loading')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('selects and closes pages through their individual workbench contributions', async () => {
    const result = mount(ready())
    const tabs = render(browserTabsRow(result.props, ready()))
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Example' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Example' }).querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(screen.getByRole('tab', { name: /New tab/ }).querySelector('svg')).not.toBeNull()
    const close = screen.getByRole('button', { name: 'Close Example' })
    expect(close.querySelector('svg')).not.toBeNull()
    expect(close.textContent).toBe('')
    fireEvent.click(screen.getByRole('tab', { name: /New tab/ }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'select-tab', tabId: otherId })
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'close-tab', tabId: id })
    tabs.unmount()
    const sole = { ...state(), tabs: [state().tabs[0]] }
    render(browserTabsRow(result.props, { phase: 'ready', state: sole as never, frameUrl: null, pending: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    await Promise.resolve()
    expect(result.command).toHaveBeenLastCalledWith({ kind: 'close-tab', tabId: id })
  })

  it('hands keyboard focus to the next tab after closing an active tab', async () => {
    const result = mount(ready())
    const initial = ready()
    const tabs = render(browserTabsRow(result.props, initial))
    const close = screen.getByRole('button', { name: 'Close Example' })
    close.focus()
    fireEvent.click(close)
    const next = { ...state(2, otherId), tabs: [state().tabs[1]] }
    tabs.rerender(browserTabsRow(result.props, { phase: 'ready', state: next as never, frameUrl: null, pending: false }))
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('tab', { name: /New tab/ })) })
  })

  it('renders each browser page in the shared tab row and reopens an already active Host page', () => {
    const result = mount(ready(), false)
    const tabs = render(<div role="tablist" aria-label="Workbench tabs">
      <button type="button" role="tab" aria-selected>coding 1</button>
      <BrowserTabs {...result.props} shown browserShown={false} tabId={id} />
      <BrowserTabs {...result.props} shown browserShown={false} tabId={otherId} />
    </div>)
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Example' }))
    expect(result.props.openBrowser).toHaveBeenCalledWith(id)
    expect(result.command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'New tab' }))
    expect(result.props.openBrowser).toHaveBeenLastCalledWith(otherId)
    expect(result.command).toHaveBeenCalledWith({ kind: 'select-tab', tabId: otherId })
    tabs.rerender(<div role="tablist" aria-label="Workbench tabs">
      <button type="button" role="tab" aria-selected={false}>coding 1</button>
      <BrowserTabs {...result.props} shown browserShown tabId={id} />
    </div>)
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true')
  })

  it('links each contributed browser tab to the owner-provided panel ID', () => {
    const result = mount(ready(), false)
    render(<BrowserTabs {...result.props} shown browserShown tabId={id}
      tabDomId="owner-browser-tab" panelDomId="owner-browser-panel" />)
    const tab = screen.getByRole('tab', { name: 'Example' })
    expect(tab.id).toBe('owner-browser-tab')
    expect(tab.getAttribute('aria-controls')).toBe('owner-browser-panel')
  })

  it('contributes only page tabs and leaves final page removal to the workbench', async () => {
    const result = mount(ready(), false)
    const add = render(<BrowserTabs {...result.props} shown />)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
    add.unmount()
    const sole: BrowserView = { ...ready(), state: { ...state(), tabs: [state().tabs[0]] } as never }
    render(<BrowserTabs {...result.props} shown browserShown tabId={id}
      useBrowserMirror={viewHook(sole)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    await Promise.resolve()
    expect(result.command).toHaveBeenCalledWith({ kind: 'close-tab', tabId: id })
    expect(result.props.openBrowser).not.toHaveBeenCalled()
  })

  it('keeps the workbench page descriptor visible and disabled while Host state is unavailable', () => {
    const result = mount(loading, false)
    const tab = render(<BrowserTabs {...result.props} shown browserShown tabId={id} tabName="Example" />)
    const page = screen.getByRole('tab', { name: 'Example' })
    expect(page.getAttribute('aria-selected')).toBe('true')
    expect(page.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Close Example' }).hasAttribute('disabled')).toBe(true)
    tab.rerender(<BrowserTabs {...result.props} shown browserShown={false} tabId={id} tabName="Example"
      useBrowserMirror={viewHook({ phase: 'busy', state: null, frameUrl: null, pending: false })} />)
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('false')
    fireEvent.click(page)
    expect(result.props.openBrowser).not.toHaveBeenCalled()
    expect(result.command).not.toHaveBeenCalled()
  })
})
