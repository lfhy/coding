import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserMirrorController } from '../src/client/controller.ts'
import { id, otherId, state } from './browser-fixtures.ts'

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const frame = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
  blob: async () => new Blob(['png']) } as Response)
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }
const createUrl = vi.fn(() => 'blob:frame')
const revokeUrl = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('location', { origin: 'http://localhost:3000' })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createUrl)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); createUrl.mockClear(); revokeUrl.mockClear() })

describe('browser session controller', () => {
  it('tracks revision and precisely keys frame by session, tab, and both generations', async () => {
    let hits = 0
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame() : json(state(++hits)))
    const open = vi.fn()
    const controller = new BrowserMirrorController('session-a', fetcher)
    const stop = controller.start(open)
    await flush()
    const image = String(fetcher.mock.calls.find(([url]) => String(url).includes('/frame?'))?.[0])
    expect(image).toContain('sessionId=session-a')
    expect(image).toContain(`tabId=${id}`)
    expect(image).toContain('browserGeneration=g1')
    expect(image).toContain('stateRevision=1')
    expect(image).toContain('generation=tab-g1')
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', frameUrl: 'blob:frame' })
    expect(open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    expect(open).toHaveBeenCalledTimes(1)
    stop()
    expect(revokeUrl).toHaveBeenCalledTimes(2)
  })

  it('keeps newer state against regressions and tab switches without leaking the old image', async () => {
    const sequence = [state(3), state(2), state(4, otherId), state(1, id, 'g2'), state(5)]
    let index = 0
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame()
      : json(sequence[Math.min(index++, sequence.length - 1)]))
    const controller = new BrowserMirrorController('session-a', fetcher)
    const stop = controller.start(vi.fn())
    await flush()
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.stateRevision).toBe(3)
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ frameUrl: null, state: { activeTabId: otherId } })
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { browserGeneration: 'g2' } })
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { browserGeneration: 'g2' } })
    stop()
  })

  it('re-reads immediately after stale frame 409 and never pairs it to the old revision', async () => {
    let hits = 0
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?')
      ? hits === 1 ? new Response(null, { status: 409 }) : frame()
      : json(state(++hits)))
    const controller = new BrowserMirrorController('session-a', fetcher)
    const stop = controller.start(vi.fn())
    await flush()
    expect(controller.view.getSnapshot()).toMatchObject({ state: { stateRevision: 1 }, frameUrl: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { stateRevision: 2 }, frameUrl: 'blob:frame' })
    stop()
  })

  it('only creates a tab explicitly; successful RPC publishes before the next poll', async () => {
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?')
      ? frame() : new Response(null, { status: 204 }))
    const control = vi.fn(async () => ({ result: { ok: true, value: state() } }))
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start(vi.fn())
    await flush()
    expect(control).not.toHaveBeenCalled()
    await controller.ensureTab()
    expect(control).toHaveBeenCalledWith({ sessionId: 'session-a', command: { kind: 'ensure-tab' } }, expect.any(AbortSignal))
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { activeTabId: id } })
    stop()
  })

  it('keeps the last-tab close as 204 until an explicit later ensure-tab', async () => {
    let closed = false
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?')
      ? frame() : closed ? new Response(null, { status: 204 }) : json(state()))
    const control = vi.fn(async ({ command }: { command: { kind: string } }) => {
      closed = command.kind === 'close-tab'
      return { result: { ok: true, value: closed ? null : state() } }
    })
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start(vi.fn())
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('ready')
    expect(await controller.command({ kind: 'close-tab', tabId: id as never })).toBe(true)
    expect(controller.view.getSnapshot().phase).toBe('empty')
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().phase).toBe('empty')
    expect(control).toHaveBeenCalledTimes(1)
    await controller.ensureTab()
    expect(control).toHaveBeenNthCalledWith(2,
      { sessionId: 'session-a', command: { kind: 'ensure-tab' } }, expect.any(AbortSignal))
    expect(controller.view.getSnapshot().phase).toBe('ready')
    stop()
  })

  it('publishes a resized viewport only with its matching captured frame', async () => {
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame() : json(state()))
    const resized = { ...state(2), viewport: { width: 940, height: 620 },
      observation: { ...state(2).observation, viewport: { width: 940, height: 620 } } }
    const control = vi.fn(async () => ({ result: { ok: true, value: resized } }))
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start(vi.fn())
    await flush()
    expect(await controller.command({ kind: 'set-viewport', width: 940, height: 620 })).toBe(true)
    expect(control).toHaveBeenCalledWith({
      sessionId: 'session-a', command: { kind: 'set-viewport', width: 940, height: 620 },
    }, expect.any(AbortSignal))
    expect(controller.view.getSnapshot()).toMatchObject({
      phase: 'ready', state: { viewport: { width: 940, height: 620 },
        observation: { viewport: { width: 940, height: 620 } } }, frameUrl: 'blob:frame',
    })
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('stateRevision=2')
    stop()
  })

  it('reports command failure and cancels an in-flight command at teardown', async () => {
    let settle!: (value: unknown) => void
    const control = vi.fn(async () => new Promise((resolve) => { settle = resolve }))
    const controller = new BrowserMirrorController('session-a', async () => new Response(null, { status: 204 }), control as never)
    const stop = controller.start(vi.fn())
    await flush()
    const pending = controller.command({ kind: 'new-tab' })
    expect(controller.view.getSnapshot().pending).toBe(true)
    stop()
    settle({ result: { ok: true, value: state() } })
    expect(await pending).toBe(false)
    expect(controller.view.getSnapshot().phase).toBe('loading')
  })
})
