// Web e2e scenario: full-session stats over paged history. A deterministic
// 28-turn log (56 surface messages — more than one 50-message history page)
// seeded cold through the REAL persistence API must render whole-log turn/step
// counts from the sessionStats projection on first open, and loading the
// older page must NOT change them. This pins the bug the projection fixed:
// the pre-projection window fold recounted per loaded page, so 加载更早 grew
// the counter. Zero model calls; the seed is generated, not recorded, because
// no line of it is model output.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/stats-paged-history', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/stats-paged-history/ui.expected.md', import.meta.url))
const OVERVIEW_EXPECTED = fileURLToPath(new URL('./snapshots/stats-paged-history/overview.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'stats-paged-history-web-e2e'

/** Turn count: 2 surface messages per turn, so 28 turns overflow one 50-message page. */
const TURNS = 28

/**
 * Generate the seed: TURNS closed single-step turns of one short user prompt
 * and one short assistant reply each. Times are fixed so the fixture is
 * byte-deterministic; message ids are synthetic uuids (aria normalizes them).
 * @param turns - closed turns to generate.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(turns: number): string {
  const lines = [JSON.stringify({
    type: 'session', version: 0, id: '{{sessionId}}', createdAt: 1784974100000, cwd: '{{cwd}}/workspace',
  })]
  let seq = 0
  let time = 1784974100000
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: time++ }))
  }
  for (let turn = 1; turn <= turns; turn++) {
    at({ type: 'turn/start', data: { turn } })
    at({
      type: 'user/message',
      data: { content: [{ type: 'text', text: `m${turn}` }], source: { kind: 'user' } },
      surfaceOp: 'append',
    })
    at({ type: 'step/start', data: { turn, step: 1 } })
    at({
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`,
          role: 'assistant',
          content: [{ type: 'text', text: `r${turn}` }],
          source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
        },
      },
      sourceEventSeqs: [],
      surfaceOp: 'append',
    })
    at({ type: 'step/end', data: { turn, step: 1 } })
    at({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return `${lines.join('\n')}\n`
}

describe('web e2e: whole-session stats survive history paging', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('stats-paged-history is a keyless assembled snapshot')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(TURNS), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText(`r${TURNS}`, { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders full-session counts on the partial tail page and keeps them across load-older', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-paged'))
    // Settled barrier is established in setup so the card and paging cases can run separately.
    // The tail page is partial (56 messages > one 50-message page): the first
    // turns are NOT loaded, yet the overview already reports the whole log —
    // the sessionStats projection, not the window fold.
    expect(await page.getByText('m1', { exact: true }).count()).toBe(0)
    const card = page.getByRole('region', { name: 'Session overview' })
    await expect.poll(() => card.getByText('Turns').locator('..').textContent(), { timeout: 10_000 }).toBe(`Turns${TURNS}`)
    expect(await card.getByText('Steps').locator('..').textContent()).toBe(`Steps${TURNS}`)
    const beforePaging = await card.textContent()
    expect(await page.locator('[data-composer-seat]').getByText(`${TURNS} turns`, { exact: false }).count()).toBe(0)

    // 加载更早: prepending the older page must not move ANY overview figure —
    // counts, wall times, or token groups.
    await page.getByRole('button', { name: 'Load earlier' }).click()
    await expect.poll(() => page.getByText('m1', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await card.textContent()).toBe(beforePaging)
    // With the whole log loaded, the window mounts one turn-tail footer per
    // settled turn — the loaded-window probe the scroll/perf lanes count now
    // that the overview is whole-log-scoped.
    expect(await page.locator('[data-chat-flow-key^="9:turn-tail"]').count()).toBe(TURNS)
  }, 60_000)

  it('matches the paged-stats aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-paged-aria'))
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it('shows whole-session figures inside the conversation and folds when space narrows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-overview'))
    const card = page.getByRole('region', { name: 'Session overview' })
    await card.waitFor()
    expect(await page.getByRole('button', { name: 'Collapse session overview' }).first().getAttribute('aria-expanded')).toBe('true')
    expect(await card.getByText('Turns').locator('..').textContent()).toBe('Turns28')
    expect(await card.getByText('Steps').locator('..').textContent()).toBe('Steps28')
    expect(await card.getByText('Subagents').locator('..').textContent()).toBe('Subagents0')
    expect(await card.getByText('Background tasks').locator('..').textContent()).toBe('Background tasks0')
    const body = await page.locator('[data-conversation-scroll]').boundingBox()
    const cardBox = await card.boundingBox()
    expect(body).not.toBeNull()
    expect(cardBox).not.toBeNull()
    expect(cardBox!.x).toBeGreaterThan(body!.x + body!.width / 2)
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(body!.x + body!.width)
    const snapshot = await captureStableAria(page, '[aria-label="Session overview"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(OVERVIEW_EXPECTED, snapshot, MODE)
    if (process.env.DSH_VISUAL_CAPTURE === '1') await saveFailureShot(page, 'session-overview-desktop')
    await page.getByRole('button', { name: 'Collapse session overview' }).first().click()
    await expect.poll(() => card.isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Expand session overview' }).click()
    await card.waitFor({ state: 'visible' })

    await page.setViewportSize({ width: 1024, height: 768 })
    const expand = page.getByRole('button', { name: 'Expand session overview' })
    await expand.waitFor({ state: 'visible' })
    await expect.poll(() => card.isVisible()).toBe(false)
    expect(await expand.getAttribute('aria-expanded')).toBe('false')
    if (process.env.DSH_VISUAL_CAPTURE === '1') await saveFailureShot(page, 'session-overview-1024')
    await expand.click()
    await card.waitFor({ state: 'visible' })
    await card.getByRole('button', { name: 'Collapse session overview' }).click()
    await expect.poll(() => card.isVisible()).toBe(false)
    await page.setViewportSize({ width: 768, height: 768 })
    await expand.waitFor({ state: 'visible' })
    const sidebar = page.locator('#dsh-layout-sidebar')
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(56)
    await page.setViewportSize({ width: 375, height: 768 })
    await expand.waitFor({ state: 'visible' })
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(56)
    await expect.poll(async () => Math.round((await page.locator('[data-conversation-scroll]').boundingBox())?.width ?? 0)).toBe(319)
    if (process.env.DSH_VISUAL_CAPTURE === '1') await saveFailureShot(page, 'session-overview-375')
    await expand.click()
    await card.waitFor({ state: 'visible' })
    const narrowCard = await card.boundingBox()
    expect(narrowCard).not.toBeNull()
    expect(narrowCard!.x).toBeGreaterThanOrEqual(56)
    expect(narrowCard!.x + narrowCard!.width).toBeLessThanOrEqual(375)
    if (process.env.DSH_VISUAL_CAPTURE === '1') await saveFailureShot(page, 'session-overview-375-expanded')
    await card.getByRole('button', { name: 'Collapse session overview' }).click()
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('dsh-conversation-overview-toggle')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await card.waitFor({ state: 'visible' })
    // 文件侧栏占用工作台列宽，概览默认显隐随剩余会话列宽变化。
    await page.getByRole('button', { name: 'Show files sidebar', exact: true }).click()
    const hideFiles = page.getByRole('button', { name: 'Hide files sidebar', exact: true })
    await hideFiles.waitFor({ state: 'visible' })
    expect(await hideFiles.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => card.isVisible()).toBe(false)
    await expand.waitFor({ state: 'visible' })
  }, 60_000)

  it('issued zero model calls and stayed clean', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'overview.expected.md'])
  })
})
