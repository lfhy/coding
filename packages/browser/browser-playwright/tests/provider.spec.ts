import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { JSDOM } from 'jsdom'
import { BrowserUseError } from '@deepseek-ai/dsh-browser'
import type { BrowserCommand, BrowserHumanCommand, BrowserSessionState } from '@deepseek-ai/dsh-browser'
import PlaywrightBrowserUse, { trustedFrameRequest } from '../src/index.ts'

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }))

const png = new Uint8Array([137, 80, 78, 71])
const handle = {
  asElement: vi.fn(() => handle),
  evaluate: vi.fn(async () => ({ role: 'button', name: 'Open', x: 10, y: 20, width: 30, height: 40 })),
  boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 30, height: 40 })),
  click: vi.fn(async () => {}), fill: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
}
const locator = {
  count: vi.fn(async () => 1), nth: vi.fn(() => ({ elementHandle: async () => handle })),
  evaluate: vi.fn(async (_evaluate: (body: HTMLElement) => string) => 'Visible content'),
}
const documentHandle = {
  evaluate: vi.fn(async () => true), dispose: vi.fn(async () => {}),
}
const mainFrame = {}
const page = {
  locator: vi.fn((selector: string) => selector === 'body' ? { evaluate: locator.evaluate } : locator),
  evaluateHandle: vi.fn(async (_evaluate: unknown, _options?: {
    selector: string
    limit: number
    scanLimit: number
    viewport: { width: number; height: number }
  }) => _options === undefined ? documentHandle : {
    getProperties: async () => new Map([['0', handle]]), dispose: async () => {},
  }),
  evaluate: vi.fn(async (_evaluate: () => Promise<void>) => {}),
  goto: vi.fn(async () => null), screenshot: vi.fn(async () => png),
  goBack: vi.fn(async () => ({})), goForward: vi.fn(async () => ({})), reload: vi.fn(async () => ({})),
  setViewportSize: vi.fn(async (_size: { width: number; height: number }) => {}),
  bringToFront: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  title: vi.fn(async () => 'Title'), url: vi.fn(() => 'http://127.0.0.1:8080/'),
  mainFrame: vi.fn(() => mainFrame),
  on: vi.fn((_event: string, _listener: (dialog: { dismiss: () => Promise<void> }) => void) => {}),
  mouse: { wheel: vi.fn(async () => {}), click: vi.fn(async () => {}), move: vi.fn(async () => {}) },
  keyboard: { insertText: vi.fn(async () => {}) },
}
const browserContext = {
  route: vi.fn(async (_pattern: string, _handler: (route: {
    request: () => { url: () => string }
    continue: () => Promise<void>
    abort: (reason?: string) => Promise<void>
  }) => Promise<void>) => {}), routeWebSocket: vi.fn(async () => {}),
  newPage: vi.fn(async () => page as unknown as Page),
  on: vi.fn((_event: string, _handler: (opened: Page) => void) => {}), close: vi.fn(async () => {}),
}
const browser = {
  newContext: vi.fn(async () => browserContext as unknown as BrowserContext),
  close: vi.fn(async () => {}),
}

function ref(snapshot: string): string {
  const match = snapshot.match(/(e1-[^ ]+) button "Open"/)
  if (!match?.[1]) throw new Error('missing browser ref')
  return match[1]
}

function target(state: BrowserSessionState) {
  const observation = state.observation
  if (!observation) throw new Error('browser screenshot absent')
  return { browserGeneration: state.browserGeneration, stateRevision: state.stateRevision,
    tabId: observation.tabId, generation: observation.generation, revision: observation.revision,
    viewport: observation.viewport }
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function request(routes: Map<string, RouteHandler>, path: string,
  incomingOverrides: Partial<IncomingMessage> = {}): Promise<{
  status: number
  body: string | Uint8Array | undefined
}> {
  let status = 200
  let body: string | Uint8Array | undefined
  const response = {
    set statusCode(value: number) { status = value },
    setHeader: vi.fn(),
    end: (value?: string | Uint8Array) => { body = value },
  } as unknown as ServerResponse
  const url = new URL(path, 'http://127.0.0.1:3000')
  const incoming = {
    method: 'GET', url: path, headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
    ...incomingOverrides,
  } as unknown as IncomingMessage
  await routes.get(url.pathname)?.(incoming, response)
  return { status, body }
}

async function provider(): Promise<{
  ctx: Context
  service: PlaywrightBrowserUse
  routes: Map<string, RouteHandler>
}> {
  const ctx = new Context()
  const routes = new Map<string, RouteHandler>()
  ctx.provide('webServer', {
    host: '127.0.0.1', port: 3000,
    register(route: { path: string; handler: RouteHandler }) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  const fiber = ctx.plugin(PlaywrightBrowserUse)
  await fiber.await()
  return { ctx, service: ctx.browserUse as PlaywrightBrowserUse, routes }
}

async function headlessProvider(): Promise<{ ctx: Context; service: PlaywrightBrowserUse }> {
  const ctx = new Context()
  const fiber = ctx.plugin(PlaywrightBrowserUse)
  await fiber.await()
  return { ctx, service: ctx.browserUse as PlaywrightBrowserUse }
}

beforeEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  documentHandle.evaluate.mockResolvedValue(true)
  page.evaluateHandle.mockImplementation(async (_evaluate, options) => options === undefined ? documentHandle : {
    getProperties: async () => new Map([['0', handle]]), dispose: async () => {},
  })
  vi.mocked(chromium).launch.mockResolvedValue(browser as unknown as Browser)
  page.screenshot.mockResolvedValue(png)
  page.goto.mockResolvedValue(null)
  page.url.mockImplementation(() => 'http://127.0.0.1:8080/')
  browserContext.newPage.mockImplementation(async () => page as unknown as Page)
  browser.newContext.mockImplementation(async () => browserContext as unknown as BrowserContext)
})

describe('Playwright browser owner', () => {
  it('exercises page-side visibility, names, shadow roots and scan bounds', async () => {
    const dom = new JSDOM('<body></body>', { pretendToBeVisual: true })
    for (const key of ['document', 'NodeFilter', 'HTMLInputElement', 'getComputedStyle']) {
      vi.stubGlobal(key, Reflect.get(dom.window, key))
    }
    const doc = dom.window.document
    const add = (tag: string, attributes: Record<string, string> = {},
      rect = { x: 10, y: 20, width: 30, height: 40 }, text = ''): HTMLElement => {
      const element = doc.createElement(tag)
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
      Object.defineProperty(element, 'innerText', { value: text })
      element.getBoundingClientRect = () => ({ ...rect, top: rect.y, left: rect.x,
        right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) })
      doc.body.append(element)
      return element
    }
    add('button', { 'aria-label': 'label', role: 'button' })
    add('button', { placeholder: 'placeholder' })
    add('button', {}, undefined, 'text')
    add('input', { value: 'value' })
    add('button', { title: 'title' })
    add('button')
    add('input', { type: 'password', 'aria-label': 'secret label', value: 'hidden-secret' })
    add('input', { type: 'password', placeholder: 'secret placeholder', value: 'hidden-secret' })
    add('input', { type: 'password', value: 'hidden-secret' })
    add('button', {}, { x: 10, y: 20, width: 0, height: 40 })
    add('button', {}, { x: 10, y: 20, width: 30, height: 0 })
    add('button', { style: 'visibility:hidden' })
    add('button', { style: 'display:none' })
    add('button', {}, { x: -30, y: 20, width: 30, height: 40 })
    add('button', {}, { x: 10, y: -40, width: 30, height: 40 })
    add('button', {}, { x: 1280, y: 20, width: 30, height: 40 })
    add('button', {}, { x: 10, y: 720, width: 30, height: 40 })
    const shadow = add('div').attachShadow({ mode: 'open' })
    const nested = add('button', { 'aria-label': 'shadow' })
    shadow.append(nested)
    const hidden = add('button', { style: 'display:none' })
    const evaluateHandle = async (evaluate: unknown, options: Parameters<typeof page.evaluateHandle>[1]) => {
      if (options === undefined) return documentHandle
      const elements = (evaluate as (options: Parameters<typeof page.evaluateHandle>[1]) => Element[])(options)
      return { getProperties: async () => new Map(elements.map((element, index) => [String(index), {
        asElement: () => ({
          evaluate: async (evaluate: (element: Element) => unknown) => { evaluate(hidden); return evaluate(element) },
          dispose: async () => { throw new Error('detached during cleanup') },
        }), dispose: async () => {},
      }])), dispose: async () => {} }
    }
    page.evaluateHandle.mockImplementation(evaluateHandle as unknown as Parameters<typeof page.evaluateHandle.mockImplementation>[0])
    const { ctx, service } = await headlessProvider()
    const id = SessionId('dom')
    const signal = new AbortController().signal
    const capture = await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    expect(capture.observation.snapshot).toContain('secret label')
    expect(capture.observation.snapshot).toContain('secret placeholder')
    expect(capture.observation.snapshot).toContain('Password')
    expect(capture.observation.snapshot).toContain('shadow')
    expect(capture.observation.snapshot).not.toContain('hidden-secret')
    for (let index = 0; index < 160; index++) add('button', { 'aria-label': 'bound' })
    const bounded = await service.execute(id, { kind: 'snapshot' }, signal)
    expect(bounded.observation.snapshot.length).toBeLessThanOrEqual(12_000)
    doc.body.replaceChildren()
    doc.body.innerHTML = '<div></div>'.repeat(50_001)
    add('button', { 'aria-label': 'past scan boundary' })
    expect((await service.execute(id, { kind: 'snapshot' }, signal)).observation.snapshot).not.toContain('e1-')
    const bodyEvaluate = locator.evaluate.mock.calls.at(-1)?.[0]
    if (!bodyEvaluate) throw new Error('missing body evaluator')
    Object.defineProperty(doc.body, 'innerText', { value: 'Body content' })
    expect(bodyEvaluate(doc.body)).toBe('Body content')
    await ctx.fiber.dispose()
    dom.window.close()
    vi.unstubAllGlobals()
  })

  it('executes visibility filtering after handles are collected and cleans up failures', async () => {
    const { ctx, service } = await headlessProvider()
    const signal = new AbortController().signal
    const id = SessionId('handle-filter')
    const disposed = vi.fn(async () => {})
    const detachFailure = vi.fn(async () => { throw new Error('already detached') })
    const nonElement = { asElement: () => null, dispose: disposed }
    const candidate = (evaluate: () => Promise<Awaited<ReturnType<typeof handle.evaluate>> | null>) => {
      const result = { evaluate, dispose: detachFailure, asElement: () => result }
      return result
    }
    page.evaluateHandle.mockResolvedValueOnce(documentHandle)
    page.evaluateHandle.mockResolvedValueOnce(documentHandle)
    page.evaluateHandle.mockResolvedValueOnce({ getProperties: async () => new Map([
      ['non-element', nonElement], ['missing', candidate(async () => null)],
      ['left', candidate(async () => ({ role: 'button', name: 'offscreen', x: -31, y: 0, width: 30, height: 40 }))],
      ['top', candidate(async () => ({ role: 'button', name: 'offscreen', x: 0, y: -41, width: 30, height: 40 }))],
      ['right', candidate(async () => ({ role: 'button', name: 'offscreen', x: 1280, y: 0, width: 30, height: 40 }))],
      ['bottom', candidate(async () => ({ role: 'button', name: 'offscreen', x: 0, y: 720, width: 30, height: 40 }))],
      ['gone', candidate(async () => { throw new Error('detached') })],
    ] as never), dispose: async () => {} } as never)
    locator.evaluate.mockRejectedValueOnce(new Error('no body'))
    expect((await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)).observation.snapshot)
      .toBe('Page text:\n\nElements:\n')
    expect(disposed).toHaveBeenCalledOnce()
    expect(detachFailure).toHaveBeenCalledTimes(6)
    disposed.mockRejectedValueOnce(new Error('cleanup failed'))
    const broken = { ...handle, asElement: () => { throw new Error('handle failed') }, dispose: disposed }
    page.evaluateHandle.mockResolvedValueOnce(documentHandle)
    page.evaluateHandle.mockResolvedValueOnce({ getProperties: async () => new Map([['broken', broken]]), dispose: async () => {} } as never)
    await expect(service.execute(id, { kind: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(disposed).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('keeps exhaustive command dispatch and active-tab consistency checks', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('dispatch')
    const signal = new AbortController().signal
    await service.control(id, { kind: 'ensure-tab' }, signal)
    const owners = Reflect.get(service, 'pages') as Map<string, { activeTabId: string; tabs: Map<string, unknown> }>
    const owner = owners.get(id)
    if (!owner) throw new Error('missing owner')
    const tab = owner.tabs.get(owner.activeTabId)
    const perform = Reflect.get(service, 'perform') as (owner: unknown, tab: unknown, command: BrowserCommand) => Promise<unknown>
    await expect(perform.call(service, owner, tab, { kind: 'close' })).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    await expect(perform.call(service, owner, tab, { kind: 'invalid' } as unknown as BrowserCommand)).rejects.toThrow('unknown browser command')
    await expect(service.control(id, { kind: 'invalid' } as unknown as BrowserHumanCommand, signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    await service.control(id, { kind: 'ensure-tab' }, signal)
    const current = owners.get(id)
    if (!current) throw new Error('missing recreated owner')
    current.tabs.clear()
    expect(() => service.state(id)).toThrow(expect.objectContaining({ code: 'BROWSER_CLOSED' }))
    await ctx.fiber.dispose()
  })
  it('retries Chromium launch after installation failure', async () => {
    const { ctx, service } = await headlessProvider()
    vi.mocked(chromium).launch.mockRejectedValueOnce(new Error('missing executable'))
    const signal = new AbortController().signal
    await expect(service.control(SessionId('launch-retry'), { kind: 'ensure-tab' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    await service.control(SessionId('launch-retry'), { kind: 'ensure-tab' }, signal)
    expect(vi.mocked(chromium).launch.mock.calls).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('reclaims idle contexts but skips active operations', async () => {
    vi.useFakeTimers()
    const { ctx, service } = await headlessProvider()
    const id = SessionId('idle')
    const signal = new AbortController().signal
    await service.control(id, { kind: 'ensure-tab' }, signal)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(service.state(id)).toBeDefined()
    let release: (() => void) | undefined
    page.goto.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve }); return null })
    const pending = service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(service.state(id)).toBeDefined()
    release?.()
    await pending
    browserContext.close.mockRejectedValueOnce(new Error('already disconnected'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(service.state(id)).toBeUndefined()
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
    vi.useRealTimers()
  })

  it('contains cleanup failures for stale handles, oversized frames and rejected popup closure', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('contained-cleanup')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    handle.dispose.mockRejectedValueOnce(new Error('detached old ref'))
    await service.execute(id, { kind: 'snapshot' }, signal)
    handle.dispose.mockRejectedValueOnce(new Error('detached new ref'))
    page.screenshot.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
      .mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
    await expect(service.execute(id, { kind: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    const listener = browserContext.on.mock.calls.find(([event]) => event === 'page')?.[1]
    if (!listener) throw new Error('missing page listener')
    listener(page as unknown as Page)
    listener({ close: async () => { throw new Error('popup already closed') } } as unknown as Page)
    browserContext.newPage.mockImplementationOnce(async () => {
      listener({ close: async () => { throw new Error('pending popup closed') } } as unknown as Page)
      return { ...page, on: vi.fn() } as unknown as Page
    })
    await service.control(id, { kind: 'new-tab' }, signal)
    await ctx.fiber.dispose()
  })

  it('contains idle cleanup rejection and recovers from rejected queue predecessors', async () => {
    vi.useFakeTimers()
    const { ctx, service } = await headlessProvider()
    const id = SessionId('rejected-tail')
    const signal = new AbortController().signal
    const tails = Reflect.get(service, 'tails') as Map<string, Promise<void>>
    tails.set(id, Promise.reject(new Error('rejected previous operation')))
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    handle.dispose.mockImplementationOnce(() => { throw new Error('synchronous disposal failure') })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(service.state(id)).toBeUndefined()
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    tails.set(id, Promise.reject(new Error('rejected previous close')))
    handle.dispose.mockImplementationOnce(() => { throw new Error('closing disposal failure') })
    await expect(service.closeSession(id)).rejects.toThrow('closing disposal failure')
    await service.control(id, { kind: 'ensure-tab' }, signal)
    const firstClose = service.closeSession(id)
    const secondClose = service.closeSession(id)
    await Promise.all([firstClose, secondClose])
    await ctx.fiber.dispose()
    vi.useRealTimers()
  })

  it('waits for the page resize frame and falls back to the bounded timer', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('resize-callback')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1 })
    page.evaluate.mockImplementationOnce(async evaluate => evaluate())
    await service.control(id, { kind: 'set-viewport', width: 800, height: 900 }, signal)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    page.evaluate.mockImplementationOnce(async evaluate => evaluate())
    await service.control(id, { kind: 'set-viewport', width: 900, height: 900 }, signal)
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })

  it('discards contexts created after cancellation and rejects queued or disposed work', async () => {
    const { ctx, service } = await headlessProvider()
    const controller = new AbortController()
    const reason = new Error('cancel creation')
    browserContext.newPage.mockImplementationOnce(async () => { controller.abort(reason); return page as unknown as Page })
    await expect(service.control(SessionId('cancel-created'), { kind: 'ensure-tab' }, controller.signal)).rejects.toBe(reason)
    expect(browserContext.close).toHaveBeenCalledOnce()
    await expect(service.execute(SessionId('cancel-preflight'), { kind: 'navigate', url: 'http://localhost/' }, controller.signal))
      .rejects.toBe(reason)
    await ctx.fiber.dispose()
    await expect(service.execute(SessionId('disposed'), { kind: 'navigate', url: 'http://localhost/' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })

  it('handles close for absent, blank and observed sessions', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('close')
    const signal = new AbortController().signal
    expect((await service.execute(id, { kind: 'close' }, signal)).png).toBeNull()
    await service.control(id, { kind: 'ensure-tab' }, signal)
    expect((await service.execute(id, { kind: 'close' }, signal)).observation.snapshot).toBe('Browser session closed.')
    const capture = await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    expect(await service.execute(id, { kind: 'close' }, signal)).toEqual(capture)
    await service.closeSession(id)
    await ctx.fiber.dispose()
  })

  it('performs bounded scroll, fill, screenshots and history navigation', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('commands')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/one' }, signal)
    for (let index = 0; index < 5; index++) await service.control(id, { kind: 'back' }, signal)
    const current = service.latest(id)
    if (!current) throw new Error('missing current capture')
    await service.execute(id, { kind: 'fill', ref: ref(current.observation.snapshot), revision: current.observation.revision, text: 'hello' }, signal)
    expect(handle.fill).toHaveBeenCalledWith('hello', { timeout: 10_000 })
    await service.execute(id, { kind: 'scroll', direction: 'down', pixels: 1000 }, signal)
    await service.execute(id, { kind: 'scroll', direction: 'up', pixels: -10 }, signal)
    expect(page.mouse.wheel).toHaveBeenNthCalledWith(1, 0, 720)
    expect(page.mouse.wheel).toHaveBeenNthCalledWith(2, 0, -0)
    await service.execute(id, { kind: 'screenshot' }, signal)
    page.url.mockReturnValue('http://localhost/two')
    await service.control(id, { kind: 'navigate', url: 'http://localhost/two' }, signal)
    page.url.mockReturnValue('http://127.0.0.1:8080/')
    expect((await service.control(id, { kind: 'back' }, signal))?.tabs[0]?.canGoForward).toBe(true)
    page.url.mockReturnValue('http://localhost/two')
    expect((await service.control(id, { kind: 'forward' }, signal))?.tabs[0]?.canGoBack).toBe(true)
    page.goBack.mockResolvedValueOnce(null as never)
    page.goForward.mockResolvedValueOnce(null as never)
    await service.control(id, { kind: 'back' }, signal)
    await service.control(id, { kind: 'forward' }, signal)
    await service.control(id, { kind: 'forward' }, signal)
    page.url.mockReturnValue('http://127.0.0.1:8080/')
    await service.control(id, { kind: 'back' }, signal)
    await service.control(id, { kind: 'back' }, signal)
    await ctx.fiber.dispose()
  })

  it.each([null, { x: -40, y: 10, width: 30, height: 40 },
    { x: 10, y: -40, width: 30, height: 40 }, { x: 1280, y: 10, width: 30, height: 40 },
    { x: 10, y: 720, width: 30, height: 40 }])
  ('rejects a detached or outside-viewport element', async (box) => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('outside')
    const signal = new AbortController().signal
    const first = await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    handle.boundingBox.mockResolvedValueOnce(box as never)
    await expect(service.execute(id, { kind: 'click', ref: ref(first.observation.snapshot), revision: 1 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rejects absent tabs and closes the active tab while preserving another', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('active-close')
    const signal = new AbortController().signal
    const first = await service.control(id, { kind: 'new-tab' }, signal)
    if (!first) throw new Error('missing first tab')
    const second = await service.control(id, { kind: 'new-tab' }, signal)
    if (!second?.activeTabId) throw new Error('missing second tab')
    await expect(service.control(id, { kind: 'select-tab', tabId: 'absent' as never }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    await expect(service.control(id, { kind: 'close-tab', tabId: 'absent' as never }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    expect((await service.control(id, { kind: 'close-tab', tabId: second.activeTabId }, signal))?.activeTabId)
      .toBe(first.activeTabId)
    const dismiss = vi.fn(async () => {})
    for (const [, listener] of page.on.mock.calls) listener({ dismiss })
    expect(dismiss).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('observes browser-reported URLs without applying command-input URL restrictions', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('final-url')
    const signal = new AbortController().signal
    await service.control(id, { kind: 'ensure-tab' }, signal)
    page.url.mockReturnValue('about:blank')
    expect((await service.execute(id, { kind: 'snapshot' }, signal)).observation.url).toBe('about:blank')
    for (const url of ['file:///etc/passwd', 'https://user:password@localhost/', 'data:text/plain,hello']) {
      page.url.mockReturnValue(url)
      expect((await service.execute(id, { kind: 'snapshot' }, signal)).observation.url).toBe(url)
    }
    const redirected = `http://localhost/redirected?token=${'a'.repeat(4200)}`
    page.url.mockReturnValue(redirected)
    expect((await service.execute(id, { kind: 'navigate', url: 'http://localhost/start' }, signal)).observation.url)
      .toBe(redirected)
    expect((await service.control(id, { kind: 'navigate', url: 'http://localhost/start' }, signal))?.observation?.url)
      .toBe(redirected)
    expect(service.state(id)).toBeDefined()
    expect(browserContext.close).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
  it('provides browser use without a Web Host and conditionally mounts routes', async () => {
    const { ctx, service } = await headlessProvider()
    const capture = await service.execute(SessionId('headless'),
      { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, new AbortController().signal)
    expect(capture.observation.snapshot).toContain('Visible content')
    const routes = new Map<string, RouteHandler>()
    ctx.provide('webServer', {
      host: '127.0.0.1', port: 3000,
      register(route: { path: string; handler: RouteHandler }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    } as never)
    expect(routes.size).toBe(0)
    ctx.provide('connection', { requestRejection: () => undefined } as never)
    await vi.waitFor(() => { expect(routes.size).toBe(2) })
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('releases a page when the owning Session is disposed', async () => {
    const { ctx, service } = await headlessProvider()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(SessionId('session-lifecycle'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    await service.execute(session.id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal)
    expect(service.latest(session.id)).toBeDefined()
    detach()
    await vi.waitFor(() => { expect(browserContext.close).toHaveBeenCalledOnce() })
    expect(service.latest(session.id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('publishes a bounded screenshot and rejects stale refs before side effects', async () => {
    const { ctx, service } = await provider()
    const sessionId = SessionId('first')
    const signal = new AbortController().signal
    await expect(service.execute(sessionId, { kind: 'snapshot' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    const first = await service.execute(sessionId, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    expect(first.observation.snapshot).toMatch(/e1-[^ ]+ button "Open"/)
    expect(first.png).toEqual(png)
    await expect(service.execute(sessionId, { kind: 'click', ref: ref(first.observation.snapshot), revision: 0 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    const clicked = await service.execute(sessionId, { kind: 'click', ref: ref(first.observation.snapshot), revision: 1 }, signal)
    expect(clicked.observation.cursor).toMatchObject({ x: 25, y: 40, kind: 'click' })
    expect(handle.click).toHaveBeenCalledOnce()
    await service.closeSession(sessionId)
    expect(service.latest(sessionId)).toBeUndefined()
    await expect(service.execute(sessionId, { kind: 'snapshot' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    const reopened = await service.execute(sessionId, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    expect(reopened.observation.generation).not.toBe(first.observation.generation)
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('aborts its page and does not publish an in-flight observation', async () => {
    const { ctx, service } = await provider()
    const controller = new AbortController()
    const reason = new Error('stop')
    page.goto.mockImplementationOnce(async () => { controller.abort(reason); return null })
    await expect(service.execute(SessionId('aborted'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, controller.signal))
      .rejects.toBe(reason)
    expect(service.latest(SessionId('aborted'))).toBeUndefined()
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('retains the session but publishes no frame when a PNG exceeds its limit', async () => {
    const { ctx, service } = await provider()
    const id = SessionId('large')
    const signal = new AbortController().signal
    page.screenshot.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
      .mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
    await expect(service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(service.state(id)).toMatchObject({ tabs: [{ url: 'http://127.0.0.1:8080/' }],
      observation: null, hasFrame: false })
    expect(service.latest(id)).toBeUndefined()
    expect(browserContext.close).not.toHaveBeenCalled()
    expect((await service.execute(id, { kind: 'snapshot' }, signal)).observation.revision).toBe(1)
    await ctx.fiber.dispose()
  })

  it('tries device pixels first and falls back to CSS pixels only for an oversized frame', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('dense-frame-fallback')
    const signal = new AbortController().signal
    const cssPng = new Uint8Array([137, 80, 78, 71, 1])
    page.screenshot.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1)).mockResolvedValueOnce(cssPng)
    const capture = await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    expect(capture.png).toEqual(cssPng)
    expect(page.screenshot.mock.calls.slice(0, 2)).toEqual([
      [expect.objectContaining({ scale: 'device' })], [expect.objectContaining({ scale: 'css' })],
    ])
    expect(service.latest(id)).toBe(capture)
    await service.execute(id, { kind: 'screenshot' }, signal)
    expect(page.screenshot.mock.calls.at(-1)).toEqual([expect.objectContaining({ scale: 'device' })])
    await ctx.fiber.dispose()
  })

  it('keeps tabs after an oversized resize and recovers their captures when shrunk', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('oversized-resize')
    const signal = new AbortController().signal
    const first = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const secondScreenshot = vi.fn(async () => png)
    const secondPage = { ...page, screenshot: secondScreenshot,
      url: vi.fn(() => 'http://127.0.0.1:8080/second'), on: vi.fn() }
    browserContext.newPage.mockResolvedValueOnce(secondPage as unknown as Page)
    await service.control(id, { kind: 'new-tab' }, signal)
    const second = await service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)
    secondScreenshot.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
      .mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
    await expect(service.control(id, { kind: 'set-viewport', width: 900, height: 1100 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    const oversized = service.state(id)
    expect(oversized).toMatchObject({ viewport: { width: 900, height: 1100 },
      tabs: [{ id: first.observation.tabId }, { id: second?.activeTabId,
        url: 'http://127.0.0.1:8080/second' }], activeTabId: second?.activeTabId,
      observation: null, hasFrame: false })
    expect(oversized?.stateRevision).toBe((before?.stateRevision ?? 0) + 2)
    expect(service.latest(id)).toBeUndefined()
    expect(browserContext.close).not.toHaveBeenCalled()
    const oldFrame = `/browser-use/frame?sessionId=oversized-resize&tabId=${second?.activeTabId}&browserGeneration=${oversized?.browserGeneration}&stateRevision=${oversized?.stateRevision}&generation=${second?.observation?.generation}&revision=${second?.observation?.revision}`
    expect((await request(routes, oldFrame)).status).toBe(409)
    const recovered = await service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)
    expect(recovered?.observation).toMatchObject({ viewport: { width: 375, height: 800 },
      revision: (second?.observation?.revision ?? 0) + 1 })
    expect(recovered?.hasFrame).toBe(true)
    const firstAgain = await service.control(id, { kind: 'select-tab', tabId: first.observation.tabId }, signal)
    expect(firstAgain?.observation).toMatchObject({ tabId: first.observation.tabId,
      viewport: { width: 375, height: 800 }, revision: first.observation.revision + 1 })
    expect(browserContext.close).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('continues destroying the session for an uncertain screenshot failure', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('failed-capture')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    page.screenshot.mockRejectedValueOnce(new Error('capture failed'))
    await expect(service.execute(id, { kind: 'snapshot' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(service.state(id)).toBeUndefined()
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('bounds sessions, sanitizes visible text, and keeps a partially visible cursor in the viewport', async () => {
    const { ctx, service } = await headlessProvider()
    const signal = new AbortController().signal
    locator.evaluate.mockResolvedValueOnce(`visible\u0001${'a'.repeat(7000)}`)
    page.title.mockResolvedValueOnce('T'.repeat(5000))
    const first = await service.execute(SessionId('capacity-0'), { kind: 'navigate',
      url: 'http://127.0.0.1:8080/' }, signal)
    expect(first.observation.title).toHaveLength(4096)
    expect(first.observation.snapshot).not.toContain('\u0001')
    handle.boundingBox.mockResolvedValueOnce({ x: -20, y: -20, width: 30, height: 40 })
    const clicked = await service.execute(SessionId('capacity-0'), { kind: 'click',
      ref: ref(first.observation.snapshot), revision: 1 }, signal)
    expect(clicked.observation.cursor).toMatchObject({ x: 5, y: 10 })
    for (let index = 1; index < 8; index++) await service.execute(SessionId(`capacity-${index}`),
      { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    await expect(service.execute(SessionId('capacity-8'), { kind: 'navigate',
      url: 'http://127.0.0.1:8080/' }, signal)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    await ctx.fiber.dispose()
  })

  it('uses native browser networking without proxy, request routes or WebSocket interception', async () => {
    const { ctx, service } = await provider()
    await service.execute(SessionId('route'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal)
    expect(vi.mocked(chromium).launch.mock.calls).toEqual([[{ headless: true }]])
    expect(browser.newContext).toHaveBeenCalledExactlyOnceWith({
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, acceptDownloads: false, permissions: [],
    })
    expect(browserContext.route).not.toHaveBeenCalled()
    expect(browserContext.routeWebSocket).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it.each(['http://localhost/', 'http://10.0.0.1/', 'http://[::1]/',
    'http://2130706433/', 'https://example.com/', 'http://service.invalid/'])
  ('accepts model and human navigation to %s with a private final destination', async (url) => {
    const { ctx, service } = await headlessProvider()
    const signal = new AbortController().signal
    page.url.mockReturnValue('http://192.168.1.1/redirected')
    const capture = await service.execute(SessionId('model-network'), { kind: 'navigate', url }, signal)
    const state = await service.control(SessionId('human-network'), { kind: 'navigate', url }, signal)
    expect(capture.observation.url).toBe('http://192.168.1.1/redirected')
    expect(state?.observation?.url).toBe('http://192.168.1.1/redirected')
    expect(page.goto).toHaveBeenNthCalledWith(1, url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    expect(page.goto).toHaveBeenNthCalledWith(2, url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await ctx.fiber.dispose()
  })

  it.each([
    { url: 'not a URL', code: 'BROWSER_INVALID_URL' },
    { url: 'http:localhost', code: 'BROWSER_INVALID_URL' },
    { url: 'https://user:password@localhost/', code: 'BROWSER_DENIED' },
    { url: 'file:///etc/passwd', code: 'BROWSER_DENIED' },
    { url: `http://localhost/${'a'.repeat(4096)}`, code: 'BROWSER_FAILED' },
  ])('rejects invalid navigation before creating a context: $code', async ({ url, code }) => {
    const { ctx, service } = await headlessProvider()
    const signal = new AbortController().signal
    await expect(service.execute(SessionId('invalid-model'), { kind: 'navigate', url }, signal))
      .rejects.toMatchObject({ code })
    await expect(service.control(SessionId('invalid-human'), { kind: 'navigate', url }, signal))
      .rejects.toMatchObject({ code })
    expect(vi.mocked(chromium).launch.mock.calls).toHaveLength(0)
    expect(page.goto).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('closes a context when first-page creation fails and can create a fresh session', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('failed-first-page')
    const signal = new AbortController().signal
    browserContext.newPage.mockRejectedValueOnce(new Error('newPage failed'))
    await expect(service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(browserContext.close).toHaveBeenCalledOnce()
    expect(service.state(id)).toBeUndefined()
    await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    expect(browser.newContext).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('reports context creation failure without retaining a session', async () => {
    const { ctx, service } = await headlessProvider()
    browser.newContext.mockRejectedValueOnce(new Error('newContext failed'))
    await expect(service.control(SessionId('failed-context'), { kind: 'ensure-tab' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(service.state(SessionId('failed-context'))).toBeUndefined()
    expect(browserContext.close).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('registers only read routes and removes them with its fiber', async () => {
    const { ctx, routes } = await provider()
    expect([...routes.keys()]).toEqual(['/browser-use/state', '/browser-use/frame'])
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('creates blank tabs without navigation and serializes selection, stale targets and last-tab cleanup', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('tabs')
    const signal = new AbortController().signal
    expect(service.state(id)).toBeUndefined()
    const first = await service.control(id, { kind: 'ensure-tab' }, signal)
    expect(first).toMatchObject({ tabs: [{ url: 'about:blank' }],
      observation: null, hasFrame: false })
    expect(typeof first?.tabs[0]?.generation).toBe('string')
    expect(page.goto).not.toHaveBeenCalled()
    expect((await request(routes, '/browser-use/state?sessionId=tabs')).status).toBe(200)
    const firstTab = first?.activeTabId
    if (!firstTab) throw new Error('missing first tab')
    const firstCapture = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)
    expect(approved?.tabs[0]?.generation).toBe(firstCapture.observation.generation)
    const secondPage = { ...page, close: vi.fn(async () => {}), on: vi.fn(),
      goto: vi.fn(async () => null), url: vi.fn(() => 'http://127.0.0.1:8080/second'),
      title: vi.fn(async () => 'Second') }
    browserContext.newPage.mockResolvedValueOnce(secondPage as unknown as Page)
    const second = await service.control(id, { kind: 'new-tab' }, signal)
    expect(second?.tabs).toHaveLength(2)
    expect(typeof second?.tabs[1]?.generation).toBe('string')
    expect(second?.tabs[1]?.generation).not.toBe(firstCapture.observation.generation)
    expect(second?.observation).toBeNull()
    expect(secondPage.goto).not.toHaveBeenCalled()
    expect(second?.stateRevision).toBeGreaterThan(first?.stateRevision ?? 0)
    const secondTab = second?.activeTabId
    if (!secondTab) throw new Error('missing second tab')
    await expect(service.execute(id, { kind: 'click', ref: ref(firstCapture.observation.snapshot), revision: 1 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(service.execute(id, { kind: 'snapshot' }, signal,
      { kind: 'tab', browserGeneration: approved?.browserGeneration ?? '', stateRevision: approved?.stateRevision ?? -1,
        tabId: firstTab, generation: firstCapture.observation.generation }))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(service.state(id)?.tabs).toHaveLength(2)
    const selected = await service.control(id, { kind: 'select-tab', tabId: firstTab }, signal)
    expect(selected?.observation?.tabId).toBe(firstTab)
    const prior = `/browser-use/frame?sessionId=tabs&tabId=${firstTab}&browserGeneration=${first?.browserGeneration}&stateRevision=${firstCapture.observation.revision}&generation=${firstCapture.observation.generation}&revision=1`
    expect((await request(routes, prior)).status).toBe(409)
    await service.control(id, { kind: 'close-tab', tabId: secondTab }, signal)
    expect(secondPage.close).toHaveBeenCalledOnce()
    expect(service.state(id)?.tabs).toHaveLength(1)
    expect(await service.control(id, { kind: 'close-tab', tabId: firstTab }, signal)).toBeUndefined()
    expect(service.state(id)).toBeUndefined()
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('bounds tabs per session without affecting another session', async () => {
    const { ctx, service } = await headlessProvider()
    const signal = new AbortController().signal
    const first = SessionId('tab-limit')
    const other = SessionId('separate')
    await service.control(first, { kind: 'ensure-tab' }, signal)
    for (let index = 1; index < 8; index++) await service.control(first, { kind: 'new-tab' }, signal)
    expect(service.state(first)?.tabs).toHaveLength(8)
    await expect(service.control(first, { kind: 'new-tab' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(service.state(first)?.tabs).toHaveLength(8)
    expect((await service.control(other, { kind: 'ensure-tab' }, signal))?.tabs).toHaveLength(1)
    await service.closeSession(first)
    expect(service.state(other)?.tabs).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('resizes a blank tab without navigation and rejects out-of-bounds dimensions', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('blank-viewport')
    const signal = new AbortController().signal
    page.url.mockImplementation(() => 'about:blank')
    expect(await service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)).toBeUndefined()
    const initial = await service.control(id, { kind: 'ensure-tab' }, signal)
    expect(initial?.viewport).toEqual({ width: 1280, height: 720 })
    const resized = await service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)
    expect(resized).toMatchObject({ viewport: { width: 375, height: 800 }, observation: null, hasFrame: false })
    expect(resized?.stateRevision).toBe((initial?.stateRevision ?? -1) + 1)
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 375, height: 800 })
    expect(page.goto).not.toHaveBeenCalled()
    const same = await service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)
    expect(same?.stateRevision).toBe(resized?.stateRevision)
    expect(page.setViewportSize).toHaveBeenCalledOnce()
    for (const size of [{ width: 199, height: 800 }, { width: 1921, height: 800 },
      { width: 375, height: 239 }, { width: 375, height: 1401 },
      { width: 1920, height: 1400 }, { width: 375.5, height: 800 },
      { width: Number.NaN, height: 800 }]) {
      await expect(service.control(id, { kind: 'set-viewport', ...size }, signal))
        .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    }
    expect(service.state(id)?.viewport).toEqual({ width: 375, height: 800 })
    await ctx.fiber.dispose()
  })

  it('republishes a resized active tab, invalidates refs and stale approved targets', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('resized-active')
    const signal = new AbortController().signal
    const initial = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)
    if (!approved) throw new Error('state absent')
    const resized = await service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)
    expect(resized?.observation).toMatchObject({ viewport: { width: 375, height: 800 }, revision: 2 })
    expect(resized?.viewport).toEqual({ width: 375, height: 800 })
    expect(resized?.stateRevision).toBe(approved.stateRevision + 2)
    expect(service.latest(id)?.observation.viewport).toEqual({ width: 375, height: 800 })
    expect(page.evaluateHandle.mock.calls.findLast(([, options]) => options !== undefined)?.[1])
      .toMatchObject({ viewport: { width: 375, height: 800 } })
    await expect(service.execute(id, { kind: 'click', ref: ref(initial.observation.snapshot),
      revision: initial.observation.revision }, signal)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', browserGeneration: approved.browserGeneration, stateRevision: approved.stateRevision,
      tabId: initial.observation.tabId, generation: initial.observation.generation, url: initial.observation.url,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    const oldFrame = `/browser-use/frame?sessionId=resized-active&tabId=${initial.observation.tabId}&browserGeneration=${approved.browserGeneration}&stateRevision=${approved.stateRevision}&generation=${initial.observation.generation}&revision=${initial.observation.revision}`
    expect((await request(routes, oldFrame)).status).toBe(409)
    const currentFrame = `/browser-use/frame?sessionId=resized-active&tabId=${initial.observation.tabId}&browserGeneration=${approved.browserGeneration}&stateRevision=${resized?.stateRevision}&generation=${initial.observation.generation}&revision=${resized?.observation?.revision}`
    expect((await request(routes, currentFrame)).body).toEqual(png)
    await ctx.fiber.dispose()
  })

  it('discards a session when viewport resizing is cancelled', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('aborted-viewport')
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, new AbortController().signal)
    const controller = new AbortController()
    const reason = new Error('cancel viewport')
    page.setViewportSize.mockImplementationOnce(async () => { controller.abort(reason) })
    await expect(service.control(id, { kind: 'set-viewport', width: 375, height: 800 }, controller.signal))
      .rejects.toBe(reason)
    expect(service.state(id)).toBeUndefined()
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('resizes inactive pages and refreshes their captures when selected', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('resized-background')
    const signal = new AbortController().signal
    const first = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const secondPage = { ...page, setViewportSize: vi.fn(async (_size: { width: number; height: number }) => {}),
      url: vi.fn(() => 'http://127.0.0.1:8080/second'), on: vi.fn() }
    browserContext.newPage.mockResolvedValueOnce(secondPage as unknown as Page)
    await service.control(id, { kind: 'new-tab' }, signal)
    await service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    await service.control(id, { kind: 'set-viewport', width: 900, height: 1100 }, signal)
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 900, height: 1100 })
    expect(secondPage.setViewportSize).toHaveBeenCalledWith({ width: 900, height: 1100 })
    const selected = await service.control(id, { kind: 'select-tab', tabId: first.observation.tabId }, signal)
    expect(selected?.observation).toMatchObject({ tabId: first.observation.tabId,
      revision: first.observation.revision + 1, viewport: { width: 900, height: 1100 } })
    const newPageResize = vi.fn(async (_size: { width: number; height: number }) => {})
    browserContext.newPage.mockResolvedValueOnce({ ...page, on: vi.fn(),
      setViewportSize: newPageResize } as unknown as Page)
    await service.control(id, { kind: 'new-tab' }, signal)
    expect(browserContext.newPage).toHaveBeenCalledTimes(3)
    expect(newPageResize).toHaveBeenCalledWith({ width: 900, height: 1100 })
    expect(service.state(id)?.viewport).toEqual({ width: 900, height: 1100 })
    await ctx.fiber.dispose()
  })

  it('closes a popup emitted while creating an authorized new tab', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('popup-during-tab')
    const signal = new AbortController().signal
    const first = await service.control(id, { kind: 'ensure-tab' }, signal)
    const listener = browserContext.on.mock.calls.find(([event]) => event === 'page')?.[1]
    if (!listener) throw new Error('browser page listener absent')
    const popupClose = vi.fn(async () => {})
    const permittedClose = vi.fn(async () => {})
    const popup = { close: popupClose } as unknown as Page
    const permitted = { ...page, on: vi.fn(), close: permittedClose } as unknown as Page
    browserContext.newPage.mockImplementationOnce(async () => {
      listener(popup)
      listener(permitted)
      expect(popupClose).not.toHaveBeenCalled()
      return permitted
    })
    const state = await service.control(id, { kind: 'new-tab' }, signal)
    expect(state?.tabs).toHaveLength(2)
    expect(state?.activeTabId).not.toBe(first?.activeTabId)
    expect(popupClose).toHaveBeenCalledOnce()
    expect(permittedClose).not.toHaveBeenCalled()
    const lateClose = vi.fn(async () => {})
    const latePopup = { close: lateClose } as unknown as Page
    listener(latePopup)
    await vi.waitFor(() => { expect(lateClose).toHaveBeenCalledOnce() })
    expect(service.state(id)?.tabs).toHaveLength(2)
    await service.closeSession(id)
    expect(browserContext.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('closes pending popups and the context if internal tab creation fails', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('failed-tab')
    const signal = new AbortController().signal
    await service.control(id, { kind: 'ensure-tab' }, signal)
    const listener = browserContext.on.mock.calls.find(([event]) => event === 'page')?.[1]
    if (!listener) throw new Error('browser page listener absent')
    const popupClose = vi.fn(async () => {})
    const popup = { close: popupClose } as unknown as Page
    browserContext.newPage.mockImplementationOnce(async () => {
      listener(popup)
      throw new Error('newPage failed')
    })
    await expect(service.control(id, { kind: 'new-tab' }, signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(popupClose).toHaveBeenCalledOnce()
    expect(browserContext.close).toHaveBeenCalledOnce()
    expect(service.state(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects a page that changed URL after approval without using an old element', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('external-navigation')
    const signal = new AbortController().signal
    const capture = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)
    page.url.mockImplementation(() => 'http://127.0.0.1:8080/changed')
    await expect(service.execute(id, { kind: 'click', ref: ref(capture.observation.snapshot), revision: 1 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', tabId: capture.observation.tabId, generation: capture.observation.generation,
      browserGeneration: approved?.browserGeneration ?? '', stateRevision: approved?.stateRevision ?? -1,
      url: capture.observation.url,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    expect(service.latest(id)?.observation.url).toBe(capture.observation.url)
    await ctx.fiber.dispose()
  })

  it('refreshes a spontaneous cross-origin target before approval without capturing page content', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('spontaneous-cross-origin')
    const signal = new AbortController().signal
    const original = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const oldTarget = await service.prepareTarget(id, signal)
    const previous = service.state(id)!
    const nextUrl = 'https://example.org/landing'
    page.url.mockReturnValue(nextUrl)
    documentHandle.evaluate.mockResolvedValueOnce(false)
    const snapshots = page.screenshot.mock.calls.length
    const refreshed = await service.prepareTarget(id, signal)
    expect(refreshed).toMatchObject({ kind: 'tab', url: nextUrl,
      stateRevision: previous.stateRevision + 1, tabId: original.observation.tabId })
    expect(service.state(id)?.tabs[0]?.url).toBe(nextUrl)
    expect(service.state(id)?.hasFrame).toBe(false)
    expect(page.screenshot).toHaveBeenCalledTimes(snapshots)
    expect(locator.evaluate).toHaveBeenCalledTimes(1)
    await expect(service.execute(id, { kind: 'click', ref: ref(original.observation.snapshot), revision: 1 },
      signal, oldTarget)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    const captured = await service.execute(id, { kind: 'snapshot' }, signal, refreshed)
    expect(captured.observation.url).toBe(nextUrl)
    await ctx.fiber.dispose()
  })

  it('rebinds a same-URL reload before approval but rejects a subsequent navigation during approval', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('same-url-preparation')
    const signal = new AbortController().signal
    const original = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const previous = await service.prepareTarget(id, signal)
    const listener = page.on.mock.calls.find(([event]) => event === 'framenavigated')?.[1]
    if (!listener) throw new Error('main-frame navigation listener absent')
    listener(mainFrame as never)
    documentHandle.evaluate.mockResolvedValueOnce(false)
    const fresh = await service.prepareTarget(id, signal)
    expect(fresh).toMatchObject({ kind: 'tab', url: original.observation.url })
    if (fresh.kind !== 'tab' || previous.kind !== 'tab') throw new Error('tab target absent')
    expect(fresh.stateRevision).toBeGreaterThan(previous.stateRevision)
    expect(page.screenshot).toHaveBeenCalledTimes(1)
    const captured = await service.execute(id, { kind: 'snapshot' }, signal, fresh)
    expect(captured.observation.revision).toBe(2)
    const approved = await service.prepareTarget(id, signal)
    listener(mainFrame as never)
    await expect(service.execute(id, { kind: 'click', ref: ref(captured.observation.snapshot),
      revision: captured.observation.revision }, signal, approved))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    expect(page.screenshot).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('retries preparation when navigation advances stateRevision during a metadata await', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('navigation-during-preparation')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)!
    const listener = page.on.mock.calls.find(([event]) => event === 'framenavigated')?.[1]
    if (!listener) throw new Error('main-frame navigation listener absent')
    const racingDocument = { evaluate: vi.fn(async () => { listener(mainFrame as never); return true }),
      dispose: vi.fn(async () => {}) }
    page.evaluateHandle.mockResolvedValueOnce(racingDocument)
    const prepared = await service.prepareTarget(id, signal)
    expect(prepared).toMatchObject({ kind: 'tab', stateRevision: before.stateRevision + 1 })
    expect(racingDocument.dispose).toHaveBeenCalledOnce()
    expect(service.state(id)?.hasFrame).toBe(false)
    expect(page.screenshot).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('invalidates a same-URL document reload for both human screenshots and model approvals', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('same-url-document')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)!
    const listener = page.on.mock.calls.find(([event]) => event === 'framenavigated')?.[1]
    if (!listener) throw new Error('main-frame navigation listener absent')
    listener(mainFrame as never)
    expect(service.state(id)).toMatchObject({ stateRevision: approved.stateRevision + 1,
      observation: null, hasFrame: false })
    const state = await request(routes, '/browser-use/state?sessionId=same-url-document')
    expect(JSON.parse(state.body as string)).toMatchObject({ observation: null, hasFrame: false })
    await expect(service.control(id, { kind: 'click', target: target(approved), x: 10, y: 20 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', browserGeneration: approved.browserGeneration, stateRevision: approved.stateRevision,
      tabId: approved.activeTabId!, generation: approved.tabs[0]!.generation, url: approved.tabs[0]!.url,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(page.mouse.click).not.toHaveBeenCalled()
    expect(page.screenshot).toHaveBeenCalledTimes(1)
    const refreshed = await service.execute(id, { kind: 'snapshot' }, signal)
    expect(refreshed.observation.revision).toBeGreaterThan(approved.observation!.revision)
    expect(service.state(id)).toMatchObject({ hasFrame: true, observation: { revision: refreshed.observation.revision } })
    await ctx.fiber.dispose()
  })

  it('rejects changed Document identity even before the navigation event is delivered', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('document-before-event')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)!
    documentHandle.evaluate.mockResolvedValue(false)
    await expect(service.control(id, { kind: 'click', target: target(approved), x: 10, y: 20 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', browserGeneration: approved.browserGeneration, stateRevision: approved.stateRevision,
      tabId: approved.activeTabId!, generation: approved.tabs[0]!.generation, url: approved.tabs[0]!.url,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(page.mouse.click).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('disposes provisional element handles and old frames if Document changes during observation', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('document-changed-observation')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)!
    handle.dispose.mockClear()
    documentHandle.evaluate.mockResolvedValueOnce(false)
    await expect(service.execute(id, { kind: 'snapshot' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.dispose).toHaveBeenCalled()
    expect(service.state(id)).toMatchObject({ stateRevision: before.stateRevision + 1,
      observation: null, hasFrame: false })
    await ctx.fiber.dispose()
  })

  it('rejects a new Document arriving after element scan but before screenshot', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('navigate-during-scan')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)!
    const listener = page.on.mock.calls.find(([event]) => event === 'framenavigated')?.[1]
    if (!listener) throw new Error('main-frame navigation listener absent')
    handle.dispose.mockClear()
    locator.evaluate.mockImplementationOnce(async () => {
      listener(mainFrame as never)
      return 'Old document text'
    })
    await expect(service.execute(id, { kind: 'snapshot' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(page.screenshot).toHaveBeenCalledTimes(2)
    expect(handle.dispose).toHaveBeenCalled()
    expect(service.state(id)).toMatchObject({ stateRevision: before.stateRevision + 1,
      observation: null, hasFrame: false })
    expect(service.latest(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('holds model ownership through approval and releases it after rejection or cancellation', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('model-lease')
    const controller = new AbortController()
    const release = await service.acquireOperation(id, controller.signal)
    expect(service.operationActive(id)).toBe(true)
    expect(await request(routes, '/browser-use/state?sessionId=model-lease')).toEqual({
      status: 200, body: JSON.stringify({ operationActive: true }),
    })
    await expect(service.control(id, { kind: 'ensure-tab' }, controller.signal))
      .rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    await expect(service.acquireOperation(id, controller.signal)).rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    release()
    release()
    expect(service.operationActive(id)).toBe(false)
    expect((await request(routes, '/browser-use/state?sessionId=model-lease')).status).toBe(204)
    const next = await service.acquireOperation(id, controller.signal)
    next()
    controller.abort(new Error('cancelled'))
    await expect(service.acquireOperation(id, controller.signal)).rejects.toBe(controller.signal.reason)
    await ctx.fiber.dispose()
  })

  it('drains an already accepted human operation before sampling the model target', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('pending-human')
    const signal = new AbortController().signal
    let finish!: () => void
    page.goto.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(null) } }))
    const human = service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const lease = service.acquireOperation(id, signal)
    expect(service.operationActive(id)).toBe(true)
    await expect(service.control(id, { kind: 'new-tab' }, signal)).rejects.toMatchObject({ code: 'BROWSER_BUSY' })
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish()
    await human
    const release = await lease
    expect(service.state(id)?.observation?.revision).toBe(1)
    release()
    expect(service.state(id)?.operationActive).toBe(false)
    await ctx.fiber.dispose()
  })

  it('releases ownership promptly when cancelled during the pending-human drain', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('cancel-pending-human')
    let finish!: () => void
    page.goto.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(null) } }))
    const human = service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, new AbortController().signal)
    const controller = new AbortController()
    const lease = service.acquireOperation(id, controller.signal)
    expect(service.operationActive(id)).toBe(true)
    controller.abort(new Error('cancelled while waiting'))
    await expect(lease).rejects.toBe(controller.signal.reason)
    expect(service.operationActive(id)).toBe(false)
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish()
    await human
    await service.control(id, { kind: 'reload' }, new AbortController().signal)
    await ctx.fiber.dispose()
  })

  it('does not strand a lease if cancellation wins before the abort listener is installed', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('cancel-before-listener')
    let finish!: () => void
    page.goto.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(null) } }))
    const human = service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, new AbortController().signal)
    const controller = new AbortController()
    const reason = new Error('cancelled while installing listener')
    const addEventListener = controller.signal.addEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
      controller.abort(reason)
      addEventListener(...args)
    })
    const lease = service.acquireOperation(id, controller.signal)
    await expect(lease).rejects.toBe(reason)
    expect(service.operationActive(id)).toBe(false)
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish()
    await human
    await ctx.fiber.dispose()
  })

  it('rejects stale screenshot coordinates before touching the page and bounds the pointer', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('human-coordinates')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const state = service.state(id)!
    const expected = target(state)
    await expect(service.control(id, { kind: 'click', target: expected, x: 1280, y: 20 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(page.mouse.click).not.toHaveBeenCalled()
    const clicked = await service.control(id, { kind: 'click', target: expected, x: 10, y: 20 }, signal)
    expect(page.mouse.click).toHaveBeenCalledWith(10, 20)
    expect(clicked?.observation?.cursor).toMatchObject({ x: 10, y: 20, kind: 'click' })
    await expect(service.control(id, { kind: 'type', target: expected, x: 10, y: 20, text: 'secret' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(page.keyboard.insertText).not.toHaveBeenCalled()
    await service.control(id, { kind: 'type', target: target(clicked!), x: 10, y: 20, text: 'hello' }, signal)
    expect(page.keyboard.insertText).toHaveBeenCalledWith('hello')
    const afterType = service.state(id)!
    await service.control(id, { kind: 'scroll', target: target(afterType), x: 15, y: 25,
      direction: 'down', pixels: 120 }, signal)
    expect(page.mouse.move).toHaveBeenCalledWith(15, 25)
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 120)
    expect(service.state(id)?.stateRevision).toBeGreaterThan(afterType.stateRevision)
    await ctx.fiber.dispose()
  })

  it('runs human admission guards after earlier queued page work settles', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('queued-guard')
    let finish!: () => void
    page.goto.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(null) } }))
    const first = service.control(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, new AbortController().signal)
    const guard = vi.fn(async () => { throw new BrowserUseError('remote workspace', 'BROWSER_DENIED') })
    const next = service.control(id, { kind: 'ensure-tab' }, new AbortController().signal, guard)
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    expect(guard).not.toHaveBeenCalled()
    finish()
    await first
    await expect(next).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    expect(guard).toHaveBeenCalledOnce()
    expect(service.state(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('waits for the scroll render before publishing its observation', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('settle-human-scroll')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)!
    let settle!: () => void
    page.evaluate.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = () => { resolve() } }))
    locator.evaluate.mockResolvedValueOnce('Scrolled: yes')
    const scrolling = service.control(id, { kind: 'scroll', target: target(before), x: 15, y: 25,
      direction: 'down', pixels: 120 }, signal)
    await vi.waitFor(() => { expect(settle).toBeTypeOf('function') })
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 120)
    expect(page.screenshot).toHaveBeenCalledTimes(1)
    expect(service.state(id)?.stateRevision).toBe(before.stateRevision)
    settle()
    const after = await scrolling
    expect(after?.observation?.snapshot).toContain('Scrolled: yes')
    expect(page.screenshot).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('does not publish a new observation when the page closes during scroll settlement', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('closed-during-human-scroll')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const before = service.state(id)!
    page.evaluate.mockRejectedValueOnce(new Error('page closed'))
    await expect(service.control(id, { kind: 'scroll', target: target(before), x: 15, y: 25,
      direction: 'down', pixels: 120 }, signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(page.screenshot).toHaveBeenCalledTimes(1)
    expect(service.state(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('binds an absent-session approval to the execution queue', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('approval-race')
    const signal = new AbortController().signal
    const first = await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal,
      { kind: 'none' })
    expect(first.observation.tabId).toBe(service.state(id)?.activeTabId)
    await expect(service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal,
      { kind: 'none' })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    const other = SessionId('approval-interleaving')
    const human = service.control(other, { kind: 'ensure-tab' }, signal)
    const model = service.execute(other, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal,
      { kind: 'none' })
    await human
    await expect(model).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(service.state(other)?.tabs).toMatchObject([{ url: 'about:blank' }])
    expect(page.goto).toHaveBeenCalledTimes(1)
    const blank = service.state(other)?.tabs[0]
    const approved = service.state(other)
    if (!blank) throw new Error('missing blank tab')
    page.url.mockImplementationOnce(() => 'about:blank').mockImplementationOnce(() => 'about:blank')
    await service.execute(other, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal,
      { kind: 'tab', tabId: blank.id, generation: blank.generation, url: blank.url,
        browserGeneration: approved?.browserGeneration ?? '', stateRevision: approved?.stateRevision ?? -1 })
    expect(service.state(other)?.tabs[0]?.generation).toBe(blank.generation)
    await ctx.fiber.dispose()
  })

  it('invalidates approval after a same-URL reload', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('approval-reload')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)
    const tab = approved?.tabs[0]
    if (!approved || !tab) throw new Error('approved tab absent')
    await service.control(id, { kind: 'reload' }, signal)
    expect(service.state(id)?.tabs[0]).toMatchObject({ id: tab.id, generation: tab.generation, url: tab.url })
    expect(service.state(id)?.stateRevision).toBeGreaterThan(approved.stateRevision)
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', tabId: tab.id, generation: tab.generation, url: tab.url,
      browserGeneration: approved.browserGeneration, stateRevision: approved.stateRevision,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await ctx.fiber.dispose()
  })

  it('invalidates approval after leaving and reselecting the same tab', async () => {
    const { ctx, service } = await headlessProvider()
    const id = SessionId('approval-return')
    const signal = new AbortController().signal
    await service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal)
    const approved = service.state(id)
    const tab = approved?.tabs[0]
    if (!approved || !tab) throw new Error('approved tab absent')
    const reselected = await service.control(id, { kind: 'select-tab', tabId: tab.id }, signal)
    expect(reselected?.stateRevision).toBe(approved.stateRevision + 1)
    const second = await service.control(id, { kind: 'new-tab' }, signal)
    expect(second?.activeTabId).not.toBe(tab.id)
    await service.control(id, { kind: 'select-tab', tabId: tab.id }, signal)
    expect(service.state(id)?.tabs[0]).toMatchObject({ id: tab.id, generation: tab.generation, url: tab.url })
    await expect(service.execute(id, { kind: 'snapshot' }, signal, {
      kind: 'tab', tabId: tab.id, generation: tab.generation, url: tab.url,
      browserGeneration: approved.browserGeneration, stateRevision: approved.stateRevision,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await ctx.fiber.dispose()
  })

  it('serves only the current read-only state and matching PNG frame', async () => {
    const { ctx, service, routes } = await provider()
    expect((await request(routes, '/browser-use/state?sessionId=first')).status).toBe(204)
    const capture = await service.execute(SessionId('first'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal)
    const state = await request(routes, '/browser-use/state?sessionId=first')
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body as string)).toMatchObject({
      activeTabId: capture.observation.tabId, observation: { generation: capture.observation.generation, revision: 1 }, hasFrame: true,
    })
    const current = service.state(SessionId('first'))
    if (!current) throw new Error('missing state')
    const frame = `/browser-use/frame?sessionId=first&tabId=${capture.observation.tabId}&browserGeneration=${current.browserGeneration}&stateRevision=${current.stateRevision}&generation=${capture.observation.generation}&revision=1`
    expect((await request(routes, frame)).body).toEqual(png)
    expect((await request(routes, frame.replace('revision=1', 'revision=2'))).status).toBe(409)
    expect((await request(routes, '/browser-use/state?sessionId=first&surprise=true')).status).toBe(400)
    await ctx.fiber.dispose()
  })

  it('enforces preview authentication, methods, query shapes and exact frame identity', async () => {
    const { ctx, service, routes } = await provider()
    const id = SessionId('http-validation')
    const signal = new AbortController().signal
    const connection = Reflect.get(ctx, 'connection') as { requestRejection: (req: IncomingMessage) => 401 | 403 | undefined }
    const rejection = vi.spyOn(connection, 'requestRejection').mockReturnValue(401)
    expect((await request(routes, '/browser-use/state?sessionId=http-validation')).status).toBe(401)
    rejection.mockReturnValue(undefined)
    expect((await request(routes, '/browser-use/state?sessionId=http-validation', { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await request(routes, '/browser-use/state?sessionId=http-validation', { method: 'POST' })).status).toBe(405)
    expect((await request(routes, '/browser-use/state', { url: 'http://[' })).status).toBe(400)
    expect((await request(routes, '/browser-use/state', { url: undefined })).status).toBe(400)
    for (const suffix of ['', '?sessionId=', '?sessionId=bad%20id', `?sessionId=${'a'.repeat(257)}`,
      '?sessionId=http-validation&sessionId=http-validation']) {
      expect((await request(routes, `/browser-use/state${suffix}`)).status).toBe(400)
    }
    const base = '/browser-use/frame?sessionId=http-validation&tabId=tab&browserGeneration=browser&stateRevision=0&generation=page&revision=1'
    expect((await request(routes, base)).status).toBe(404)
    const capture = await service.execute(id, { kind: 'navigate', url: 'http://localhost/' }, signal)
    const state = service.state(id)
    if (!state) throw new Error('missing state')
    const valid = `/browser-use/frame?sessionId=http-validation&tabId=${capture.observation.tabId}&browserGeneration=${state.browserGeneration}&stateRevision=${state.stateRevision}&generation=${capture.observation.generation}&revision=${capture.observation.revision}`
    for (const [key, value] of [['revision', ''], ['revision', '0'], ['stateRevision', ''], ['stateRevision', '-1'],
      ['generation', ''], ['generation', 'bad!'], ['tabId', ''], ['tabId', 'bad!'],
      ['browserGeneration', ''], ['browserGeneration', 'bad!']]) {
      const url = new URL(valid, 'http://localhost')
      url.searchParams.set(key ?? '', value ?? '')
      expect((await request(routes, url.pathname + url.search)).status).toBe(400)
    }
    for (const [key, value] of [['browserGeneration', 'different'], ['stateRevision', '0'], ['tabId', 'different'],
      ['generation', 'different'], ['revision', '2']]) {
      const url = new URL(valid, 'http://localhost')
      url.searchParams.set(key ?? '', value ?? '')
      expect((await request(routes, url.pathname + url.search)).status).toBe(409)
    }
    const latest = vi.spyOn(service, 'latest')
    latest.mockReturnValueOnce(undefined)
    expect((await request(routes, valid)).status).toBe(409)
    latest.mockReturnValueOnce({ ...capture, png: null })
    expect((await request(routes, valid)).status).toBe(409)
    latest.mockRestore()
    await ctx.fiber.dispose()
  })
})

describe('frame route authority', () => {
  it('requires a loopback listener, peer, Host and matching Origin', () => {
    const request = (host: string, origin?: string, address = '127.0.0.1') => ({
      headers: { host, ...(origin ? { origin } : {}) }, socket: { remoteAddress: address },
    }) as never
    expect(trustedFrameRequest(request('127.0.0.1:3000', 'http://127.0.0.1:3000'), '127.0.0.1', 3000)).toBe(true)
    expect(trustedFrameRequest(request('evil.example:3000'), '127.0.0.1', 3000)).toBe(false)
    expect(trustedFrameRequest(request('127.0.0.1:3000', 'http://evil.example:3000'), '127.0.0.1', 3000)).toBe(false)
    expect(trustedFrameRequest(request('127.0.0.1:3000', undefined, '10.0.0.3'), '127.0.0.1', 3000)).toBe(false)
    expect(trustedFrameRequest(request('127.0.0.1:3000'), '0.0.0.0', 3000)).toBe(false)
    expect(trustedFrameRequest(request('localhost:3000', undefined, '::1'), '127.0.0.1', 3000)).toBe(true)
    expect(trustedFrameRequest(request('[::1]:3000', undefined, '::ffff:127.0.0.1'), '127.0.0.1', 3000)).toBe(true)
  })
})
