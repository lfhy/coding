/** 对话 HTTP 链接经真实 Web 组合在会话 Agent 浏览器中建页，不跳出应用。 */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Browser, Page, Request } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from 'coding-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from 'coding-session'
import type {} from 'coding-session-title'
import { settingsNamespace } from 'coding-settings'
import { assertFixtureInventory, captureStableAria, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/markdown-inline-code-links', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/markdown-inline-code-links/ui.expected.md', import.meta.url))
const ROUTES = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-inline-code-links-web-e2e'
const REFERENCE_ID = 'markdown-reference-links-web-e2e'
const DONE = 'INLINE_CODE_LINK_DONE'
const EGO_CLI = fileURLToPath(new URL('../../../packages/browser/browser-ego-host/runtime/ego-linux/bin/ego-browser.mjs', import.meta.url))
const execFileAsync = promisify(execFile)

/** 固定首份快照输入，同时覆盖引用式链接与危险协议的安全准入。 */
function markdownFixture(linkUrl: string, reference = false): string {
  const session = Session.create(SessionId('markdown-inline-code-links-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the local preview URL.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: reference ? 'Reference preview links' : 'Inline code links',
    messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: reference ? [
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
      ].join('\n') }] }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}' }),
    ...session.events.map(event => JSON.stringify({ ...event, time: eventTimeOrigin + event.seq * 1_000 })),
    '',
  ].join('\n')
}

/** 目标站点单独监听；仅会话浏览器导航后才应收到网页请求。 */
async function fixtureServer(): Promise<{ server: Server; url: string; requests: () => number }> {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>Chat link preview</title></head><body>Preview</body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  return { server, url: `http://127.0.0.1:${String(address.port)}/preview?demo=1`, requests: () => requests }
}

async function openSession(page: Page, title: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByPlaceholder('Search sessions', { exact: false }).fill(title)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
  await result.click()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
}

describe('web e2e: Markdown inline-code links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let linkUrl: string
  let target: Server
  let requests: () => number
  let tripwire: ReturnType<typeof watchConsole>
  let browserStateDir: string | undefined
  let previousEgoEnv: { state: string | undefined; profile: string | undefined; headless: string | undefined }

  beforeAll(async () => {
    const fixture = await fixtureServer()
    target = fixture.server
    linkUrl = fixture.url
    requests = fixture.requests
    previousEgoEnv = { state: process.env.EGO_LINUX_STATE_DIR, profile: process.env.EGO_LINUX_PROFILE,
      headless: process.env.EGO_LINUX_HEADLESS }
    browserStateDir = await mkdtemp(join(tmpdir(), 'dsh-web-chat-links-'))
    process.env.EGO_LINUX_STATE_DIR = browserStateDir
    process.env.EGO_LINUX_PROFILE = join(browserStateDir, 'profile')
    process.env.EGO_LINUX_HEADLESS = '1'
    scaffold = await launchWebScaffold({ replayFixture: ROUTES, replayProvidersOnly: true })
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await seedSession(scaffold, markdownFixture(linkUrl), SEED_ID)
    await seedSession(scaffold, markdownFixture(linkUrl, true), REFERENCE_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
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
    if (target) await new Promise<void>((resolve, reject) => target.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })

  it.skipIf(MODE === 'record')('opens links in isolated session browser pages without old controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-inline-code-links'))
    const popups: Page[] = []
    const legacyControls: Request[] = []
    page.on('popup', (popup) => { popups.push(popup) })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/browser.control') legacyControls.push(request)
    })
    await openSession(page, 'Inline code links')
    const inlineCodeLink = page.locator('[class*="markdown"] code a')
    await expect.poll(() => inlineCodeLink.count()).toBe(1)
    expect(await inlineCodeLink.getAttribute('href')).toBe(linkUrl)
    expect(await inlineCodeLink.getAttribute('target')).toBe('_blank')
    expect(await inlineCodeLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(await page.getByText(`curl ${linkUrl}`, { exact: true }).locator('a').count()).toBe(0)
    expect(await page.getByText('javascript:alert(1)', { exact: true }).locator('a').count()).toBe(0)
    const shellUrl = page.url()
    const currentPages = async (id: string): Promise<{ targetId: string; url: string }[]> => {
      const response = await page.request.get(`${scaffold.baseUrl}/api/ego/spaces?sessionId=${id}`)
      expect(response.status()).toBe(200)
      return (await response.json() as { spaces: { targetId: string; url: string }[] }).spaces
    }
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}').split(linkUrl).join('{{linkUrl}}')
      // 模型目录当前取决于组合默认模型，链接快照只固定 Markdown 与周围布局。
      .replace(/- button "Select model(?:, current [^"]+)?":\n  - text: [^\n]+\n  - img/u,
        '- button "Select model":\n  - text: Select model\n  - img')
    const modelIndependentGolden = (await readFile(UI_EXPECTED, 'utf8'))
      .replace(/- button "Select model(?:, current [^"]+)?":\n  - text: [^\n]+\n  - img/u,
        '- button "Select model":\n  - text: Select model\n  - img')
    expect(`${snapshot}\n`).toBe(modelIndependentGolden)

    await inlineCodeLink.focus()
    expect(await inlineCodeLink.evaluate(node => document.activeElement === node)).toBe(true)
    expect(await page.getByRole('region', { name: 'Agent Browser' }).count()).toBe(0)
    await inlineCodeLink.press('Enter')
    const error = page.getByRole('dialog', { name: 'Couldn’t open link' })
    await expect.poll(async () => (await currentPages(SEED_ID)).filter(item => item.url === linkUrl).length,
      { timeout: 30_000 }).toBe(1)
    const workbench = page.getByRole('region', { name: 'Workbench' })
    const panel = page.getByRole('region', { name: 'Agent Browser' })
    await expect.poll(() => panel.isVisible(), { timeout: 30_000 }).toBe(true)
    const firstId = (await currentPages(SEED_ID)).find(item => item.url === linkUrl)?.targetId
    expect(firstId).toBeTruthy()
    await expect.poll(() => panel.getByRole('textbox', { name: 'Web address' }).inputValue(),
      { timeout: 30_000 }).toBe(linkUrl)
    await expect.poll(() => workbench.getByRole('tab', { name: 'Chat link preview' }).count(),
      { timeout: 30_000 }).toBe(1)
    expect(await error.count()).toBe(0)
    await page.getByRole('link', { name: 'Open preview' }).click()
    await expect.poll(async () => (await currentPages(SEED_ID)).filter(item => item.url === linkUrl).length,
      { timeout: 30_000 }).toBe(2)
    const sameSession = (await currentPages(SEED_ID)).filter(item => item.url === linkUrl)
    expect(sameSession.some(item => item.targetId !== firstId)).toBe(true)
    await expect.poll(() => workbench.getByRole('tab', { name: 'Chat link preview' }).count(),
      { timeout: 30_000 }).toBe(2)
    expect(page.url()).toBe(shellUrl)
    expect(popups).toEqual([])
    expect(legacyControls).toEqual([])
    expect(requests()).toBeGreaterThanOrEqual(2)

    await openSession(page, 'Reference preview links')
    const reference = page.getByRole('link', { name: 'Open reference' })
    expect(await reference.getAttribute('href')).toBe(linkUrl)
    expect(await page.getByRole('link', { name: 'Unsafe preview' }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Local preview' }).count()).toBe(0)
    const denyPageCreation = '**/api/ego/pages'
    await page.route(denyPageCreation, async route => route.fulfill({ status: 503, body: '{"ok":false}' }))
    await reference.click()
    await expect.poll(() => error.isVisible()).toBe(true)
    expect(await error.textContent()).toContain('Could not open this link in Agent Browser')
    expect((await currentPages(REFERENCE_ID)).filter(item => item.url === linkUrl)).toHaveLength(0)
    await page.unroute(denyPageCreation)
    await error.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await currentPages(REFERENCE_ID)).filter(item => item.url === linkUrl).length,
      { timeout: 30_000 }).toBe(1)
    expect(await error.count()).toBe(0)
    expect((await currentPages(REFERENCE_ID)).every(item => !sameSession.some(previous => previous.targetId === item.targetId)))
      .toBe(true)
    await expect.poll(() => panel.getByRole('textbox', { name: 'Web address' }).inputValue(),
      { timeout: 30_000 }).toBe(linkUrl)
    expect(page.url()).toBe(shellUrl)
    expect(popups).toEqual([])
    expect(legacyControls).toEqual([])
    expect((await currentPages(SEED_ID)).filter(item => item.url === linkUrl)).toHaveLength(2)
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 120_000)
})
