/** 手动 opt-in：以真实 Chromium 和环回页面验收隔离、元素交互与生命周期。 */

import { existsSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium } from 'playwright'
import type { BrowserContext } from 'playwright'
import { describe, expect, it } from 'vitest'
import PlaywrightBrowserUse from '../src/index.ts'
import { createBrowserProxy } from '../src/proxy.ts'

const page = `<!doctype html><title>Fixture</title>
  <input aria-label="Search"><button onclick="document.querySelector('output').textContent =
    document.querySelector('input').value">Go</button><output>Waiting</output>`
const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

async function fixture(onWait?: () => void): Promise<{
  ctx: Context
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer((req, res) => {
    if (req.url === '/wait') onWait?.()
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/popup-source') {
      res.end('<!doctype html><title>Popup source</title><button onclick="window.open(\'/popup\')">Open popup</button>')
      return
    }
    if (req.url === '/responsive') {
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Responsive</title><button style="position:absolute;left:300px;top:20px">Reach</button><output></output>
        <script>function update(){document.querySelector('output').textContent =
          innerWidth + 'x' + innerHeight + ' ' + (matchMedia('(max-width: 600px)').matches ? 'mobile' : 'desktop')}
          addEventListener('resize', update);update()</script>`)
      return
    }
    if (req.url === '/high-entropy') {
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>High entropy</title><style>body{margin:0}</style><canvas width="1200" height="1200"></canvas>
        <script>const ctx=document.querySelector('canvas').getContext('2d');
          const pixels=ctx.createImageData(1200,1200);let seed=123456789;
          for(let i=0;i<pixels.data.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
            pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;
            pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255}
          ctx.putImageData(pixels,0,0)</script>`)
      return
    }
    res.end(page)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ctx = new Context()
  const fiber = ctx.plugin(PlaywrightBrowserUse, { allowedOrigins: [origin] })
  try { await fiber.await() }
  catch (error) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    throw error
  }
  return {
    ctx, origin,
    close: async () => {
      await ctx.fiber.dispose()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    },
  }
}

function element(snapshot: string, role: string, name: string): string {
  const match = snapshot.match(new RegExp(`(e\\d+-[^ ]+) ${role} "${name}"`))
  if (!match?.[1]) throw new Error(`fixture ${role} "${name}" is absent from the browser snapshot`)
  return match[1]
}

function pngSize(png: Uint8Array | null): { width: number; height: number } {
  if (!png) throw new Error('browser PNG absent')
  const bytes = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: bytes.getUint32(16), height: bytes.getUint32(20) }
}

describe.skipIf(process.env.DSH_BROWSER_E2E !== '1' || !existsSync(chromium.executablePath()))(
  'real Chromium loopback fixture', () => {
    it('finds and clicks a visible button beyond 160 hidden and offscreen controls', { timeout: 40_000 }, async () => {
      const html = `<!doctype html><title>Long DOM</title>${'<button hidden>Hidden</button>'.repeat(160)}
        ${'<button style="position:absolute;left:-5000px">Offscreen</button>'.repeat(40)}
        <input type="password" aria-label="Account password" value="pre-filled-private-secret">
        <button onclick="document.querySelector('output').textContent='Clicked'">Reach me</button>
        <output>Waiting</output>`
      const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html) })
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const ctx = new Context()
      try {
        await ctx.plugin(PlaywrightBrowserUse, { allowedOrigins: [origin] }).await()
        const id = SessionId('long-dom')
        const signal = new AbortController().signal
        const initial = await ctx.browserUse.execute(id, { kind: 'navigate', url: origin }, signal)
        expect(initial.observation.snapshot).toContain('Account password')
        expect(initial.observation.snapshot).not.toContain('pre-filled-private-secret')
        const ref = element(initial.observation.snapshot, 'button', 'Reach me')
        const clicked = await ctx.browserUse.execute(id, { kind: 'click', ref,
          revision: initial.observation.revision }, signal)
        expect(clicked.observation.snapshot).toContain('Clicked')
      } finally {
        await ctx.fiber.dispose()
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('allows credentialed Chromium but denies an unauthenticated local proxy client', { timeout: 40_000 }, async () => {
      let hits = 0
      const target = createServer((_req, res) => { hits++; res.end(page) })
      await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve) })
      const origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
      const proxy = await createBrowserProxy(new Set([origin]))
      const browser = await chromium.launch({ headless: true })
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = request(proxy.server, { path: `${origin}/`, headers: { host: new URL(origin).host } },
            (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) }) })
          req.on('error', reject)
          req.end()
        })
        expect(status).toBe(407)
        expect(hits).toBe(0)
        const context = await browser.newContext({ proxy: { server: proxy.server,
          username: proxy.username, password: proxy.password, bypass: '<-loopback>' } })
        try {
          const browserPage = await context.newPage()
          await browserPage.goto(origin)
          expect(await browserPage.title()).toBe('Fixture')
          expect(hits).toBeGreaterThan(0)
        } finally { await context.close() }
      } finally {
        await browser.close()
        await proxy.close()
        await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
      }
    })

    it('rejects a redirect to an unlisted loopback origin before reaching it', { timeout: 40_000 }, async () => {
      let targetHits = 0
      const target = createServer((_req, res) => { targetHits++; res.end('private target') })
      await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve) })
      const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/private`
      const redirect = createServer((_req, res) => { res.writeHead(302, { location: targetUrl }); res.end() })
      await new Promise<void>((resolve) => { redirect.listen(0, '127.0.0.1', resolve) })
      const ctx = new Context()
      try {
        await ctx.plugin(PlaywrightBrowserUse, {
          allowedOrigins: [`http://127.0.0.1:${(redirect.address() as AddressInfo).port}`],
        }).await()
        await expect(ctx.browserUse.execute(SessionId('redirect'), { kind: 'navigate',
          url: `http://127.0.0.1:${(redirect.address() as AddressInfo).port}/` },
        new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_FAILED' })
        expect(targetHits).toBe(0)
      } finally {
        await ctx.fiber.dispose()
        await Promise.all([target, redirect].map(server => new Promise<void>((resolve) => {
          server.close(() => { resolve() })
        })))
      }
    })

    it('checks a rebound DNS answer at the proxy and never reaches the private target', { timeout: 40_000 }, async () => {
      let targetHits = 0
      const target = createServer((_req, res) => { targetHits++; res.end('private target') })
      await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve) })
      const port = (target.address() as AddressInfo).port
      let resolutions = 0
      const proxy = await createBrowserProxy(new Set(), async () => {
        resolutions++
        return [{ address: '127.0.0.1' }]
      })
      const browser = await chromium.launch({ headless: true })
      try {
        // 首次 DNS 答案模拟预检；浏览器真正请求时代理必须重新校验并拒绝私网答案。
        const { resolveRequestUrl } = await import('../src/policy.ts')
        await resolveRequestUrl(`http://rebind.example:${port}/`, new Set(), async () => {
          resolutions++
          return [{ address: '8.8.8.8' }]
        })
        const context = await browser.newContext({ proxy: { server: proxy.server,
          username: proxy.username, password: proxy.password, bypass: '<-loopback>' } })
        try {
          await expect(context.newPage().then(page => page.goto(`http://rebind.example:${port}/`, {
            waitUntil: 'domcontentloaded', timeout: 5000,
          }))).rejects.toThrow()
          expect(targetHits).toBe(0)
          expect(resolutions).toBeGreaterThan(1)
        } finally { await context.close() }
      } finally {
        await browser.close()
        await proxy.close()
        await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
      }
    })

    it('navigates, snapshots, fills and clicks refs, captures PNG, and closes', { timeout: 40_000 }, async () => {
      const { ctx, origin, close } = await fixture()
      const id = SessionId('fixture')
      const signal = new AbortController().signal
      try {
        const initial = await ctx.browserUse.execute(id, { kind: 'navigate', url: origin }, signal)
        expect(initial.observation).toMatchObject({ title: 'Fixture', url: `${origin}/`, revision: 1 })
        expect(initial.observation.snapshot).toContain('Waiting')
        expect(initial.png?.slice(0, 8)).toEqual(pngHeader)

        const snapshot = await ctx.browserUse.execute(id, { kind: 'snapshot' }, signal)
        expect(snapshot.observation.revision).toBe(2)
        expect(snapshot.observation.generation).toBe(initial.observation.generation)
        const input = element(snapshot.observation.snapshot, 'input', 'Search')
        const filled = await ctx.browserUse.execute(id, {
          kind: 'fill', ref: input, text: 'hello', revision: snapshot.observation.revision,
        }, signal)
        expect(filled.observation.cursor?.kind).toBe('fill')
        await expect(ctx.browserUse.execute(id, {
          kind: 'click', ref: input, revision: snapshot.observation.revision,
        }, signal)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
        const button = element(filled.observation.snapshot, 'button', 'Go')
        const clicked = await ctx.browserUse.execute(id, {
          kind: 'click', ref: button, revision: filled.observation.revision,
        }, signal)
        expect(clicked.observation.cursor?.kind).toBe('click')
        expect(clicked.observation.snapshot).toContain('hello')

        const screenshot = await ctx.browserUse.execute(id, { kind: 'screenshot' }, signal)
        expect(screenshot.observation.revision).toBe(clicked.observation.revision + 1)
        expect(screenshot.png?.slice(0, 8)).toEqual(pngHeader)
        expect(ctx.browserUse.latest(id)?.observation.revision).toBe(screenshot.observation.revision)
        await ctx.browserUse.execute(id, { kind: 'close' }, signal)
        expect(ctx.browserUse.latest(id)).toBeUndefined()
        await expect(ctx.browserUse.execute(id, { kind: 'snapshot' }, signal))
          .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
        const reopened = await ctx.browserUse.execute(id, { kind: 'navigate', url: origin }, signal)
        expect(reopened.observation.generation).not.toBe(initial.observation.generation)
        await ctx.browserUse.closeSession(id)
        expect(ctx.browserUse.latest(id)).toBeUndefined()
      } finally { await close() }
    })

    it('keeps tabs independent and navigates real browser history', { timeout: 40_000 }, async () => {
      const { ctx, origin, close } = await fixture()
      const id = SessionId('real-tabs')
      const signal = new AbortController().signal
      try {
        const first = await ctx.browserUse.control(id, { kind: 'ensure-tab' }, signal)
        expect(first).toMatchObject({ tabs: [{ url: 'about:blank' }], observation: null, hasFrame: false })
        const initialId = first?.activeTabId
        if (!initialId) throw new Error('first tab absent')
        const one = await ctx.browserUse.control(id, { kind: 'navigate', url: `${origin}/one` }, signal)
        expect(one?.tabs[0]).toMatchObject({ url: `${origin}/one`, canGoBack: false })
        expect(one?.tabs[0]?.generation).toBe(first?.tabs[0]?.generation)
        expect(one?.observation?.generation).toBe(first?.tabs[0]?.generation)
        const two = await ctx.browserUse.control(id, { kind: 'navigate', url: `${origin}/two` }, signal)
        expect(two?.tabs[0]).toMatchObject({ url: `${origin}/two`, canGoBack: true, canGoForward: false })
        const back = await ctx.browserUse.control(id, { kind: 'back' }, signal)
        expect(back?.tabs[0]).toMatchObject({ url: `${origin}/one`, canGoForward: true })
        const forward = await ctx.browserUse.control(id, { kind: 'forward' }, signal)
        expect(forward?.tabs[0]).toMatchObject({ url: `${origin}/two`, canGoBack: true })
        const reloaded = await ctx.browserUse.control(id, { kind: 'reload' }, signal)
        expect(reloaded?.observation?.revision).toBe((forward?.observation?.revision ?? 0) + 1)
        const oldRef = element(reloaded?.observation?.snapshot ?? '', 'input', 'Search')
        const blank = await ctx.browserUse.control(id, { kind: 'new-tab' }, signal)
        expect(blank?.tabs).toHaveLength(2)
        expect(blank?.observation).toBeNull()
        expect(blank?.activeTabId).not.toBe(initialId)
        const second = await ctx.browserUse.control(id, { kind: 'navigate', url: `${origin}/second` }, signal)
        expect(second?.observation?.tabId).toBe(blank?.activeTabId)
        await expect(ctx.browserUse.execute(id, { kind: 'fill', ref: oldRef, revision: reloaded?.observation?.revision ?? 0,
          text: 'cross tab' }, signal)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
        const selected = await ctx.browserUse.control(id, { kind: 'select-tab', tabId: initialId }, signal)
        expect(selected?.observation?.url).toBe(`${origin}/two`)
        const otherId = blank?.activeTabId
        if (!otherId) throw new Error('second tab absent')
        await ctx.browserUse.control(id, { kind: 'close-tab', tabId: otherId }, signal)
        expect(ctx.browserUse.state(id)?.tabs).toHaveLength(1)
        expect(await ctx.browserUse.control(id, { kind: 'close-tab', tabId: initialId }, signal)).toBeUndefined()
      } finally { await close() }
    })

    it('closes a popup opened while an internal tab is being created', { timeout: 40_000 }, async () => {
      const { ctx, origin, close } = await fixture()
      const id = SessionId('concurrent-popup')
      const signal = new AbortController().signal
      try {
        await ctx.browserUse.control(id, { kind: 'navigate', url: `${origin}/popup-source` }, signal)
        // 页面事件与内部 newPage 的确切句柄必须区分；测试在开页期间插入真实 window.open。
        const owners = Reflect.get(ctx.browserUse, 'pages') as Map<SessionId, { browserContext: BrowserContext }>
        const context = owners.get(id)?.browserContext
        if (!context) throw new Error('browser context absent')
        const source = context.pages()[0]
        if (!source) throw new Error('browser page absent')
        const originalNewPage = context.newPage.bind(context)
        let popup: Awaited<ReturnType<BrowserContext['newPage']>> | undefined
        context.newPage = async () => {
          const popupEvent = context.waitForEvent('page')
          await source.getByRole('button', { name: 'Open popup' }).click()
          popup = await popupEvent
          return originalNewPage()
        }
        const state = await ctx.browserUse.control(id, { kind: 'new-tab' }, signal)
        expect(state?.tabs).toHaveLength(2)
        expect(popup?.isClosed()).toBe(true)
        expect(context.pages()).toHaveLength(2)
        await ctx.browserUse.closeSession(id)
        expect(context.pages()).toHaveLength(0)
      } finally { await close() }
    })

    it('captures responsive mobile and tall desktop viewports without scaling the PNG', { timeout: 40_000 }, async () => {
      const { ctx, origin, close } = await fixture()
      const id = SessionId('responsive-viewport')
      const signal = new AbortController().signal
      try {
        await ctx.browserUse.control(id, { kind: 'ensure-tab' }, signal)
        const blank = await ctx.browserUse.control(id, { kind: 'set-viewport', width: 375, height: 850 }, signal)
        expect(blank).toMatchObject({ viewport: { width: 375, height: 850 }, observation: null })
        const mobile = await ctx.browserUse.execute(id, { kind: 'navigate', url: `${origin}/responsive` }, signal)
        expect(mobile.observation.snapshot).toContain('375x850 mobile')
        expect(mobile.observation.viewport).toEqual({ width: 375, height: 850 })
        expect(pngSize(mobile.png)).toEqual({ width: 375, height: 850 })
        const clicked = await ctx.browserUse.execute(id, { kind: 'click',
          ref: element(mobile.observation.snapshot, 'button', 'Reach'), revision: mobile.observation.revision }, signal)
        expect(clicked.observation.cursor?.x).toBeLessThan(375)
        expect(clicked.observation.cursor?.y).toBeLessThan(850)
        const mobileRef = element(clicked.observation.snapshot, 'button', 'Reach')
        const desktop = await ctx.browserUse.control(id, { kind: 'set-viewport', width: 900, height: 1100 }, signal)
        expect(desktop?.observation?.snapshot).toContain('900x1100 desktop')
        expect(desktop?.observation?.viewport).toEqual({ width: 900, height: 1100 })
        expect(pngSize(ctx.browserUse.latest(id)?.png ?? null)).toEqual({ width: 900, height: 1100 })
        await expect(ctx.browserUse.execute(id, { kind: 'click', ref: mobileRef,
          revision: clicked.observation.revision }, signal)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
      } finally { await close() }
    })

    it('retains real tabs after a high-entropy frame exceeds the PNG limit', { timeout: 40_000 }, async () => {
      const { ctx, origin, close } = await fixture()
      const id = SessionId('oversized-real-frame')
      const signal = new AbortController().signal
      try {
        await ctx.browserUse.control(id, { kind: 'ensure-tab' }, signal)
        await ctx.browserUse.control(id, { kind: 'set-viewport', width: 375, height: 800 }, signal)
        const initial = await ctx.browserUse.control(id, { kind: 'navigate', url: `${origin}/high-entropy` }, signal)
        expect(initial?.observation?.url).toBe(`${origin}/high-entropy`)
        await expect(ctx.browserUse.control(id, { kind: 'set-viewport', width: 900, height: 1100 }, signal))
          .rejects.toMatchObject({ code: 'BROWSER_FAILED', message: 'browser screenshot exceeds 2097152 bytes' })
        const oversized = ctx.browserUse.state(id)
        expect(oversized).toMatchObject({ tabs: [{ url: `${origin}/high-entropy` }],
          viewport: { width: 900, height: 1100 }, observation: null, hasFrame: false })
        expect(ctx.browserUse.latest(id)).toBeUndefined()
        const recovered = await ctx.browserUse.control(id, { kind: 'set-viewport', width: 300, height: 500 }, signal)
        expect(recovered?.observation).toMatchObject({ url: `${origin}/high-entropy`,
          viewport: { width: 300, height: 500 } })
        expect(pngSize(ctx.browserUse.latest(id)?.png ?? null)).toEqual({ width: 300, height: 500 })
      } finally { await close() }
    })

    it('isolates sessions and discards an aborted navigation', { timeout: 40_000 }, async () => {
      const controller = new AbortController()
      const reason = new Error('fixture navigation cancelled')
      const { ctx, origin, close } = await fixture(() => { controller.abort(reason) })
      const firstId = SessionId('first')
      const secondId = SessionId('second')
      const signal = new AbortController().signal
      try {
        const first = await ctx.browserUse.execute(firstId, { kind: 'navigate', url: origin }, signal)
        const second = await ctx.browserUse.execute(secondId, { kind: 'navigate', url: origin }, signal)
        expect(first.observation.generation).not.toBe(second.observation.generation)
        const ref = element(first.observation.snapshot, 'input', 'Search')
        const filled = await ctx.browserUse.execute(firstId, {
          kind: 'fill', ref, revision: first.observation.revision, text: 'only first',
        }, signal)
        expect(filled.observation.revision).toBe(2)
        const clicked = await ctx.browserUse.execute(firstId, {
          kind: 'click', ref: element(filled.observation.snapshot, 'button', 'Go'),
          revision: filled.observation.revision,
        }, signal)
        expect(clicked.observation.snapshot).toContain('only first')
        const untouched = await ctx.browserUse.execute(secondId, { kind: 'snapshot' }, signal)
        expect(untouched.observation.snapshot).not.toContain('only first')
        expect(ctx.browserUse.latest(firstId)?.observation.revision).toBe(clicked.observation.revision)

        await expect(ctx.browserUse.execute(firstId, { kind: 'navigate', url: `${origin}/wait` }, controller.signal))
          .rejects.toBe(reason)
        expect(ctx.browserUse.latest(firstId)).toBeUndefined()
        expect(ctx.browserUse.latest(secondId)?.observation.revision).toBe(untouched.observation.revision)
        await expect(ctx.browserUse.execute(firstId, { kind: 'snapshot' }, signal))
          .rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
        await ctx.browserUse.closeSession(secondId)
        expect(ctx.browserUse.latest(secondId)).toBeUndefined()
      } finally { await close() }
    })
  },
)
