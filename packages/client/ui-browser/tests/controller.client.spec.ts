import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserMirrorController, desktopBrowserPresentation } from '../src/client/controller.ts'
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
  it('opens a fresh Host page and never treats a failed or old-page response as success', async () => {
    const url = 'https://linked.example/'
    const fresh = { ...state(2, otherId), tabs: [...state().tabs,
      { id: '032ef1b7-466b-45a7-8d57-3288cf12b8b1', generation: 'new', url, title: 'Link',
        canGoBack: false, canGoForward: false }], activeTabId: '032ef1b7-466b-45a7-8d57-3288cf12b8b1',
    observation: null, hasFrame: false }
    const control = vi.fn().mockResolvedValueOnce({ result: { ok: true, value: fresh } })
      .mockResolvedValueOnce({ result: { ok: false, error: { message: '远程工作区不支持人工浏览器' } } })
      .mockResolvedValueOnce({ result: { ok: true, value: fresh } })
    const controller = new BrowserMirrorController('session-a', async () => json(state()), control as never)
    const stop = controller.start()
    await flush()
    expect((await controller.openUrl(url)).activeTabId).toBe(fresh.activeTabId)
    expect(control).toHaveBeenCalledWith({ sessionId: 'session-a', command: { kind: 'open-url', url } },
      expect.any(AbortSignal))
    await expect(controller.openUrl(url)).rejects.toThrow('远程工作区不支持人工浏览器')
    await expect(controller.openUrl(url)).rejects.toThrow('未返回新页面')
    stop()
  })

  it('keeps each successive link in its own newly selected page', async () => {
    const firstId = '032ef1b7-466b-45a7-8d57-3288cf12b8b1'
    const secondId = '641c045c-421f-4a10-b00b-987bf39c37bf'
    const first = { ...state(2), activeTabId: firstId, observation: null, hasFrame: false,
      tabs: [...state().tabs, { id: firstId, generation: 'first', url: 'https://first.example/', title: 'First',
        canGoBack: false, canGoForward: false }] }
    const second = { ...first, stateRevision: 3, activeTabId: secondId,
      tabs: [...first.tabs, { id: secondId, generation: 'second', url: 'https://second.example/', title: 'Second',
        canGoBack: false, canGoForward: false }] }
    const control = vi.fn().mockResolvedValueOnce({ result: { ok: true, value: first } })
      .mockResolvedValueOnce({ result: { ok: true, value: second } })
    const controller = new BrowserMirrorController('session-a', async () => json(state()), control as never, true)
    const stop = controller.start()
    await flush()
    expect((await controller.openUrl('https://first.example/')).activeTabId).toBe(firstId)
    expect((await controller.openUrl('https://second.example/')).activeTabId).toBe(secondId)
    expect(controller.view.getSnapshot().state?.tabs.map(tab => tab.id)).toEqual([id, otherId, firstId, secondId])
    expect(control.mock.calls.map(([request]) => (request as { command: unknown }).command)).toEqual([
      { kind: 'open-url', url: 'https://first.example/' }, { kind: 'open-url', url: 'https://second.example/' },
    ])
    stop()
  })

  it.each([409, 503])('does not submit another open-url after Host succeeds but frame GET returns %i', async (status) => {
    const newId = '032ef1b7-466b-45a7-8d57-3288cf12b8b1'
    const url = 'https://linked.example/'
    const initial = state()
    const fresh = { ...state(2), activeTabId: newId,
      tabs: [...initial.tabs, { id: newId, generation: 'linked', url, title: 'Linked',
        canGoBack: false, canGoForward: false }],
      observation: { ...state(2).observation!, tabId: newId, generation: 'linked', url, title: 'Linked' } }
    let frameHits = 0
    const fetcher = vi.fn(async (input: string | URL) => {
      if (!String(input).includes('/frame?')) return json(frameHits === 0 ? initial : fresh)
      frameHits++
      return frameHits === 2 ? new Response(null, { status }) : frame()
    })
    const control = vi.fn(async () => ({ result: { ok: true, value: fresh } }))
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start()
    await flush()
    expect((await controller.openUrl(url)).activeTabId).toBe(newId)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { activeTabId: newId },
      phase: status === 409 ? 'ready' : 'error' })
    if (status === 503) {
      controller.retry()
      await flush()
      expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', state: { activeTabId: newId } })
    }
    expect(control).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', command: { kind: 'open-url', url } },
      expect.any(AbortSignal))
    stop()
  })

  it('detects only the complete desktop presentation capability', () => {
    expect(desktopBrowserPresentation()).toBeNull()
    vi.stubGlobal('codingDesktop', { browser: { available: false, present: vi.fn() } })
    expect(desktopBrowserPresentation()).toBeNull()
    vi.stubGlobal('codingDesktop', { browser: { available: true } })
    expect(desktopBrowserPresentation()).toBeNull()
    const present = vi.fn()
    vi.stubGlobal('codingDesktop', { browser: { available: true, present } })
    expect(desktopBrowserPresentation()).toMatchObject({ present })
  })

  it('polls validated state and accepts commands without acquiring frames in native mode', async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/frame?')) throw new Error('native guest must not fetch frames')
      return json(state())
    })
    const control = vi.fn(async () => ({ result: { ok: true, value: state(2) } }))
    const controller = new BrowserMirrorController('session-a', fetcher, control as never, true)
    const stop = controller.start()
    await flush()
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', frameUrl: null })
    expect(await controller.command({ kind: 'reload' })).toBe(true)
    expect(controller.view.getSnapshot()).toMatchObject({ state: { stateRevision: 2 }, frameUrl: null })
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('/state?'))).toBe(true)
    expect(createUrl).not.toHaveBeenCalled()
    stop()
  })
  it('tracks revision and precisely keys frame by session, tab, and both generations', async () => {
    let hits = 0
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame() : json(state(++hits)))
    const controller = new BrowserMirrorController('session-a', fetcher)
    const stop = controller.start()
    await flush()
    const image = String(fetcher.mock.calls.find(([url]) => String(url).includes('/frame?'))?.[0])
    expect(image).toContain('sessionId=session-a')
    expect(image).toContain(`tabId=${id}`)
    expect(image).toContain('browserGeneration=g1')
    expect(image).toContain('stateRevision=1')
    expect(image).toContain('generation=tab-g1')
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', frameUrl: 'blob:frame' })
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.stateRevision).toBe(2)
    stop()
    expect(revokeUrl).toHaveBeenCalledTimes(2)
  })

  it('keeps newer state against regressions and tab switches without leaking the old image', async () => {
    const sequence = [state(3), state(2), state(4, otherId), state(1, id, 'g2'), state(5)]
    let index = 0
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame()
      : json(sequence[Math.min(index++, sequence.length - 1)]))
    const controller = new BrowserMirrorController('session-a', fetcher)
    const stop = controller.start()
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
    const stop = controller.start()
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
    const stop = controller.start()
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
    const stop = controller.start()
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
    const stop = controller.start()
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
    const stop = controller.start()
    await flush()
    const pending = controller.command({ kind: 'new-tab' })
    expect(controller.view.getSnapshot().pending).toBe(true)
    stop()
    settle({ result: { ok: true, value: state() } })
    expect(await pending).toBe(false)
    expect(controller.view.getSnapshot().phase).toBe('loading')
  })

  it('publishes a lease even without a browser and restores the empty state when it ends', async () => {
    let locked = true
    const fetcher = vi.fn(async () => locked ? json({ operationActive: true }) : new Response(null, { status: 204 }))
    const control = vi.fn()
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start()
    await flush()
    expect(controller.view.getSnapshot().phase).toBe('busy')
    await controller.ensureTab()
    expect(control).not.toHaveBeenCalled()
    locked = false
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().phase).toBe('empty')
    stop()
  })

  it('publishes lease changes without a revision bump and refuses manual or stale-frame actions', async () => {
    let locked = false
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes('/frame?') ? frame()
      : json({ ...state(), operationActive: locked }))
    const control = vi.fn(async () => ({ result: { ok: true, value: state(2) } }))
    const controller = new BrowserMirrorController('session-a', fetcher, control as never)
    const stop = controller.start()
    await flush()
    locked = true
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.operationActive).toBe(true)
    expect(await controller.command({ kind: 'back' })).toBe(false)
    locked = false
    await vi.advanceTimersByTimeAsync(750)
    expect(controller.view.getSnapshot().state?.operationActive).toBe(false)
    const target = { browserGeneration: 'g1', stateRevision: 0, tabId: id as never,
      generation: 'tab-g1', revision: 1, viewport: { width: 1280, height: 720 } }
    expect(await controller.command({ kind: 'click', target, x: 1, y: 1 })).toBe(false)
    expect(control).not.toHaveBeenCalled()
    stop()
  })
})
