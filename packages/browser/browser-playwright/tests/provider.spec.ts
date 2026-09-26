import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
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
  evaluate: vi.fn(async () => 'Visible content'),
}
const page = {
  locator: vi.fn((selector: string) => selector === 'body' ? { evaluate: locator.evaluate } : locator),
  evaluateHandle: vi.fn(async (_evaluate: unknown, _options: {
    selector: string
    limit: number
    scanLimit: number
    viewport: { width: number; height: number }
  }) => ({
    getProperties: async () => new Map([['0', handle]]), dispose: async () => {},
  })),
  evaluate: vi.fn(async () => {}),
  goto: vi.fn(async () => null), screenshot: vi.fn(async () => png),
  goBack: vi.fn(async () => ({})), goForward: vi.fn(async () => ({})), reload: vi.fn(async () => ({})),
  setViewportSize: vi.fn(async (_size: { width: number; height: number }) => {}),
  bringToFront: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  title: vi.fn(async () => 'Title'), url: vi.fn(() => 'http://127.0.0.1:8080/'),
  on: vi.fn(), mouse: { wheel: vi.fn(async () => {}) },
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

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function request(routes: Map<string, RouteHandler>, path: string): Promise<{
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
  const fiber = ctx.plugin(PlaywrightBrowserUse, { allowedOrigins: ['http://127.0.0.1:8080'] })
  await fiber.await()
  return { ctx, service: ctx.browserUse as PlaywrightBrowserUse, routes }
}

async function headlessProvider(): Promise<{ ctx: Context; service: PlaywrightBrowserUse }> {
  const ctx = new Context()
  const fiber = ctx.plugin(PlaywrightBrowserUse, { allowedOrigins: ['http://127.0.0.1:8080'] })
  await fiber.await()
  return { ctx, service: ctx.browserUse as PlaywrightBrowserUse }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chromium).launch.mockResolvedValue(browser as unknown as Browser)
  page.screenshot.mockResolvedValue(png)
  page.goto.mockResolvedValue(null)
  page.url.mockImplementation(() => 'http://127.0.0.1:8080/')
  browserContext.newPage.mockImplementation(async () => page as unknown as Page)
})

describe('Playwright browser owner', () => {
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
    await expect(service.execute(id, { kind: 'navigate', url: 'http://127.0.0.1:8080/' }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(service.state(id)).toMatchObject({ tabs: [{ url: 'http://127.0.0.1:8080/' }],
      observation: null, hasFrame: false })
    expect(service.latest(id)).toBeUndefined()
    expect(browserContext.close).not.toHaveBeenCalled()
    expect((await service.execute(id, { kind: 'snapshot' }, signal)).observation.revision).toBe(1)
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

  it('intercepts redirects and subresources and rejects private destinations', async () => {
    const { ctx, service } = await provider()
    await service.execute(SessionId('route'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal)
    const networkHandler = browserContext.route.mock.calls[0]?.[1]
    expect(networkHandler).toBeDefined()
    if (!networkHandler) throw new Error('browser route handler was not registered')
    const allowed = { request: () => ({ url: () => 'http://127.0.0.1:8080/image.png' }),
      continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
    await networkHandler(allowed)
    expect(allowed.continue).toHaveBeenCalledOnce()
    const denied = { request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data/' }),
      continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
    await networkHandler(denied)
    expect(denied.abort).toHaveBeenCalledWith('blockedbyclient')
    expect(denied.continue).not.toHaveBeenCalled()
    expect(browserContext.routeWebSocket).toHaveBeenCalledOnce()
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
    expect(page.evaluateHandle.mock.calls.at(-1)?.[1]).toMatchObject({ viewport: { width: 375, height: 800 } })
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
    page.url.mockImplementationOnce(() => 'about:blank')
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
  })
})
