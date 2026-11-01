/** 从真实 Web Loader 验收会话浏览器自动观察、人工输入与 Host 身份拒绝。 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CallId, createAssistantMessage, createUserMessage } from 'coding-llm'
import type { StreamChunk } from 'coding-llm'
import type { ReplayOverrideDoc } from 'coding-llm-replay'
import { Session, SessionId, SESSION_FORMAT_VERSION } from 'coding-session'
import type { SessionEvent } from 'coding-session'
import { settingsNamespace } from 'coding-settings'
import { launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIRST = 'ego-browser-first'
const SECOND = 'ego-browser-second'
const NAVIGATE_ID = CallId('web-ego-navigate')
const SNAPSHOT_ID = CallId('web-ego-snapshot')
const MODE = webSnapshotMode()
const EGO_CLI = fileURLToPath(new URL('../../../packages/browser/browser-ego-host/runtime/ego-linux/bin/ego-browser.mjs', import.meta.url))
const execFileAsync = promisify(execFile)

/** 两轮回放只替换模型输出，浏览器工具仍由已组装 Host 真正执行。 */
function toolRound(id: ReturnType<typeof CallId>, name: string, args: object, answer: string): StreamChunk[][] {
  const argumentsJson = JSON.stringify(args)
  return [
    [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: answer },
      { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ]
}

function modelReplay(url: string): ReplayOverrideDoc {
  return [
    ...toolRound(NAVIGATE_ID, 'browser_navigate', { url }, 'Fixture opened.'),
    ...toolRound(SNAPSHOT_ID, 'browser_snapshot', {}, 'Page inspected.'),
  ].map(chunks => ({ kind: 'chunks', chunks }))
}

function fixture(title: string): string {
  const session = Session.create(SessionId('ego-browser-fixture'))
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
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Agent fixture</title></head><body style="margin:0;font:20px sans-serif">
      <button style="position:absolute;left:20px;top:20px;width:200px;height:80px"
        onclick="document.querySelector('#clicks').textContent='Clicks: 1'">Increment clicks</button>
      <label for="entry" style="position:absolute;left:20px;top:110px">Message</label>
      <input id="entry" style="position:absolute;left:20px;top:140px;width:300px;height:50px"
        oninput="document.querySelector('#typed').textContent='Typed: '+this.value">
      <p id="clicks" style="position:absolute;top:220px">Clicks: 0</p>
      <p id="typed" style="position:absolute;top:260px">Typed: empty</p></body></html>`)
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
  await page.getByPlaceholder('Search sessions', { exact: false }).fill(`Inspect ${id}`)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 30_000 }).toBe(1)
  await result.click()
  await page.getByText(`${id} ready.`, { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Clear search' }).click()
}

type EgoPage = { targetId: string; url: string; title: string; viewportW: number | null; viewportH: number | null }

async function spaces(page: Page, baseUrl: string, id: string): Promise<EgoPage[]> {
  const response = await page.request.get(`${baseUrl}/api/ego/spaces?sessionId=${id}`)
  expect(response.status()).toBe(200)
  const body = await response.json() as { ok: boolean; spaces: EgoPage[] }
  expect(body.ok).toBe(true)
  return body.spaces
}

async function clickOnFrame(page: Page, panel: Locator, target: EgoPage, x: number, y: number): Promise<void> {
  const image = panel.getByRole('img', { name: 'Current page view' })
  const box = await image.boundingBox()
  if (!box || !target.viewportW || !target.viewportH) throw new Error('visible page geometry is missing')
  await expect.poll(() => panel.getByRole('button', { name: 'Current page view' }).isEnabled()).toBe(true)
  await page.mouse.click(box.x + x / target.viewportW * box.width, box.y + y / target.viewportH * box.height)
}

describe('web e2e: Agent Browser over the shipped Loader', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let target: Server
  let origin: string
  let replayDir: string | undefined
  let browserStateDir: string | undefined
  let disposeApproval: (() => void) | undefined
  let previousEgoEnv: { state: string | undefined; profile: string | undefined; headless: string | undefined }
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    const fixtureSite = await fixtureServer()
    target = fixtureSite.server
    origin = fixtureSite.origin
    previousEgoEnv = { state: process.env.EGO_LINUX_STATE_DIR, profile: process.env.EGO_LINUX_PROFILE,
      headless: process.env.EGO_LINUX_HEADLESS }
    browserStateDir = await mkdtemp(join(tmpdir(), 'dsh-web-ego-state-'))
    process.env.EGO_LINUX_STATE_DIR = browserStateDir
    process.env.EGO_LINUX_PROFILE = join(browserStateDir, 'profile')
    process.env.EGO_LINUX_HEADLESS = '1'
    if (MODE !== 'record') {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-web-ego-browser-'))
      const replayOverride = join(replayDir, 'model-browser.override.json')
      await writeFile(replayOverride, JSON.stringify(modelReplay(`${origin}/interactive`)))
      scaffold = await launchWebScaffold({ replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride })
    } else scaffold = await launchWebScaffold()
    disposeApproval = scaffold.ctx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id === SessionId(FIRST)) events.push(event)
    })
    await seedSession(scaffold, fixture(FIRST), FIRST)
    await seedSession(scaffold, fixture(SECOND), SECOND)
    await writeFile(join(scaffold.workspaceCwd, 'sidebar-preview.txt'), 'File preview remains available.\n')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    disposeApproval?.()
    await scaffold?.close()
    if (target) await new Promise<void>((resolve, reject) => target.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
    if (browserStateDir !== undefined) {
      try {
        await execFileAsync(process.execPath, [EGO_CLI, '--stop'], { timeout: 10_000 })
      } finally {
        await rm(browserStateDir, { recursive: true, force: true })
        if (previousEgoEnv.state === undefined) delete process.env.EGO_LINUX_STATE_DIR
        else process.env.EGO_LINUX_STATE_DIR = previousEgoEnv.state
        if (previousEgoEnv.profile === undefined) delete process.env.EGO_LINUX_PROFILE
        else process.env.EGO_LINUX_PROFILE = previousEgoEnv.profile
        if (previousEgoEnv.headless === undefined) delete process.env.EGO_LINUX_HEADLESS
        else process.env.EGO_LINUX_HEADLESS = previousEgoEnv.headless
      }
    }
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('reveals an isolated real page and accepts only current-session page input', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-browser'))
    await openSession(page, FIRST)
    const panel = page.getByRole('region', { name: 'Agent Browser' })
    expect(await panel.isVisible()).toBe(false)
    const composer = page.locator('textarea:enabled').first()
    await composer.fill('Open the fixture in the browser.')
    const settled = scaffold.whenTurnSettled()
    await composer.press('Enter')
    expect(await settled).toBe(SessionId(FIRST))
    const navigation = events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === NAVIGATE_ID)
    expect(navigation?.type === 'tool/result' ? navigation.data.message.content[0].isError : true).toBe(false)
    await expect.poll(() => panel.isVisible(), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await spaces(page, scaffold.baseUrl, FIRST))[0]?.title,
      { timeout: 30_000 }).toBe('Agent fixture')
    const [first] = await spaces(page, scaffold.baseUrl, FIRST)
    if (!first) throw new Error('model navigation did not register the session page')
    expect(first.url).toBe(`${origin}/interactive`)
    const frame = panel.getByRole('img', { name: 'Current page view' })
    await expect.poll(() => frame.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      { timeout: 30_000 }).toBe(true)
    expect(await panel.getByRole('textbox', { name: 'Address' }).count()).toBe(0)
    expect(await panel.locator('iframe, webview').count()).toBe(0)

    const foreignFrame = await page.request.get(`${scaffold.baseUrl}/api/ego/frame?sessionId=${SECOND}&targetId=${first.targetId}`)
    expect(foreignFrame.status()).toBe(404)
    const foreignInput = await page.request.post(`${scaffold.baseUrl}/api/ego/input`, {
      data: { sessionId: SECOND, targetId: first.targetId, type: 'insertText', text: 'foreign' },
      headers: { origin: scaffold.baseUrl },
    })
    expect(foreignInput.ok()).toBe(false)
    expect((await foreignInput.json() as { ok: boolean }).ok).toBe(false)
    const crossSite = await page.request.post(`${scaffold.baseUrl}/api/ego/input`, {
      data: { sessionId: FIRST, targetId: first.targetId, type: 'insertText', text: 'foreign' },
      headers: { origin: 'https://other.example' },
    })
    expect(crossSite.status()).toBe(403)
    // 未装载的会话不可观察；打开后再验收其空页面列表。
    expect((await page.request.get(`${scaffold.baseUrl}/api/ego/spaces?sessionId=${SECOND}`)).status()).toBe(404)

    await clickOnFrame(page, panel, first, 120, 60)
    await expect.poll(() => panel.getByRole('button', { name: 'Current page view' }).isEnabled()).toBe(true)
    await clickOnFrame(page, panel, first, 120, 165)
    const input = panel.getByRole('textbox', { name: 'Text to send to page' })
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.fill('Human typed here')
    await panel.getByRole('button', { name: 'Insert text' }).click()

    await openSession(page, SECOND)
    expect(await spaces(page, scaffold.baseUrl, SECOND)).toEqual([])
    expect(await panel.isVisible()).toBe(false)
    const openSidebar = page.getByRole('button', { name: 'Open right sidebar' })
    if (await openSidebar.count() > 0) await openSidebar.click()
    await page.getByRole('navigation', { name: 'Workbench features' })
      .getByRole('button', { name: 'Agent Browser' }).click()
    await expect.poll(() => panel.isVisible()).toBe(true)
    await panel.getByText('No pages are open yet').waitFor()
    expect(await panel.getByRole('img', { name: 'Current page view' }).count()).toBe(0)

    await openSession(page, FIRST)
    await expect.poll(() => panel.getByRole('img', { name: 'Current page view' }).count()).toBe(1)
    const verify = page.locator('textarea:enabled').first()
    await verify.fill('Read the page after my changes.')
    const verified = scaffold.whenTurnSettled()
    await verify.press('Enter')
    expect(await verified).toBe(SessionId(FIRST))
    const snapshot = events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === SNAPSHOT_ID)
    if (snapshot?.type !== 'tool/result') throw new Error('model page observation was not persisted')
    expect(snapshot.data.message.content[0].isError).toBe(false)
    const content = snapshot.data.message.content[0].content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    expect(content).toContain('Clicks: 1')
    expect(content).toContain('Typed: Human typed here')
    expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps the file manager reachable at desktop and narrow widths', async () => {
    const filesPage = await newEnglishPage(browser)
    const health = watchConsole(filesPage)
    try {
      await filesPage.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await openSession(filesPage, SECOND)
      const workbench = filesPage.getByRole('region', { name: 'Workbench' })
      await filesPage.getByRole('button', { name: 'Open right sidebar' }).click()
      await workbench.getByRole('navigation', { name: 'Workbench features' })
        .getByRole('button', { name: 'Files' }).click()
      const manager = workbench.getByRole('tab', { name: 'File manager' })
      const tree = workbench.locator('aside[aria-label="Workspace files"]')
      await expect.poll(() => manager.getAttribute('aria-selected')).toBe('true')
      await tree.getByRole('button', { name: /sidebar-preview\.txt/ }).click()
      const file = workbench.getByRole('tab', { name: 'sidebar-preview.txt' })
      await expect.poll(() => file.getAttribute('aria-selected')).toBe('true')
      await workbench.getByRole('button', { name: 'Maximize workbench' }).click()
      for (const width of [1680, 375]) {
        await filesPage.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
        await expect.poll(() => workbench.getAttribute('data-fullscreen')).toBe('true')
        const preview = workbench.locator('article[aria-label="sidebar-preview.txt"]')
        await expect.poll(() => preview.isVisible()).toBe(true)
        expect(await preview.textContent()).toContain('File preview remains available.')
        expect(await filesPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
        await manager.click()
        await expect.poll(() => tree.isVisible()).toBe(true)
        await expect.poll(() => manager.getAttribute('aria-selected')).toBe('true')
        await file.click()
      }
      expect(health.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(filesPage, 'workbench-file-navigation')
      throw error
    } finally { await filesPage.close() }
  }, 120_000)
})
