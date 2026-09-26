/** 经真实 Web Loader、Host 浏览器提供方和只读路由验收会话画面。 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-browser'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIRST = 'browser-mirror-first'
const SECOND = 'browser-mirror-second'
const MODE = webSnapshotMode()

function fixture(title: string): string {
  const session = Session.create(SessionId('browser-mirror-fixture'))
  session.append('turn/start', { turn: 1 })
  const prompt = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Inspect ${title}.` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [prompt.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `${title} ready.` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}' }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

async function fixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Mirror fixture</title></head><body
      style="background:#d5e7fa;font:32px sans-serif;padding:80px">
      <h1>Mirror before click</h1><button onclick="document.querySelector('h1').textContent='Mirror after click'">Advance mirror</button>
      </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

async function openSession(page: Page, id: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByPlaceholder('Search sessions', { exact: false })
  await search.fill(`Inspect ${id}`)
  const row = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1)
  await row.click()
  await page.getByText(`${id} ready.`, { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Clear search' }).click()
}

describe('web e2e: browser-use mirror over the shipped Loader', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let target: Server
  let origin: string
  let temp: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const serverFixture = await fixtureServer()
    target = serverFixture.server
    origin = serverFixture.origin
    temp = await mkdtemp(join(tmpdir(), 'dsh-browser-mirror-e2e-'))
    const overlay = join(temp, 'browser-overlay.yml')
    // 放行仅限本测试的环回页面；本地 origin 不进入产品配置。
    await writeFile(overlay, `- id: browser-playwright\n  config:\n    allowedOrigins: [${JSON.stringify(origin)}]\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await seedSession(scaffold, fixture(FIRST), FIRST)
    await seedSession(scaffold, fixture(SECOND), SECOND)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (target) await new Promise<void>((resolve, reject) => target.close((error) => { if (error) reject(error); else resolve() }))
    if (temp) await rm(temp, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('shows a real captured click and keeps the frame within its session', async () => {
    onTestFailed(async () => { await page.screenshot({ path: '/tmp/dsh-browser-mirror-failed.png', fullPage: true }) })
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toContain('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    await openSession(page, FIRST)

    const session = SessionId(FIRST)
    const mirror = page.getByRole('region', { name: 'Browser view' })
    // 初次轮询空态是自动切视图的基线；先确认挂载，再发送真实浏览器动作。
    await expect.poll(async () => (await page.request.get(`${scaffold.baseUrl}/browser-use/state?sessionId=${FIRST}`)).status()).toBe(204)
    const observedState = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/browser-use/state' && new URL(response.url()).searchParams.get('sessionId') === FIRST,
    )
    await observedState
    const abort = new AbortController()
    const navigated = await scaffold.ctx.browserUse.execute(session, { kind: 'navigate', url: origin }, abort.signal)
    expect(navigated.observation.revision).toBe(1)
    const element = navigated.observation.snapshot.match(/(e\d+) button "Advance mirror"/)
    expect(element, 'real browser observation must contain the fixture button').not.toBeNull()
    const clicked = await scaffold.ctx.browserUse.execute(session, {
      kind: 'click', ref: element![1]!, revision: navigated.observation.revision,
    }, abort.signal)
    expect(clicked.observation.snapshot).toContain('Mirror after click')
    await expect.poll(() => mirror.isVisible(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)
    await expect.poll(() => mirror.getByRole('img', { name: 'Click' }).count()).toBe(1)
    expect(await mirror.getByRole('status').innerText()).toBe('Click')
    const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
    expect(await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    expect(await image.getAttribute('src')).toMatch(/^blob:/)
    await expect.poll(() => mirror.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(300)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-click.png' })

    await mirror.getByRole('button', { name: 'Return to files' }).click()
    await expect.poll(() => mirror.isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)

    await page.setViewportSize({ width: 375, height: 812 })
    const close = mirror.getByRole('button', { name: 'Return to files' })
    const title = mirror.getByText('Mirror fixture', { exact: true })
    const pointer = mirror.getByRole('img', { name: 'Click' })
    await expect.poll(() => mirror.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(250)
    await expect.poll(async () => {
      const box = await close.boundingBox()
      return box === null ? Infinity : box.x + box.width
    }, { timeout: 5_000 }).toBeLessThanOrEqual(375)
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    }))
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1)
    const titleBox = await title.boundingBox()
    const closeBox = await close.boundingBox()
    const frameBox = await image.boundingBox()
    const pointerBox = await pointer.boundingBox()
    if (!titleBox || !closeBox || !frameBox || !pointerBox) throw new Error('mobile mirror geometry missing')
    expect(titleBox.x).toBeGreaterThanOrEqual(0)
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(closeBox.x + 1)
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(375)
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(812)
    expect(frameBox.x).toBeGreaterThanOrEqual(0)
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(375)
    expect(frameBox.y + frameBox.height).toBeLessThanOrEqual(812)
    expect(pointerBox.x + pointerBox.width / 2).toBeGreaterThanOrEqual(frameBox.x)
    expect(pointerBox.x + pointerBox.width / 2).toBeLessThanOrEqual(frameBox.x + frameBox.width)
    expect(pointerBox.y + pointerBox.height / 2).toBeGreaterThanOrEqual(frameBox.y)
    expect(pointerBox.y + pointerBox.height / 2).toBeLessThanOrEqual(frameBox.y + frameBox.height)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-mobile.png' })
    await close.focus()
    await close.press('Enter')
    const filesButton = page.getByRole('button', { name: 'Files', exact: true })
    await expect.poll(() => filesButton.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => filesButton.evaluate(node => document.activeElement === node)).toBe(true)
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)

    await openSession(page, SECOND)
    expect(await mirror.isVisible()).toBe(false)
    const second = await page.request.get(`${scaffold.baseUrl}/browser-use/state?sessionId=${SECOND}`)
    expect(second.status()).toBe(204)
    await page.getByRole('button', { name: 'Open file workbench' }).click()
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)
    await mirror.getByText('No browser is open for this session').waitFor({ timeout: 10_000 })
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    expect(await mirror.getByRole('img', { name: 'Click' }).count()).toBe(0)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-other-session.png' })
    await openSession(page, FIRST)
    await expect.poll(() => mirror.isVisible()).toBe(true)
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)
    await scaffold.ctx.browserUse.execute(session, { kind: 'close' }, abort.signal)
    await mirror.getByText('No browser is open for this session').waitFor({ timeout: 10_000 })
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    expect(await mirror.getByRole('img', { name: 'Click' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
