// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BrowserMirror, type BrowserMirrorProps } from '../src/client/BrowserMirror.tsx'
import type { BrowserView } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

const state = {
  generation: 'g1', revision: 2, url: 'https://example.com/', title: 'Example',
  snapshot: 'Page text', viewport: { width: 1280, height: 720 },
  cursor: { x: 320, y: 540, kind: 'click' as const, at: Date.now() }, hasFrame: true,
}

afterEach(() => { cleanup(); vi.useRealTimers() })

function mount(view: BrowserView, shown = true) {
  const openBrowser = vi.fn()
  const closeBrowser = vi.fn()
  const retry = vi.fn()
  const dispose = vi.fn()
  const start = vi.fn(() => dispose)
  const props = {
    shown, openBrowser, closeBrowser, retry, start,
    useBrowserMirror: () => view,
    t: (key: keyof typeof en) => en[key],
  } as unknown as BrowserMirrorProps
  const result = render(<BrowserMirror {...props} />)
  return { ...result, openBrowser, closeBrowser, retry, start, dispose }
}

describe('browser mirror view', () => {
  it('keeps the hidden entry mounted and releases its poller when unmounted', () => {
    const result = mount({ phase: 'empty', state: null, frameUrl: null }, false)
    expect(screen.getByRole('region', { hidden: true }).hasAttribute('hidden')).toBe(true)
    expect(result.start).toHaveBeenCalledTimes(1)
    result.unmount()
    expect(result.dispose).toHaveBeenCalledTimes(1)
  })

  it('shows loading, empty, and error with an actionable retry', () => {
    const loading = mount({ phase: 'loading', state: null, frameUrl: null })
    expect(screen.getByRole('status').textContent).toContain('Loading')
    loading.unmount()
    const empty = mount({ phase: 'empty', state: null, frameUrl: null })
    expect(screen.getByText('No browser is open for this session')).toBeTruthy()
    empty.unmount()
    const error = mount({ phase: 'error', state: null, frameUrl: null, message: 'HTTP 503' })
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(error.retry).toHaveBeenCalledTimes(1)
  })

  it('renders a scaled screenshot and pointer position without embedding the page', () => {
    const result = mount({ phase: 'ready', state, frameUrl: 'blob:frame' })
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.getByText('https://example.com/')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Browser page screenshot' }).getAttribute('src')).toBe('blob:frame')
    const pointer = screen.getByRole('img', { name: 'Click' })
    expect(pointer.getAttribute('style')).toContain('left: 25%')
    expect(pointer.getAttribute('style')).toContain('top: 75%')
    expect(result.container.querySelector('iframe, webview')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Return to files' }))
    expect(result.closeBrowser).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Page text')).toBeTruthy()
  })

  it('does not draw a pointer when the state has no screenshot', () => {
    const result = mount({ phase: 'ready', state: { ...state, hasFrame: false }, frameUrl: null })
    expect(screen.getByText('Page image is not available yet')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Click' })).toBeNull()
    result.unmount()
  })
})
