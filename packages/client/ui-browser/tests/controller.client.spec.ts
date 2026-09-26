import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserMirrorController } from '../src/client/controller.ts'

const state = (generation: string, revision: number) => ({
  generation, revision, url: 'https://example.com/', title: 'Example', snapshot: '',
  viewport: { width: 1280, height: 720 }, cursor: null, hasFrame: true,
})
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const frame = (): Response => ({
  ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => new Blob(['png']),
} as Response)
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const createUrl = vi.fn(() => 'blob:frame')
const revokeUrl = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('location', { origin: 'http://localhost:3000' })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createUrl)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); createUrl.mockClear(); revokeUrl.mockClear() })

describe('browser mirror controller', () => {
  it('establishes the first mounted state as baseline and opens once on a newer revision', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/frame?')) return frame()
      return json(state('g1', fetcher.mock.calls.filter(([url]) => String(url).includes('/state?')).length))
    })
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await vi.advanceTimersByTimeAsync(10)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { revision: 1 }, frameUrl: 'blob:frame' })
    expect(open).not.toHaveBeenCalled()
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('sessionId=session-1')
    await vi.advanceTimersByTimeAsync(750)
    expect(open).toHaveBeenCalledTimes(1)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { revision: 2 } })
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    stop()
    expect(revokeUrl).toHaveBeenCalledTimes(2)
    expect(controller.view.getSnapshot().phase).toBe('loading')
  })

  it('does not open an existing browser, but opens after an initial 204', async () => {
    let hits = 0
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/frame?') ? frame()
      : ++hits === 1 ? new Response(null, { status: 204 }) : json(state('next', 1)))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('empty')
    await vi.advanceTimersByTimeAsync(750)
    expect(open).toHaveBeenCalledTimes(1)
    stop()
  })

  it('publishes a new revision and opens the panel only after its matching frame arrives', async () => {
    let settle!: (response: Response) => void
    let hits = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/frame?')) {
        if (hits === 1) return frame()
        return new Promise<Response>((resolve) => { settle = resolve })
      }
      return json(state('g1', ++hits))
    })
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await flush()
    const first = controller.view.getSnapshot()
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toBe(first)
    expect(open).not.toHaveBeenCalled()
    settle(frame())
    await flush()
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { revision: 2 }, frameUrl: 'blob:frame' })
    expect(open).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reports a failed new frame without pairing it with the previous revision image', async () => {
    let hits = 0
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/frame?')
      ? hits === 1 ? frame() : new Response(null, { status: 503 })
      : json(state('g1', ++hits)))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await flush()
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({
      phase: 'error', state: { revision: 2 }, frameUrl: null, message: '画面 HTTP 503',
    })
    expect(open).not.toHaveBeenCalled()
    expect(revokeUrl).toHaveBeenCalledTimes(1)
    stop()
  })

  it('opens once when a new revision recovers from a transient frame failure after an empty baseline', async () => {
    let stateHits = 0
    let frameHits = 0
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/frame?')
      ? ++frameHits === 1 ? new Response(null, { status: 503 }) : frame()
      : ++stateHits === 1 ? new Response(null, { status: 204 }) : json(state('g1', 1)))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('empty')
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'error', state: { revision: 1 }, frameUrl: null })
    expect(open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { revision: 1 }, frameUrl: 'blob:frame' })
    expect(open).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(open).toHaveBeenCalledTimes(1)
    expect(frameHits).toBe(2)
    stop()
    expect(revokeUrl).toHaveBeenCalledTimes(1)
  })

  it('keeps an initially observed revision as baseline even if its first frame fails', async () => {
    let frameHits = 0
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/frame?')
      ? ++frameHits === 1 ? new Response(null, { status: 503 }) : frame()
      : json(state('g1', 1)))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(open)
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('error')
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { revision: 1 }, frameUrl: 'blob:frame' })
    expect(open).not.toHaveBeenCalled()
    stop()
  })

  it('does not publish another snapshot while the revision remains unchanged', async () => {
    const fetcher = vi.fn(async (input: string | URL) => String(input).includes('/frame?')
      ? frame() : json(state('g1', 1)))
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(vi.fn())
    await flush()
    const ready = controller.view.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = controller.view.subscribe(listener)
    await vi.advanceTimersByTimeAsync(2250)
    expect(controller.view.getSnapshot()).toBe(ready)
    expect(listener).not.toHaveBeenCalled()
    expect(createUrl).toHaveBeenCalledTimes(1)
    unsubscribe()
    stop()
  })

  it('ignores regressing revisions and retired generations, then revokes on disappearance', async () => {
    const observations = [state('g1', 3), state('g1', 2), state('g2', 1), state('g1', 4)]
    let next = 0
    const ordered = vi.fn(async (input: string | URL) => String(input).includes('/frame?') ? frame()
      : next < observations.length ? json(observations[next++])
        : new Response(null, { status: 204 }))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-1', ordered)
    const stop = controller.start(open)
    await flush()
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.revision).toBe(3)
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.generation).toBe('g2')
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.generation).toBe('g2')
    expect(open).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().phase).toBe('empty')
    stop()
  })

  it('disposes an in-flight frame and offers retry after an HTTP failure', async () => {
    let settle!: (response: Response) => void
    let hits = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/frame?')) return new Promise<Response>((resolve) => { settle = resolve })
      return ++hits === 1 ? new Response(null, { status: 503 }) : json(state('g1', 1))
    })
    const controller = new BrowserMirrorController('session-1', fetcher)
    const stop = controller.start(vi.fn())
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('error')
    controller.retry()
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    stop()
    settle(frame())
    await flush()
    expect(createUrl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
