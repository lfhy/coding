/** 经真实 Web Loader、人工 RPC 和 Host 浏览器提供方验收工作台浏览流程。 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Locator, Page, Request } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { BrowserHumanCommand, BrowserSessionState } from '@deepseek-ai/dsh-browser'
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
  const server = createServer((request, response) => {
    const second = request.url === '/second'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>${second ? 'Second fixture' : 'Mirror fixture'}</title></head><body
      style="background:#d5e7fa;font:32px sans-serif;padding:80px">
      <h1>${second ? 'Second page' : 'Mirror before click'}</h1><button onclick="document.querySelector('h1').textContent='Mirror after click'">Advance mirror</button>
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

async function browserState(page: Page, baseUrl: string, id: string): Promise<BrowserSessionState | null> {
  const response = await page.request.get(`${baseUrl}/browser-use/state?sessionId=${id}`)
  if (response.status() === 204) return null
  expect(response.status()).toBe(200)
  return await response.json() as BrowserSessionState
}

function browserCommand(request: Request): BrowserHumanCommand | null {
  if (new URL(request.url()).pathname !== '/api/browser.control') return null
  const body = request.postDataJSON() as { payload?: { command?: BrowserHumanCommand } }
  return body.payload?.command ?? null
}

async function expectAddress(address: Locator, url: string): Promise<void> {
  // 非编辑态仅显示域名；聚焦后应暴露完整可编辑地址。
  await expect.poll(async () => {
    if (await address.isDisabled()) return ''
    await address.focus()
    return await address.inputValue()
  }).toBe(url)
}

async function expectCompactAddress(address: Locator, hostname: string): Promise<void> {
  await address.blur()
  await expect.poll(() => address.inputValue()).toBe(hostname)
  expect(await address.locator('..').getAttribute('data-compact')).toBe('true')
}

async function expectViewportFit(page: Page, mirror: Locator, baseUrl: string, id: string): Promise<BrowserSessionState> {
  const canvas = mirror.getByTestId('browser-canvas')
  const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
  await expect.poll(async () => {
    const state = await browserState(page, baseUrl, id)
    const box = await canvas.boundingBox()
    if (!state || !box) return Infinity
    return Math.max(Math.abs(state.viewport.width - box.width), Math.abs(state.viewport.height - box.height))
  }, { timeout: 15_000 }).toBeLessThanOrEqual(2)
  await expect.poll(async () => {
    const state = await browserState(page, baseUrl, id)
    if (!state?.observation || !state.hasFrame || await image.count() !== 1) return false
    const pixels = await image.evaluate((node: HTMLImageElement) => ({
      width: node.naturalWidth, height: node.naturalHeight, ready: node.complete,
    }))
    return pixels.ready && pixels.width === state.viewport.width && pixels.height === state.viewport.height
      && state.observation.viewport.width === pixels.width && state.observation.viewport.height === pixels.height
  }, { timeout: 15_000 }).toBe(true)
  const state = await browserState(page, baseUrl, id)
  const canvasBox = await canvas.boundingBox()
  const imageBox = await image.boundingBox()
  if (!state?.observation || !canvasBox || !imageBox) throw new Error('browser viewport geometry missing')
  // 截图占满实际内容画布；不要退回固定 1280×720 后在底下留下几百像素空白。
  expect(Math.abs(imageBox.x - canvasBox.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(imageBox.y - canvasBox.y)).toBeLessThanOrEqual(2)
  expect(Math.abs(imageBox.width - canvasBox.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(imageBox.height - canvasBox.height)).toBeLessThanOrEqual(2)
  return state
}

async function expectCursorAtObservedButton(mirror: Locator, state: BrowserSessionState): Promise<void> {
  const observation = state.observation
  const cursor = observation?.cursor
  if (!observation || !cursor || cursor.kind !== 'click') throw new Error('click cursor observation missing')
  const element = observation.snapshot.match(/e\d+-\S+ button "Advance mirror" \((\d+),(\d+),(\d+),(\d+)\)/)
  if (!element) throw new Error('visible fixture button geometry missing from observation')
  const [x, y, width, height] = element.slice(1).map(Number)
  expect(Math.abs(cursor.x - (x! + width! / 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(cursor.y - (y! + height! / 2))).toBeLessThanOrEqual(2)
  const frame = await mirror.getByRole('img', { name: 'Browser page screenshot' }).boundingBox()
  const pointer = await mirror.getByRole('img', { name: 'Click' }).boundingBox()
  if (!frame || !pointer) throw new Error('click pointer geometry missing')
  expect(Math.abs(pointer.x + pointer.width / 2 - (frame.x + cursor.x / observation.viewport.width * frame.width)))
    .toBeLessThanOrEqual(3)
  expect(Math.abs(pointer.y + pointer.height / 2 - (frame.y + cursor.y / observation.viewport.height * frame.height)))
    .toBeLessThanOrEqual(3)
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
  const consoleErrors: string[] = []

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
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (target) await new Promise<void>((resolve, reject) => target.close((error) => { if (error) reject(error); else resolve() }))
    if (temp) await rm(temp, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('opens the five-action menu, drives real browser tabs, then mirrors an Agent click per session', async () => {
    onTestFailed(async () => { await page.screenshot({ path: '/tmp/dsh-browser-mirror-failed.png', fullPage: true }) })
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toContain('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    await openSession(page, FIRST)
    const commands: BrowserHumanCommand[] = []
    page.on('request', (request) => {
      const command = browserCommand(request)
      if (command !== null) commands.push(command)
    })
    expect(await browserState(page, scaffold.baseUrl, FIRST)).toBeNull()
    await page.getByRole('button', { name: 'Show files sidebar' }).click()
    const menu = page.getByRole('navigation', { name: 'Workbench features' })
    await expect.poll(() => menu.isVisible()).toBe(true)
    await expect.poll(async () => (await page.locator('#dsh-layout-workbench').boundingBox())?.width ?? 0)
      .toBeGreaterThan(300)
    for (const label of ['Review', 'Terminal', 'Browser', 'Files', 'Side chat']) {
      await expect.poll(() => menu.getByRole('button', { name: new RegExp(label) }).count()).toBe(1)
    }
    expect(await menu.getByRole('button', { name: /Review/ }).isDisabled()).toBe(true)
    expect(await menu.getByRole('button', { name: /Side chat/ }).isDisabled()).toBe(true)
    await page.mouse.move(900, 300)
    await page.screenshot({ path: '/tmp/dsh-browser-menu-desktop.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: '/tmp/dsh-browser-menu-dark.png' })
    await menu.getByRole('button', { name: 'Browser' }).click()
    const mirror = page.getByRole('region', { name: 'Browser view' })
    const tabs = page.getByRole('tablist', { name: 'Browser tabs' })
    const address = mirror.getByRole('textbox', { name: 'Address' })
    await expect.poll(() => mirror.isVisible()).toBe(true)
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.tabs.length).toBe(1)
    const firstTab = (await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId
    expect(firstTab).toBeTruthy()
    expect(await address.inputValue()).toBe('')
    await mirror.getByText('Start browsing').waitFor()
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    await address.focus()
    await page.mouse.move(1300, 300)
    await page.screenshot({ path: '/tmp/dsh-browser-blank-tab.png' })
    await page.screenshot({ path: '/tmp/dsh-browser-blank-tab-dark.png' })

    await address.fill(origin)
    await address.press('Enter')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.observation?.url).toBe(`${origin}/`)
    await tabs.getByRole('tab', { name: 'Mirror fixture' }).waitFor()
    const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
    await expect.poll(() => image.count()).toBe(1)
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    expect(await image.getAttribute('src')).toMatch(/^blob:/)
    expect(await mirror.locator('iframe, webview').count()).toBe(0)
    await expectViewportFit(page, mirror, scaffold.baseUrl, FIRST)
    await expectCompactAddress(address, new URL(origin).hostname)
    await page.screenshot({ path: '/tmp/dsh-browser-navigated-desktop.png' })
    await page.screenshot({ path: '/tmp/dsh-browser-navigated-dark.png' })

    await address.fill(`${origin}/second`)
    await expect.poll(() => address.inputValue()).toBe(`${origin}/second`)
    await address.press('Enter')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.observation?.title).toBe('Second fixture')
    await mirror.getByRole('button', { name: 'Back' }).click()
    await expectAddress(address, `${origin}/`)
    await mirror.getByRole('button', { name: 'Forward' }).click()
    await expectAddress(address, `${origin}/second`)
    await mirror.getByRole('button', { name: 'Back' }).click()
    await expectAddress(address, `${origin}/`)
    const beforeReload = (await browserState(page, scaffold.baseUrl, FIRST))?.stateRevision
    if (beforeReload === undefined) throw new Error('browser state missing before reload')
    await mirror.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.stateRevision)
      .toBeGreaterThan(beforeReload)
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.observation?.snapshot.includes('Mirror before click')).toBe(true)

    await tabs.getByRole('button', { name: 'New tab' }).click()
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.tabs.length).toBe(2)
    const secondTab = (await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId
    expect(secondTab).toBeTruthy()
    expect(secondTab).not.toBe(firstTab)
    await mirror.getByText('Start browsing').waitFor()
    await expect.poll(() => tabs.getByRole('tab', { name: 'New tab' })
      .evaluate(node => document.activeElement === node)).toBe(true)
    expect(await image.count()).toBe(0)
    await address.fill(`${origin}/second`)
    await address.press('Enter')
    await expectAddress(address, `${origin}/second`)
    await tabs.getByRole('tab', { name: 'Mirror fixture' }).click()
    await expectAddress(address, `${origin}/`)
    await tabs.getByRole('tab', { name: 'Second fixture' }).click()
    await expectAddress(address, `${origin}/second`)
    const closeSecond = tabs.getByRole('button', { name: 'Close Second fixture' })
    await closeSecond.focus()
    await closeSecond.press('Enter')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.tabs.length).toBe(1)
    expect((await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId).toBe(firstTab)
    await expect.poll(() => tabs.getByRole('tab', { name: 'Mirror fixture' })
      .evaluate(node => document.activeElement === node)).toBe(true)
    await expectAddress(address, `${origin}/`)

    const session = SessionId(FIRST)
    const abort = new AbortController()
    const current = await scaffold.ctx.browserUse.execute(session, { kind: 'snapshot' }, abort.signal)
    const element = current.observation.snapshot.match(/(e\d+-\S+) button "Advance mirror"/)
    expect(element, 'real browser observation must contain the fixture button').not.toBeNull()
    const clicked = await scaffold.ctx.browserUse.execute(session, {
      kind: 'click', ref: element![1]!, revision: current.observation.revision,
    }, abort.signal)
    expect(clicked.observation.snapshot).toContain('Mirror after click')
    await expect.poll(() => image.count()).toBe(1)
    await expect.poll(() => mirror.getByRole('img', { name: 'Click' }).count()).toBe(1)
    expect(await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    const desktopState = await expectViewportFit(page, mirror, scaffold.baseUrl, FIRST)
    await expectCursorAtObservedButton(mirror, desktopState)
    await expectCompactAddress(address, new URL(origin).hostname)
    await expect.poll(() => mirror.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(300)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-click.png' })
    await page.setViewportSize({ width: 375, height: 812 })
    // ResizeObserver 与列宽过渡都在下一帧生效；几何断言需等真实窄屏工作台接管主列。
    await expect.poll(() => page.locator('[data-workbench-fullscreen]').count()).toBe(1)
    await expect.poll(async () => {
      const box = await mirror.boundingBox()
      return box === null ? Infinity : box.x + box.width
    }).toBeLessThanOrEqual(375)
    const resizedState = await expectViewportFit(page, mirror, scaffold.baseUrl, FIRST)
    expect(resizedState.viewport.width).toBeLessThan(375)
    const mobileSnapshot = await scaffold.ctx.browserUse.execute(session, { kind: 'snapshot' }, abort.signal)
    const mobileElement = mobileSnapshot.observation.snapshot.match(/(e\d+-\S+) button "Advance mirror"/)
    expect(mobileElement, 'narrow browser viewport must retain the visible fixture button').not.toBeNull()
    const mobileClick = await scaffold.ctx.browserUse.execute(session, {
      kind: 'click', ref: mobileElement![1]!, revision: mobileSnapshot.observation.revision,
    }, abort.signal)
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, FIRST))?.observation?.revision)
      .toBe(mobileClick.observation.revision)
    await expect.poll(() => mirror.getByRole('img', { name: 'Click' }).count()).toBe(1)
    const mobileState = await expectViewportFit(page, mirror, scaffold.baseUrl, FIRST)
    await expectCursorAtObservedButton(mirror, mobileState)
    const pointer = mirror.getByRole('img', { name: 'Click' })
    await expect.poll(() => mirror.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(250)
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    }))
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1)
    const addressBox = await address.boundingBox()
    const tabBox = await tabs.getByRole('tab', { name: 'Mirror fixture' }).boundingBox()
    const frameBox = await image.boundingBox()
    const pointerBox = await pointer.boundingBox()
    if (!addressBox || !tabBox || !frameBox || !pointerBox) throw new Error('mobile mirror geometry missing')
    expect(addressBox.x).toBeGreaterThanOrEqual(0)
    expect(addressBox.x + addressBox.width).toBeLessThanOrEqual(375)
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(375)
    expect(frameBox.x).toBeGreaterThanOrEqual(0)
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(375)
    expect(frameBox.y + frameBox.height).toBeLessThanOrEqual(812)
    expect(pointerBox.x + pointerBox.width / 2).toBeGreaterThanOrEqual(frameBox.x)
    expect(pointerBox.x + pointerBox.width / 2).toBeLessThanOrEqual(frameBox.x + frameBox.width)
    expect(pointerBox.y + pointerBox.height / 2).toBeGreaterThanOrEqual(frameBox.y)
    expect(pointerBox.y + pointerBox.height / 2).toBeLessThanOrEqual(frameBox.y + frameBox.height)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-mobile.png' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    const backToFeatures = page.getByRole('button', { name: 'Back to features' })
    await backToFeatures.focus()
    await backToFeatures.press('Enter')
    await expect.poll(() => menu.isVisible()).toBe(true)
    await expect.poll(() => menu.getByRole('button', { name: 'Terminal' })
      .evaluate(node => document.activeElement === node)).toBe(true)
    expect(await mirror.isVisible()).toBe(false)
    await page.screenshot({ path: '/tmp/dsh-browser-menu-return.png' })
    await menu.getByRole('button', { name: 'Files' }).click()
    await page.getByText('Open a file', { exact: true }).waitFor()
    await expect.poll(() => backToFeatures.evaluate(node => document.activeElement === node)).toBe(true)
    await backToFeatures.click()
    await expect.poll(() => menu.isVisible()).toBe(true)
    await menu.getByRole('button', { name: 'Browser' }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)
    await expect.poll(() => mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)
    expect((await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId).toBe(firstTab)
    await openSession(page, SECOND)
    expect(await mirror.isVisible()).toBe(false)
    expect(await browserState(page, scaffold.baseUrl, SECOND)).toBeNull()
    await page.getByRole('button', { name: 'Show files sidebar' }).click()
    await menu.getByRole('button', { name: 'Browser' }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)
    await mirror.getByText('Start browsing').waitFor({ timeout: 10_000 })
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, SECOND))?.tabs.length).toBe(1)
    expect((await browserState(page, scaffold.baseUrl, SECOND))?.activeTabId).not.toBe(firstTab)
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    expect(await mirror.getByRole('img', { name: 'Click' }).count()).toBe(0)
    await page.screenshot({ path: '/tmp/dsh-browser-mirror-other-session.png' })
    await openSession(page, FIRST)
    await expect.poll(() => mirror.isVisible()).toBe(true)
    expect(await mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)
    expect((await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId).toBe(firstTab)
    const closeLast = tabs.getByRole('button', { name: 'Close Mirror fixture' })
    await closeLast.focus()
    await closeLast.press('Enter')
    await expect.poll(async () => browserState(page, scaffold.baseUrl, FIRST)).toBeNull()
    await expect.poll(() => menu.isVisible()).toBe(true)
    await expect.poll(() => menu.getByRole('button', { name: 'Terminal' })
      .evaluate(node => document.activeElement === node)).toBe(true)
    await expect.poll(() => mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    await expect.poll(() => mirror.getByRole('img', { name: 'Click' }).count()).toBe(0)
    const humanCommands = commands.filter(command => command.kind !== 'set-viewport')
    expect(humanCommands.slice(0, 12).map(command => command.kind)).toEqual([
      'ensure-tab', 'navigate', 'navigate', 'back', 'forward', 'back', 'reload',
      'new-tab', 'navigate', 'select-tab', 'select-tab', 'close-tab',
    ])
    expect(humanCommands.at(-1)?.kind).toBe('close-tab')
    expect(humanCommands.slice(12, -1).length).toBeGreaterThanOrEqual(1)
    expect(humanCommands.slice(12, -1).every(command => command.kind === 'ensure-tab')).toBe(true)
    expect(commands.filter(command => command.kind === 'set-viewport').length).toBeGreaterThanOrEqual(2)
    expect(commands.filter(command => command.kind === 'navigate').map(command => command.url))
      .toEqual([`${origin}/`, `${origin}/second`, `${origin}/second`])
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toContain('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(consoleErrors).toEqual([])
  }, 120_000)
})
