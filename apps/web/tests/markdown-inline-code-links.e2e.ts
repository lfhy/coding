import { createServer, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { BrowserSessionState } from '@deepseek-ai/dsh-browser'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/markdown-inline-code-links', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/markdown-inline-code-links/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-inline-code-links-web-e2e'
const REFERENCE_ID = 'markdown-reference-links-web-e2e'
const RAPID_ID = 'markdown-rapid-links-web-e2e'
const DONE = 'INLINE_CODE_LINK_DONE'

/** 保留主会话的快照输入，并为引用式及并发点击准备独立会话。 */
function markdownFixture(linkUrl: string, reference = false,
  rapidUrls?: readonly [delayed: string, next: string, failure: string]): string {
  const session = Session.create(SessionId('markdown-inline-code-links-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the local preview URL.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: reference ? 'Reference preview links' : rapidUrls ? 'Rapid preview links' : 'Inline code links',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: reference ? [
          '## Reference preview links',
          '',
          'Reference: [Open reference][preview]',
          '',
          `[preview]: ${linkUrl}`,
          '',
          'Rejected: [Unsafe preview](javascript:alert(1))',
          '',
          'Relative: [Local preview](/preview)',
          '',
          DONE,
        ].join('\n') : rapidUrls ? [
          '## Rapid preview links',
          '',
          `[Open original](${linkUrl})`,
          `[Open delayed](${rapidUrls[0]})`,
          `[Open next](${rapidUrls[1]})`,
          `[Open again](${rapidUrls[1]})`,
          `[Open failure](${rapidUrls[2]})`,
          `[Open after failure](${rapidUrls[1]})`,
          '',
          DONE,
        ].join('\n') : [
          '## Inline code links',
          '',
          `Preview: \`${linkUrl}\``,
          '',
          `Standard: [Open preview](${linkUrl})`,
          '',
          `Command: \`curl ${linkUrl}\``,
          '',
          'Unsafe: `javascript:alert(1)`',
          '',
          DONE,
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.events.map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

/** 目标站点独立于 Host origin，避免把应用入口误当作浏览器 guest 页面。 */
async function fixtureServer(): Promise<{
  server: Server
  url: string
  origin: string
  waitForDelayed: () => Promise<void>
  releaseDelayed: () => void
  waitForFailure: () => Promise<void>
  releaseFailure: () => void
}> {
  let delayedResponse: ServerResponse | undefined
  let failureResponse: ServerResponse | undefined
  let notifyDelayed: (() => void) | undefined
  let notifyFailure: (() => void) | undefined
  // 两个待结算请求分别作为真实导航到达 Host 外目标的同步栅栏。
  const delayedArrival = new Promise<void>((resolve) => { notifyDelayed = resolve })
  const failureArrival = new Promise<void>((resolve) => { notifyFailure = resolve })
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/delayed')) {
      delayedResponse = response
      notifyDelayed?.()
      return
    }
    if (request.url?.startsWith('/failure')) {
      failureResponse = response
      notifyFailure?.()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Chat link preview</title></head>'
      + '<body style="background:#d5e7fa;font:32px sans-serif;padding:80px">'
      + '<h1>Assistant link target</h1></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    server,
    url: `${origin}/preview?demo=1`,
    origin,
    waitForDelayed: () => delayedArrival,
    releaseDelayed: () => {
      if (!delayedResponse) return
      delayedResponse.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      delayedResponse.end('<!doctype html><html><head><title>Chat link preview</title></head>'
        + '<body><h1>Assistant link target</h1></body></html>')
      delayedResponse = undefined
    },
    waitForFailure: () => failureArrival,
    releaseFailure: () => {
      failureResponse?.destroy()
      failureResponse = undefined
    },
  }
}

async function browserState(page: Page, baseUrl: string, id: string): Promise<BrowserSessionState | null> {
  const response = await page.request.get(`${baseUrl}/browser-use/state?sessionId=${id}`)
  if (response.status() === 204) return null
  expect(response.status()).toBe(200)
  return await response.json() as BrowserSessionState
}

async function openSession(page: Page, title: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByPlaceholder('Search sessions', { exact: false }).fill(title)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
  await result.click()
  await page.getByRole('button', { name: 'Clear search' }).click()
}

async function expectOpenTab(page: Page, baseUrl: string, id: string, url: string, count: number): Promise<string> {
  await expect.poll(async () => (await browserState(page, baseUrl, id))?.tabs.length, { timeout: 20_000 }).toBe(count)
  await expect.poll(async () => (await browserState(page, baseUrl, id))?.observation?.title,
    { timeout: 20_000 }).toBe('Chat link preview')
  const state = await browserState(page, baseUrl, id)
  if (!state?.activeTabId) throw new Error('clicked link did not select a Host browser tab')
  expect(state.tabs.find(tab => tab.id === state.activeTabId)?.url).toBe(url)
  const workbench = page.locator('#dsh-layout-workbench')
  const mirror = page.getByRole('region', { name: 'Browser view' })
  const tab = workbench.locator(`[role="tab"][data-browser-tab-id="${state.activeTabId}"]`)
  await expect.poll(() => workbench.isVisible()).toBe(true)
  await expect.poll(() => mirror.isVisible()).toBe(true)
  await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
  const image = mirror.getByRole('img', { name: 'Browser page screenshot' })
  await expect.poll(() => image.count()).toBe(1)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0))
    .toBe(true)
  expect(await image.getAttribute('src')).toMatch(/^blob:/)
  expect(await mirror.locator('iframe, webview').count()).toBe(0)
  return state.activeTabId
}

describe('web e2e: Markdown inline-code links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let linkUrl: string
  let target: Server
  let targetOrigin: string
  let waitForDelayed: () => Promise<void>
  let releaseDelayed: () => void
  let waitForFailure: () => Promise<void>
  let releaseFailure: () => void
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await fixtureServer()
    target = fixture.server
    linkUrl = fixture.url
    targetOrigin = fixture.origin
    waitForDelayed = fixture.waitForDelayed
    releaseDelayed = fixture.releaseDelayed
    waitForFailure = fixture.waitForFailure
    releaseFailure = fixture.releaseFailure
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, markdownFixture(linkUrl), SEED_ID)
    await seedSession(scaffold, markdownFixture(linkUrl, true), REFERENCE_ID)
    await seedSession(scaffold, markdownFixture(linkUrl, false,
      [`${targetOrigin}/delayed?demo=1`, `${targetOrigin}/next?demo=2`,
        `${targetOrigin}/failure?demo=3`]), RAPID_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    releaseDelayed?.()
    releaseFailure?.()
    await browser?.close()
    await scaffold?.close()
    if (target) await new Promise<void>((resolve, reject) => target.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })

  it.skipIf(MODE === 'record')('opens assistant links in new Session workbench tabs without navigating the shell', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-inline-code-links'))
    const popups: Page[] = []
    page.on('popup', (popup) => { popups.push(popup) })
    await openSession(page, 'Inline code links')
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    const inlineCodeLink = page.locator('[class*="markdown"] code a')
    await expect.poll(() => inlineCodeLink.count(), { timeout: 10_000 }).toBe(1)
    expect(await inlineCodeLink.getAttribute('href')).toBe(linkUrl)
    expect(await inlineCodeLink.getAttribute('target')).toBe('_blank')
    expect(await inlineCodeLink.getAttribute('rel')).toBe('noopener noreferrer')
    await inlineCodeLink.focus()
    expect(await inlineCodeLink.evaluate(element => document.activeElement === element)).toBe(true)

    expect(await browserState(page, scaffold.baseUrl, SEED_ID)).toBeNull()
    const shellUrl = page.url()
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
      .split(linkUrl).join('{{linkUrl}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await inlineCodeLink.click()
    const first = await expectOpenTab(page, scaffold.baseUrl, SEED_ID, linkUrl, 1)
    expect(page.url()).toBe(shellUrl)
    expect(popups).toEqual([])

    expect(await page.getByText(`curl ${linkUrl}`, { exact: true }).locator('a').count()).toBe(0)
    expect(await page.getByText('javascript:alert(1)', { exact: true }).locator('a').count()).toBe(0)
    const ordinary = page.getByRole('link', { name: 'Open preview' })
    await ordinary.click()
    const second = await expectOpenTab(page, scaffold.baseUrl, SEED_ID, linkUrl, 2)
    expect(second).not.toBe(first)
    expect(page.url()).toBe(shellUrl)
    expect(popups).toEqual([])

    await openSession(page, 'Reference preview links')
    await expect.poll(() => page.getByRole('link', { name: 'Open reference' }).count()).toBe(1)
    expect(await browserState(page, scaffold.baseUrl, REFERENCE_ID)).toBeNull()
    expect(await page.getByRole('link', { name: 'Unsafe preview' }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Local preview' }).count()).toBe(0)
    await page.getByRole('link', { name: 'Open reference' }).click()
    await expectOpenTab(page, scaffold.baseUrl, REFERENCE_ID, linkUrl, 1)
    expect(page.url()).toBe(shellUrl)
    expect(popups).toEqual([])
    const workbench = page.locator('#dsh-layout-workbench')
    const mirror = page.getByRole('region', { name: 'Browser view' })
    await expect.poll(async () => {
      const width = Number(await page.locator('[data-side="workbench"]').getAttribute('aria-valuenow'))
      const box = await workbench.boundingBox()
      return box === null || width < 900 ? Infinity : Math.abs(box.width - width)
    }, { timeout: 10_000 }).toBeLessThanOrEqual(2)
    await expect.poll(async () => {
      const state = await browserState(page, scaffold.baseUrl, REFERENCE_ID)
      const box = await mirror.getByTestId('browser-canvas').boundingBox()
      return state === null || box === null ? Infinity : Math.abs(state.viewport.width - box.width)
    }, { timeout: 15_000 }).toBeLessThanOrEqual(2)
    await expect.poll(() => mirror.getByRole('status').count(),
      { timeout: 15_000 }).toBe(0)
    await page.screenshot({ path: '/tmp/dsh-chat-link-workbench.png' })

    await page.setViewportSize({ width: 375, height: 812 })
    await expect.poll(() => page.locator('[data-workbench-fullscreen]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => {
      const box = await mirror.boundingBox()
      return box === null ? Infinity : box.x + box.width
    }).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 120_000)

  it.skipIf(MODE === 'record')('queues rapid distinct and repeated links while navigation is pending', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-rapid-links'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    await openSession(page, 'Rapid preview links')
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    const shellUrl = page.url()
    const commands: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname !== '/api/browser.control') return
      const body = request.postDataJSON() as { payload?: { command?: { kind: string; url?: string } } }
      if (body.payload?.command?.kind === 'open-url' && body.payload.command.url !== undefined) {
        commands.push(body.payload.command.url)
      }
    })

    expect(await browserState(page, scaffold.baseUrl, RAPID_ID)).toBeNull()
    await page.getByRole('link', { name: 'Open original' }).click()
    const originalId = await expectOpenTab(page, scaffold.baseUrl, RAPID_ID, linkUrl, 1)
    const delayedUrl = `${targetOrigin}/delayed?demo=1`
    const nextUrl = `${targetOrigin}/next?demo=2`
    try {
      await page.getByRole('link', { name: 'Open delayed' }).click()
      await waitForDelayed()
      await page.getByRole('link', { name: 'Open next' }).click()
      await page.getByRole('link', { name: 'Open again' }).click()
      expect(page.url()).toBe(shellUrl)
      releaseDelayed()

      await expect.poll(() => commands, { timeout: 30_000 }).toEqual([linkUrl, delayedUrl, nextUrl, nextUrl])
      const finalId = await expectOpenTab(page, scaffold.baseUrl, RAPID_ID, nextUrl, 4)
      const state = await browserState(page, scaffold.baseUrl, RAPID_ID)
      expect(state?.tabs.map(tab => tab.url)).toEqual([linkUrl, delayedUrl, nextUrl, nextUrl])
      expect(new Set(state?.tabs.map(tab => tab.id)).size).toBe(4)
      expect(state?.tabs.find(tab => tab.id === originalId)?.url).toBe(linkUrl)
      expect(finalId).not.toBe(originalId)
      expect(page.url()).toBe(shellUrl)
      await expect.poll(() => page.getByRole('dialog', { name: 'Couldn’t open link' }).count()).toBe(0)
      await page.screenshot({ path: '/tmp/dsh-chat-link-rapid.png' })
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      releaseDelayed()
    }
  }, 120_000)

  it.skipIf(MODE === 'record')('continues queued link clicks after an earlier navigation fails', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-rapid-link-failure'))
    const before = await browserState(page, scaffold.baseUrl, RAPID_ID)
    expect(before?.tabs.length).toBe(4)
    const originalIds = before?.tabs.map(tab => tab.id) ?? []
    const shellUrl = page.url()
    try {
      await page.getByRole('link', { name: 'Open failure' }).click()
      await waitForFailure()
      await page.getByRole('link', { name: 'Open after failure' }).click()
      releaseFailure()

      await expect.poll(async () => {
        const state = await browserState(page, scaffold.baseUrl, RAPID_ID)
        return state?.tabs.length === 5 && state.tabs.slice(0, 4).every((tab, index) => tab.id === originalIds[index])
          && !state.tabs.some(tab => tab.url.includes('/failure'))
          && state.activeTabId !== null && !originalIds.includes(state.activeTabId)
          && state.tabs.find(tab => tab.id === state.activeTabId)?.url === `${targetOrigin}/next?demo=2`
      }, { timeout: 30_000 }).toBe(true)
      const finalId = await expectOpenTab(page, scaffold.baseUrl, RAPID_ID, `${targetOrigin}/next?demo=2`, 5)
      const state = await browserState(page, scaffold.baseUrl, RAPID_ID)
      expect(state?.tabs.slice(0, 4).map(tab => tab.id)).toEqual(originalIds)
      expect(state?.tabs.some(tab => tab.url.includes('/failure'))).toBe(false)
      expect(originalIds).not.toContain(finalId)
      expect(page.url()).toBe(shellUrl)
      const failureDialog = page.getByRole('dialog', { name: 'Couldn’t open link' })
      await expect.poll(() => failureDialog.count()).toBe(1)
      expect(await failureDialog.textContent()).toContain('BROWSER_FAILED')
      expect(await failureDialog.textContent()).not.toContain('BROWSER_BUSY')
      await failureDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => failureDialog.count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      releaseFailure()
    }
  }, 120_000)
})
