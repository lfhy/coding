/** 经真实 Web Loader、人工 RPC 和 Host 浏览器提供方验收工作台浏览流程。 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Locator, Page, Request } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { BrowserHumanCommand, BrowserHumanTarget, BrowserSessionState } from '@deepseek-ai/dsh-browser'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const FIRST = 'browser-mirror-first'
const SECOND = 'browser-mirror-second'
const INTERACTIVE = 'browser-mirror-interactive'
const MODEL = 'browser-mirror-model-navigate'
const MODEL_PROMPT = 'Open the local fixture in the browser and report its title.'
const MODEL_CALL_ID = CallId('web-model-browser-navigate')
const MODE = webSnapshotMode()
const FILE_GOLDEN_DIR = join(REPO_ROOT, 'apps/web/tests/snapshots/workbench-file-navigation')

function modelNavigateReplay(url: string): ReplayOverrideDoc {
  const argumentsJson = JSON.stringify({ url })
  const toolCall: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: MODEL_CALL_ID, name: 'browser_navigate', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: MODEL_CALL_ID, name: 'browser_navigate', arguments: argumentsJson,
    } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const final: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Second fixture opened.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Second fixture opened.' } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [{ kind: 'chunks', chunks: toolCall }, { kind: 'chunks', chunks: final }]
}

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
    if (request.url === '/interactive') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Interactive fixture</title></head>
        <body style="margin:0;padding:24px;font:20px sans-serif;background:#d5e7fa">
          <h1>Interactive mirror</h1><p id="clicks">Clicks: 0</p>
          <button onclick="document.querySelector('#clicks').textContent='Clicks: '+(Number(document.querySelector('#clicks').textContent.split(': ')[1])+1)">Increment clicks</button>
          <label for="entry">Message</label><input id="entry" aria-label="Message" oninput="document.querySelector('#typed').textContent='Typed: '+this.value">
          <p id="typed">Typed: empty</p><p id="scrolled">Scrolled: no</p>
          <div style="height:1400px"></div><p>Bottom marker</p>
          <script>addEventListener('scroll', () => { if (scrollY > 200) document.querySelector('#scrolled').textContent='Scrolled: yes' })</script>
        </body></html>`)
      return
    }
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

function humanTarget(state: BrowserSessionState): BrowserHumanTarget {
  const observation = state.observation
  if (!observation || !state.activeTabId) throw new Error('current screenshot target missing')
  return { browserGeneration: state.browserGeneration, stateRevision: state.stateRevision,
    tabId: state.activeTabId, generation: observation.generation, revision: observation.revision,
    viewport: observation.viewport }
}

async function controlFromPage(page: Page, baseUrl: string, id: string, command: BrowserHumanCommand): Promise<{
  result: { ok: boolean; error?: { code: string; details?: { reason?: string } } }
}> {
  const response = await page.request.post(`${baseUrl}/api/browser.control`, {
    data: { type: 'client-request', rpcId: randomUUID(), method: 'browser.control',
      payload: { sessionId: id, command } },
    headers: { origin: baseUrl },
  })
  expect(response.status()).toBe(200)
  return await response.json() as { result: { ok: boolean; error?: { code: string; details?: { reason?: string } } } }
}

function observedPoint(state: BrowserSessionState, role: string, name: string): { x: number; y: number } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const row = state.observation?.snapshot.match(new RegExp(`e\\d+-\\S+ ${role} "${escaped}" \\((\\d+),(\\d+),(\\d+),(\\d+)\\)`))
  if (!row) throw new Error(`visible ${role} ${name} missing from browser observation`)
  return { x: Number(row[1]) + Math.floor(Number(row[3]) / 2),
    y: Number(row[2]) + Math.floor(Number(row[4]) / 2) }
}

async function gestureOnFrame(page: Page, mirror: Locator, state: BrowserSessionState,
  point: { x: number; y: number }, action: 'click' | 'scroll' | 'scroll-up'): Promise<void> {
  const frame = mirror.getByRole('img', { name: 'Browser page screenshot' })
  const box = await frame.boundingBox()
  if (!box) throw new Error('interactive screenshot geometry missing')
  const x = box.x + point.x / state.viewport.width * box.width
  const y = box.y + point.y / state.viewport.height * box.height
  if (action === 'click') await page.mouse.click(x, y)
  else { await page.mouse.move(x, y); await page.mouse.wheel(0, action === 'scroll-up' ? -650 : 650) }
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
    return pixels.ready && pixels.width === state.viewport.width * 2 && pixels.height === state.viewport.height * 2
      && state.observation.viewport.width === state.viewport.width
      && state.observation.viewport.height === state.viewport.height
  }, { timeout: 15_000 }).toBe(true)
  const state = await browserState(page, baseUrl, id)
  const canvasBox = await canvas.boundingBox()
  const imageBox = await image.boundingBox()
  if (!state?.observation || !canvasBox || !imageBox) throw new Error('browser viewport geometry missing')
  // 2x 截图占满 CSS 像素画布；不要按原始 PNG 像素放大或退回固定 1280×720。
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

async function expectNoLegacyFilesToggle(page: Page): Promise<void> {
  expect(await page.getByRole('button', {
    name: /^(?:(?:Show|Hide) files? sidebar|(?:显示|隐藏)文件侧栏)$/i,
    includeHidden: true,
  }).count()).toBe(0)
}

async function expectWorkbenchGeometry(page: Page, workbench: Locator, surfaces: Locator[]): Promise<void> {
  const container = await workbench.boundingBox()
  if (!container) throw new Error('visible workbench geometry missing')
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidth).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(container.x).toBeGreaterThanOrEqual(-1)
  expect(container.x + container.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  for (const surface of surfaces) {
    const box = await surface.boundingBox()
    if (!box) throw new Error('visible workbench surface geometry missing')
    expect(box.x).toBeGreaterThanOrEqual(container.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(container.x + container.width + 1)
  }
  const tabs = workbench.getByRole('tablist', { name: /^(?:Workbench tabs|工作台选项卡)$/ })
  const controls = workbench.getByRole('button', { name: /^(?:Close workbench|关闭工作台)$/ })
  const tabBox = await tabs.boundingBox()
  const controlBox = await controls.boundingBox()
  if (!tabBox || !controlBox) throw new Error('workbench toolbar geometry missing')
  expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(controlBox.x + 1)
}

describe('web e2e: browser-use mirror over the shipped Loader', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let target: Server
  let origin: string
  let replayDir: string | undefined
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const modelEvents: SessionEvent[] = []

  beforeAll(async () => {
    const serverFixture = await fixtureServer()
    target = serverFixture.server
    origin = serverFixture.origin
    if (MODE !== 'record') {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-web-browser-model-'))
      const replayOverride = join(replayDir, 'model-navigate.override.json')
      await writeFile(replayOverride, JSON.stringify(modelNavigateReplay(`${origin}/second`)))
      scaffold = await launchWebScaffold({
        replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride,
      })
    } else scaffold = await launchWebScaffold()
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id === SessionId(MODEL)) modelEvents.push(event)
    })
    await seedSession(scaffold, fixture(FIRST), FIRST)
    await seedSession(scaffold, fixture(SECOND), SECOND)
    await seedSession(scaffold, fixture(INTERACTIVE), INTERACTIVE)
    await seedSession(scaffold, fixture(MODEL), MODEL)
    await writeFile(join(scaffold.workspaceCwd, 'sidebar-preview.txt'), 'File preview remains available.\n')
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
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
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
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
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
    const tabs = page.getByRole('tablist', { name: 'Workbench tabs' })
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

    await tabs.getByRole('button', { name: 'Add workbench tab' }).click()
    await expect.poll(() => menu.isVisible()).toBe(true)
    await menu.getByRole('button', { name: 'Browser' }).click()
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
    const filesTab = tabs.getByRole('tab', { name: 'File manager' })
    await expect.poll(() => filesTab.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => backToFeatures.evaluate(node => document.activeElement === node)).toBe(true)
    await backToFeatures.click()
    await expect.poll(() => menu.isVisible()).toBe(true)
    await tabs.getByRole('tab', { name: 'Mirror fixture' }).click()
    await expect.poll(() => mirror.isVisible()).toBe(true)
    await expect.poll(() => mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(1)
    expect((await browserState(page, scaffold.baseUrl, FIRST))?.activeTabId).toBe(firstTab)
    await tabs.getByRole('button', { name: 'Close File manager' }).click()
    await expect.poll(() => filesTab.count()).toBe(0)
    await openSession(page, SECOND)
    expect(await mirror.isVisible()).toBe(false)
    expect(await browserState(page, scaffold.baseUrl, SECOND)).toBeNull()
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
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
    await expect.poll(() => tabs.evaluate(node => node.contains(document.activeElement))).toBe(true)
    await expect.poll(() => mirror.getByRole('img', { name: 'Browser page screenshot' }).count()).toBe(0)
    await expect.poll(() => mirror.getByRole('img', { name: 'Click' }).count()).toBe(0)
    const humanCommands = commands.filter(command => command.kind !== 'set-viewport')
    expect(humanCommands.slice(0, 12).map(command => command.kind)).toEqual([
      'new-tab', 'navigate', 'navigate', 'back', 'forward', 'back', 'reload',
      'new-tab', 'navigate', 'select-tab', 'select-tab', 'close-tab',
    ])
    expect(humanCommands.at(-1)?.kind).toBe('close-tab')
    expect(humanCommands.slice(12, -1).length).toBeGreaterThanOrEqual(1)
    expect(humanCommands.slice(12, -1).every(command => command.kind === 'ensure-tab' || command.kind === 'new-tab'))
      .toBe(true)
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

  it.skipIf(MODE === 'record')('acts on the real page through screenshot coordinates and rejects busy or stale gestures', async () => {
    onTestFailed(async () => { await page.screenshot({ path: '/tmp/dsh-browser-human-gestures-failed.png', fullPage: true }) })
    await openSession(page, INTERACTIVE)
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    await page.getByRole('navigation', { name: 'Workbench features' }).getByRole('button', { name: 'Browser' }).click()
    const mirror = page.getByRole('region', { name: 'Browser view' })
    const address = mirror.getByRole('textbox', { name: 'Address' })
    await address.fill(`${origin}/interactive`)
    await address.press('Enter')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.title)
      .toBe('Interactive fixture')
    const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
    const action = mirror.locator('button:has(> img[alt="Browser page screenshot"])')
    await expect.poll(() => action.isEnabled()).toBe(true)
    const initial = await expectViewportFit(page, mirror, scaffold.baseUrl, INTERACTIVE)
    const imageBox = await image.boundingBox()
    if (!imageBox) throw new Error('screenshot dimensions missing')
    const dimensions = await image.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, height: node.naturalHeight }))
    expect(dimensions).toEqual({ width: initial.viewport.width * 2, height: initial.viewport.height * 2 })
    expect(imageBox.width).toBeLessThanOrEqual(initial.viewport.width + 1)
    expect(imageBox.height).toBeLessThanOrEqual(initial.viewport.height + 1)
    expect(Math.abs(imageBox.width / imageBox.height - dimensions.width / dimensions.height)).toBeLessThan(0.01)
    await page.screenshot({ path: '/tmp/dsh-browser-human-before.png' })

    const oldTarget = humanTarget(initial)
    const buttonPoint = observedPoint(initial, 'button', 'Increment clicks')
    expect(buttonPoint.x).toBeLessThan(initial.viewport.width)
    expect(buttonPoint.y).toBeLessThan(initial.viewport.height)
    await gestureOnFrame(page, mirror, initial, buttonPoint, 'click')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.snapshot)
      .toContain('Clicks: 1')
    const clicked = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    if (!clicked) throw new Error('browser state missing after human click')
    expect(clicked.observation?.cursor?.kind).toBe('click')
    expect(clicked.observation?.cursor?.x).toBeCloseTo(buttonPoint.x, 0)
    expect(clicked.observation?.cursor?.y).toBeCloseTo(buttonPoint.y, 0)
    const stale = await controlFromPage(page, scaffold.baseUrl, INTERACTIVE, {
      kind: 'click', target: oldTarget, ...observedPoint(initial, 'button', 'Increment clicks'),
    })
    expect(stale.result).toMatchObject({ ok: false,
      error: { code: 'browser-failed', details: { reason: 'BROWSER_STALE_REF' } } })
    const afterStale = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    expect(afterStale?.stateRevision).toBe(clicked.stateRevision)
    expect(afterStale?.observation?.snapshot).toContain('Clicks: 1')

    await expect.poll(() => action.isEnabled()).toBe(true)
    const typeButton = mirror.locator('button[aria-pressed]')
    await typeButton.click()
    await expect.poll(() => typeButton.getAttribute('aria-pressed')).toBe('true')
    await gestureOnFrame(page, mirror, clicked, observedPoint(clicked, 'input', 'Message'), 'click')
    const typeInput = mirror.locator('#browser-page-text')
    await expect.poll(() => typeInput.isVisible()).toBe(true)
    await typeInput.fill('Human typed here')
    await typeInput.press('Enter')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.snapshot)
      .toContain('Typed: Human typed here')
    const typed = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    if (!typed) throw new Error('browser state missing after human type')
    expect(typed.observation?.cursor?.kind).toBe('fill')

    await expect.poll(() => action.isEnabled()).toBe(true)
    const mirrorScroll = await action.evaluate(node => ({
      top: node.parentElement?.parentElement?.scrollTop,
      left: node.parentElement?.parentElement?.scrollLeft,
    }))
    await gestureOnFrame(page, mirror, typed, { x: Math.floor(typed.viewport.width / 2),
      y: Math.floor(typed.viewport.height / 2) }, 'scroll')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.snapshot)
      .toContain('Scrolled: yes')
    const scrolled = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    if (!scrolled) throw new Error('browser state missing after human scroll')
    expect(scrolled.observation?.cursor?.kind).toBe('scroll')
    expect(await action.evaluate(node => ({
      top: node.parentElement?.parentElement?.scrollTop,
      left: node.parentElement?.parentElement?.scrollLeft,
    }))).toEqual(mirrorScroll)
    await page.screenshot({ path: '/tmp/dsh-browser-human-after.png' })

    const release = await scaffold.ctx.browserUse.acquireOperation(SessionId(INTERACTIVE), new AbortController().signal)
    try {
      await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.operationActive).toBe(true)
      await expect.poll(() => action.isDisabled(), { timeout: 10_000 }).toBe(true)
      await expect.poll(() => address.isDisabled()).toBe(true)
      await expect.poll(() => typeButton.isDisabled()).toBe(true)
      const busy = await controlFromPage(page, scaffold.baseUrl, INTERACTIVE, {
        kind: 'click', target: humanTarget(scrolled), ...observedPoint(initial, 'button', 'Increment clicks'),
      })
      expect(busy.result).toMatchObject({ ok: false, error: { code: 'browser-failed' } })
      expect((await browserState(page, scaffold.baseUrl, INTERACTIVE))?.stateRevision).toBe(scrolled.stateRevision)
    } finally { release() }
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.operationActive).toBe(false)
    await expect.poll(() => action.isEnabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => address.isEnabled()).toBe(true)
    await expect.poll(() => typeButton.isEnabled()).toBe(true)
    const released = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    if (!released) throw new Error('browser state missing after model operation release')
    await gestureOnFrame(page, mirror, released, { x: Math.floor(released.viewport.width / 2),
      y: Math.floor(released.viewport.height / 2) }, 'scroll-up')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.snapshot)
      .toContain('button "Increment clicks"')
    await expect.poll(() => action.isEnabled()).toBe(true)
    const returned = await browserState(page, scaffold.baseUrl, INTERACTIVE)
    if (!returned) throw new Error('browser state missing after returning to the page top')
    await gestureOnFrame(page, mirror, returned, observedPoint(returned, 'button', 'Increment clicks'), 'click')
    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, INTERACTIVE))?.observation?.snapshot)
      .toContain('Clicks: 2')
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('reveals the Web PNG mirror when a model-facing browser tool navigates from a closed workbench', async () => {
    onTestFailed(async () => { await page.screenshot({ path: '/tmp/dsh-browser-model-reveal-failed.png', fullPage: true }) })
    await openSession(page, MODEL)
    const closeSidebar = page.getByRole('button', { name: 'Close right sidebar' })
    if (await closeSidebar.isVisible()) await closeSidebar.click()
    await expect.poll(() => page.getByRole('button', { name: 'Open right sidebar' }).isVisible()).toBe(true)
    const mirror = page.getByRole('region', { name: 'Browser view' })
    const menu = page.getByRole('navigation', { name: 'Workbench features' })
    expect(await mirror.isVisible()).toBe(false)
    expect(await menu.isVisible()).toBe(false)
    expect(await browserState(page, scaffold.baseUrl, MODEL)).toBeNull()

    const approvals: string[] = []
    const disposeApproval = scaffold.ctx.on('approval/request', (request) => {
      approvals.push(request.toolName)
      return Promise.resolve('allowed-once' as const)
    }, { prepend: true })
    try {
      const composer = page.locator('textarea:enabled').first()
      await composer.fill(MODEL_PROMPT)
      const settled = scaffold.whenTurnSettled()
      await composer.press('Enter')
      expect(await settled).toBe(SessionId(MODEL))
      expect(approvals).toEqual(['browser_navigate'])
    } finally { disposeApproval() }

    const call = modelEvents.find(event => event.type === 'tool/call' && event.data.name === 'browser_navigate')
    expect(call?.type === 'tool/call' ? call.data.callId : undefined).toBe(MODEL_CALL_ID)
    const result = modelEvents.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === MODEL_CALL_ID)
    if (result?.type !== 'tool/result') throw new Error('model browser navigation produced no durable tool result')
    expect(result.data.message.content[0].isError).toBe(false)
    expect(result.data.message.content[0].content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain(`${origin}/second`)

    await expect.poll(async () => (await browserState(page, scaffold.baseUrl, MODEL))?.observation?.url)
      .toBe(`${origin}/second`)
    await expect.poll(() => mirror.isVisible(), { timeout: 15_000 }).toBe(true)
    await expect.poll(async () => (await page.locator('#dsh-layout-workbench').boundingBox())?.width ?? 0)
      .toBeGreaterThan(300)
    const tab = page.getByRole('tablist', { name: 'Workbench tabs' }).getByRole('tab', { name: 'Second fixture' })
    await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
    const state = await expectViewportFit(page, mirror, scaffold.baseUrl, MODEL)
    expect(state.activeTabId).toBeTruthy()
    expect(await tab.getAttribute('data-browser-tab-id')).toBe(state.activeTabId)
    const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
    expect(await image.getAttribute('src')).toMatch(/^blob:/)
    expect(await mirror.locator('iframe, webview').count()).toBe(0)
    await page.screenshot({ path: '/tmp/dsh-browser-model-revealed.png' })
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps file navigation without the legacy sidebar toggle across responsive workbench views', async () => {
    const filesPage = await newEnglishPage(browser)
    const health = watchConsole(filesPage)
    const errors: string[] = []
    filesPage.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    try {
      if (MODE === 'refresh') await mkdir(FILE_GOLDEN_DIR, { recursive: true })
      await filesPage.goto(scaffold.baseUrl, { waitUntil: 'load' })
      expect(new URL(filesPage.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
      expect(await filesPage.title()).toContain('Coding')
      await openSession(filesPage, FIRST)
      expect(await filesPage.locator('vite-error-overlay').count()).toBe(0)
      await expectNoLegacyFilesToggle(filesPage)
      await filesPage.getByRole('button', { name: 'Open right sidebar' }).click()
      const workbench = filesPage.getByRole('region', { name: /^(?:Workbench|工作台)$/ })
      const menu = filesPage.getByRole('navigation', { name: 'Workbench features' })
      const tabs = workbench.getByRole('tablist', { name: 'Workbench tabs' })
      const manager = tabs.getByRole('tab', { name: 'File manager' })
      const tree = workbench.locator('aside[aria-label="Workspace files"]')
      const preview = workbench.locator('article[aria-label="sidebar-preview.txt"]')
      await expect.poll(() => menu.isVisible()).toBe(true)
      await expectNoLegacyFilesToggle(filesPage)
      await menu.getByRole('button', { name: 'Files' }).click()
      await expect.poll(() => manager.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => tree.getByRole('button', { name: /sidebar-preview\.txt/ }).count()).toBe(1)
      const managerTabId = await manager.getAttribute('id')
      const managerPanelId = await manager.getAttribute('aria-controls')
      if (!managerTabId || !managerPanelId) throw new Error('file manager tab is missing its panel association')
      const managerPanel = filesPage.locator(`[id="${managerPanelId}"]`)
      await expectNoLegacyFilesToggle(filesPage)
      await tabs.getByRole('button', { name: 'Add workbench tab' }).click()
      await menu.getByRole('button', { name: 'Files' }).click()
      expect(await manager.count()).toBe(1)
      await tree.getByRole('button', { name: /sidebar-preview\.txt/ }).click()
      const fileTab = tabs.getByRole('tab', { name: 'sidebar-preview.txt' })
      await expect.poll(() => fileTab.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => preview.textContent()).toContain('File preview remains available.')
      await expectNoLegacyFilesToggle(filesPage)
      await manager.click()
      await expect.poll(() => manager.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => tree.isVisible()).toBe(true)
      await expectNoLegacyFilesToggle(filesPage)

      await workbench.getByRole('button', { name: 'Maximize workbench' }).click()
      await expect.poll(() => workbench.getAttribute('data-fullscreen')).toBe('true')
      await workbench.getByRole('button', { name: 'Show terminal panel' }).click()
      await expect.poll(() => workbench.getByRole('button', { name: 'Hide terminal panel' }).count()).toBe(1)
      await workbench.getByRole('button', { name: 'Hide terminal panel' }).click()
      for (const width of [1680, 1024, 768, 375]) {
        await filesPage.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
        await expect.poll(async () => {
          const box = await workbench.boundingBox()
          return box === null ? Infinity : box.x + box.width
        }).toBeLessThanOrEqual(width + 1)
        await expect.poll(async () => {
          const box = await workbench.boundingBox()
          return box !== null && (await workbench.getAttribute('data-narrow') === 'true') === (box.width <= 640)
        }).toBe(true)
        const narrow = await workbench.getAttribute('data-narrow') === 'true'
        await manager.click()
        await expect.poll(() => tree.isVisible()).toBe(true)
        await expect.poll(() => managerPanel.isVisible()).toBe(true)
        expect(await filesPage.locator('[id]').evaluateAll((nodes, id) =>
          nodes.filter(node => node.id === id).length, managerPanelId)).toBe(1)
        expect(await managerPanel.getAttribute('role')).toBe('tabpanel')
        expect(await managerPanel.getAttribute('aria-labelledby')).toBe(managerTabId)
        expect(await manager.getAttribute('aria-controls')).toBe(managerPanelId)
        // 窄容器让文件树本身承担管理器面板，宽容器仍由预览列占有该面板。
        expect(await managerPanel.locator('aside[aria-label="Workspace files"]').count()).toBe(narrow ? 1 : 0)
        await expectWorkbenchGeometry(filesPage, workbench, [tree])
        await filesPage.mouse.move(1, 1)
        if (width === 375) {
          await expect.poll(() => filesPage.getByRole('tooltip').count()).toBe(0)
          await compareOrRefreshGolden(join(FILE_GOLDEN_DIR, 'narrow-manager.ui.expected.md'),
            await captureStableAria(filesPage, '#dsh-layout-workbench', scaffold.workspaceCwd), MODE)
        }
        if (narrow) {
          const box = await tree.boundingBox()
          const container = await workbench.boundingBox()
          expect(box!.width).toBeGreaterThanOrEqual(container!.width - 2)
        }
        await fileTab.click()
        await expect.poll(() => preview.isVisible()).toBe(true)
        await expect.poll(() => tree.isVisible()).toBe(!narrow)
        await expect.poll(() => managerPanel.isVisible()).toBe(false)
        expect(await filesPage.locator('[id]').evaluateAll((nodes, id) =>
          nodes.filter(node => node.id === id).length, managerPanelId)).toBe(1)
        await expectWorkbenchGeometry(filesPage, workbench, narrow ? [preview] : [preview, tree])
        if (narrow) {
          const previewBox = await preview.boundingBox()
          const container = await workbench.boundingBox()
          expect(previewBox!.width).toBeGreaterThanOrEqual(container!.width - 2)
        } else {
          const previewBox = await preview.boundingBox()
          const treeBox = await tree.boundingBox()
          expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(treeBox!.x + 1)
        }
        await expectNoLegacyFilesToggle(filesPage)
        if (width === 1680 || width === 375) {
          await filesPage.mouse.move(1, 1)
          await expect.poll(() => filesPage.getByRole('tooltip').count()).toBe(0)
          await compareOrRefreshGolden(join(FILE_GOLDEN_DIR,
            width === 1680 ? 'desktop-preview.ui.expected.md' : 'narrow-preview.ui.expected.md'),
          await captureStableAria(filesPage, '#dsh-layout-workbench', scaffold.workspaceCwd), MODE)
        }
        await manager.click()
        await expect.poll(() => managerPanel.isVisible()).toBe(true)
        await expect.poll(() => tree.isVisible()).toBe(true)
      }
      await filesPage.setViewportSize({ width: 1680, height: 1000 })
      await workbench.getByRole('button', { name: 'Back to features' }).click()
      await expect.poll(() => menu.isVisible()).toBe(true)
      await expectNoLegacyFilesToggle(filesPage)
      await menu.getByRole('button', { name: 'Browser' }).click()
      await expect.poll(() => workbench.getByRole('region', { name: 'Browser view' }).isVisible()).toBe(true)
      await expectNoLegacyFilesToggle(filesPage)
      await workbench.getByRole('button', { name: 'Back to features' }).click()
      await menu.getByRole('button', { name: 'Terminal' }).click()
      await expect.poll(() => tabs.getByRole('tab', { name: 'coding 1' }).count()).toBe(1)
      await expectNoLegacyFilesToggle(filesPage)
      await manager.click()
      await expect.poll(() => tree.isVisible()).toBe(true)
      await scaffold.ctx.settings.update(settingsNamespace('locale'), { preference: 'zh' })
      await expect.poll(() => workbench.getAttribute('aria-label')).toBe('工作台')
      await expectNoLegacyFilesToggle(filesPage)
      await workbench.getByRole('button', { name: '返回功能菜单' }).click()
      await expectNoLegacyFilesToggle(filesPage)
      await workbench.getByRole('button', { name: '关闭工作台' }).click()
      await expect.poll(() => workbench.isVisible()).toBe(false)
      expect(health.pageErrors).toEqual([])
      expect(health.warnings).toEqual([])
      expect(errors).toEqual([])
      expect(await filesPage.locator('vite-error-overlay').count()).toBe(0)
    } catch (error) {
      await saveFailureShot(filesPage, 'workbench-file-navigation')
      throw error
    } finally {
      await scaffold.ctx.settings.update(settingsNamespace('locale'), { preference: 'en' })
      await filesPage.close()
    }
  }, 120_000)
})
