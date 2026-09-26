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
  evaluateHandle: vi.fn(async () => ({
    getProperties: async () => new Map([['0', handle]]), dispose: async () => {},
  })),
  goto: vi.fn(async () => null), screenshot: vi.fn(async () => png),
  title: vi.fn(async () => 'Title'), url: vi.fn(() => 'http://127.0.0.1:8080/'),
  on: vi.fn(), mouse: { wheel: vi.fn(async () => {}) },
}
const browserContext = {
  route: vi.fn(async (_pattern: string, _handler: (route: {
    request: () => { url: () => string }
    continue: () => Promise<void>
    abort: (reason?: string) => Promise<void>
  }) => Promise<void>) => {}), routeWebSocket: vi.fn(async () => {}),
  newPage: vi.fn(async () => page as unknown as Page), on: vi.fn(), close: vi.fn(async () => {}),
}
const browser = {
  newContext: vi.fn(async () => browserContext as unknown as BrowserContext),
  close: vi.fn(async () => {}),
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
    expect(first.observation.snapshot).toContain('e1 button "Open"')
    expect(first.png).toEqual(png)
    await expect(service.execute(sessionId, { kind: 'click', ref: 'e1', revision: 0 }, signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(handle.click).not.toHaveBeenCalled()
    const clicked = await service.execute(sessionId, { kind: 'click', ref: 'e1', revision: 1 }, signal)
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

  it('closes when an oversized PNG cannot be published', async () => {
    const { ctx, service } = await provider()
    page.screenshot.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024 + 1))
    await expect(service.execute(SessionId('large'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal))
      .rejects.toMatchObject({ code: 'BROWSER_FAILED' })
    expect(service.latest(SessionId('large'))).toBeUndefined()
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
      ref: 'e1', revision: 1 }, signal)
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

  it('serves only the current read-only state and matching PNG frame', async () => {
    const { ctx, service, routes } = await provider()
    expect((await request(routes, '/browser-use/state?sessionId=first')).status).toBe(204)
    const capture = await service.execute(SessionId('first'), { kind: 'navigate', url: 'http://127.0.0.1:8080/' },
      new AbortController().signal)
    const state = await request(routes, '/browser-use/state?sessionId=first')
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body as string)).toMatchObject({
      generation: capture.observation.generation, revision: 1, hasFrame: true,
    })
    const frame = `/browser-use/frame?sessionId=first&generation=${capture.observation.generation}&revision=1`
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
