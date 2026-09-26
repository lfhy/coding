// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserMirror, BrowserTabs, type BrowserMirrorProps } from '../src/client/BrowserMirror.tsx'
import type { BrowserView } from '../src/client/controller.ts'
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
function mount(view: BrowserView, shown = true) {
  const command = vi.fn(async () => true)
  const ensureTab = vi.fn(async () => {})
  const start = vi.fn(() => vi.fn())
  const closeBrowser = vi.fn()
  const props = { shown, openBrowser: vi.fn(), closeBrowser, start, command, ensureTab,
    retry: vi.fn(), useBrowserMirror: <S,>(selector: (snapshot: BrowserView) => S): S => selector(view),
    t } as unknown as BrowserMirrorProps
  const result = render(<BrowserMirror {...props} />)
  return { ...result, props, command, ensureTab, start, closeBrowser }
}
const ready = (revision = 1): BrowserView => ({
  phase: 'ready', state: state(revision) as never, frameUrl: 'blob:frame', pending: false,
})
const empty: BrowserView = { phase: 'empty', state: null, frameUrl: null, pending: false }
const loading: BrowserView = { phase: 'loading', state: null, frameUrl: null, pending: false }
function viewHook(view: BrowserView): BrowserMirrorProps['useBrowserMirror'] {
  return selector => selector(view)
}
function navigated(url: string, revision: number): BrowserView {
  const value = state(revision, otherId)
  return { phase: 'ready', state: {
    ...value, tabs: value.tabs.map(tab => tab.id === otherId ? { ...tab, url } : tab),
  } as never, frameUrl: null, pending: false }
}

describe('browser UI', () => {
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

  it('consumes the entry opportunity when an existing tab loads, so closing the last tab never recreates it', async () => {
    const sole = { ...state(), tabs: [state().tabs[0]] }
    const existing: BrowserView = { phase: 'ready', state: sole as never, frameUrl: 'blob:frame', pending: false }
    const result = mount(loading)
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(existing)} />)
    expect(result.ensureTab).not.toHaveBeenCalled()
    render(<BrowserTabs {...result.props} useBrowserMirror={viewHook(existing)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    result.rerender(<BrowserMirror {...result.props} useBrowserMirror={viewHook(empty)} />)
    await Promise.resolve()
    expect(result.command).toHaveBeenCalledWith({ kind: 'close-tab', tabId: id })
    expect(result.closeBrowser).toHaveBeenCalledTimes(1)
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
    expect(screen.getByRole('img', { name: 'Click' }).getAttribute('style')).toContain('left: 25%')
    expect(result.container.querySelector('iframe, webview')).toBeNull()
  })

  it('disables controls while pending and displays actionable error', () => {
    const pending = mount({ ...ready(), pending: true })
    expect(screen.getByRole('status').textContent).toContain('Opening')
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true)
    pending.unmount()
    const error = mount({ phase: 'error', state: null, frameUrl: null, pending: false, message: 'HTTP 503' })
    expect(screen.getByRole('alert').textContent).toContain('503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(error.props.retry).toHaveBeenCalledTimes(1)
  })

  it('selects and closes tabs and returns to menu when the final tab closes', async () => {
    const result = mount(ready())
    const tabs = render(<BrowserTabs {...result.props} />)
    expect(screen.getByRole('tablist', { name: 'Browser tabs' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Example' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Example' }).querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(screen.getByRole('tab', { name: /New tab/ }).querySelector('svg')).not.toBeNull()
    for (const label of ['New tab', 'Close Example']) {
      const button = screen.getByRole('button', { name: label })
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.textContent).toBe('')
    }
    fireEvent.click(screen.getByRole('tab', { name: /New tab/ }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'select-tab', tabId: otherId })
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'new-tab' })
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    expect(result.command).toHaveBeenCalledWith({ kind: 'close-tab', tabId: id })
    tabs.unmount()
    const sole = { ...state(), tabs: [state().tabs[0]] }
    render(<BrowserTabs {...result.props}
      useBrowserMirror={selector => selector({ phase: 'ready', state: sole as never, frameUrl: null, pending: false })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }))
    await Promise.resolve()
    expect(result.closeBrowser).toHaveBeenCalledTimes(1)
  })

  it('hands keyboard focus to the next tab after closing an active tab', () => {
    const result = mount(ready())
    const initial = ready()
    const tabs = render(<BrowserTabs {...result.props} useBrowserMirror={selector => selector(initial)} />)
    const close = screen.getByRole('button', { name: 'Close Example' })
    close.focus()
    fireEvent.click(close)
    const next = { ...state(2, otherId), tabs: [state().tabs[1]] }
    tabs.rerender(<BrowserTabs {...result.props}
      useBrowserMirror={selector => selector({ phase: 'ready', state: next as never, frameUrl: null, pending: false })} />)
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /New tab/ }))
  })
})
