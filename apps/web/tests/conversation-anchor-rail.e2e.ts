// 已组合浏览器中的长对话导航：只使用持久日志种子，不发送模型请求。
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const MODE = webSnapshotMode()
const SESSION_ID = 'conversation-anchor-rail-e2e'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'ANCHOR',
  title: 'CHAT_SCROLL_ANCHOR long navigation session',
  turns: 88,
})
const SHOTS = {
  before: '/tmp/dsh-conversation-anchors-before.png',
  hover: '/tmp/dsh-conversation-anchors-hover.png',
  after: '/tmp/dsh-conversation-anchors-after.png',
  mobile: '/tmp/dsh-conversation-anchors-mobile.png',
  dense: '/tmp/dsh-conversation-anchors-dense.png',
  failure: '/tmp/dsh-conversation-anchors-failure.png',
} as const

interface LoadedAnchor {
  readonly key: string
  readonly marker: string
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))
  }))
}

function loadedUserAnchors(page: Page): Promise<LoadedAnchor[]> {
  return page.locator('[data-conversation-scroll] [data-chat-flow-kind="user"]').evaluateAll(rows => (
    rows.flatMap((row) => {
      const key = (row as HTMLElement).dataset.chatAnchorKey
      const marker = /CHAT_SCROLL_ANCHOR_USER_\d{3}/.exec(row.textContent ?? '')?.[0]
      return key === undefined || marker === undefined ? [] : [{ key, marker }]
    })
  ))
}

function scrollTop(page: Page): Promise<number> {
  return page.locator('[data-conversation-scroll]').evaluate(host => host.scrollTop)
}

function targetTop(page: Page, key: string): Promise<number> {
  return page.locator('[data-conversation-scroll]').evaluate((host, targetKey) => {
    const row = [...host.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
      .find(candidate => candidate.dataset.chatAnchorKey === targetKey)
    if (row === undefined) throw new Error(`loaded message ${targetKey} is missing`)
    return row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, key)
}

async function openSeed(page: Page): Promise<void> {
  await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search sessions...', exact: true })
    .fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  await results.click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false })
    .last().waitFor({ timeout: 30_000 })
  await nextPaint(page)
}

describe('web e2e: conversation anchor rail over loaded Chat history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('conversation-anchor-rail requires keyless replay/refresh mode')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SESSION_ID)
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
  })

  it('previews, jumps, follows reader scrolling, and becomes a compact jump list', async () => {
    onTestFailed(async () => { await page?.screenshot({ path: SHOTS.failure }).catch(() => {}) })
    await openSeed(page)
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toBe(`${FIXTURE.title} — Coding`)
    expect(await page.getByRole('tab', { name: 'Chat', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal').count()).toBe(0)

    const scrollport = page.locator('[data-conversation-scroll]')
    expect(await scrollport.evaluate(host => host.clientWidth)).toBeGreaterThanOrEqual(840)
    const anchors = await loadedUserAnchors(page)
    expect(anchors.length).toBeGreaterThan(4)
    expect(anchors.length).toBeLessThan(FIXTURE.turns)
    const rail = page.getByRole('navigation', { name: 'Conversation navigation' })
    await expect.poll(() => rail.getByRole('button').count(), { timeout: 15_000 }).toBe(anchors.length)
    expect(await rail.getByRole('button', { name: /Message \d+ of \d+: CHAT_SCROLL_ANCHOR_USER_/ }).count())
      .toBe(anchors.length)
    expect(await rail.locator('[aria-current="location"]').count()).toBe(1)
    const initialTop = await scrollTop(page)
    expect(initialTop).toBeGreaterThan(0)
    await page.screenshot({ path: SHOTS.before })

    const target = anchors[3]!
    const mark = rail.getByRole('button', { name: new RegExp(target.marker) })
    await mark.hover()
    await expect.poll(() => page.getByRole('tooltip').textContent(), { timeout: 10_000 })
      .toContain(target.marker)
    const previewBounds = await page.getByRole('tooltip').boundingBox()
    if (previewBounds === null) throw new Error('anchor preview has no layout box')
    expect(previewBounds.x).toBeGreaterThanOrEqual(16)
    expect(previewBounds.y).toBeGreaterThanOrEqual(16)
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(1680 - 16)
    expect(previewBounds.y + previewBounds.height).toBeLessThanOrEqual(1000 - 16)
    await page.screenshot({ path: SHOTS.hover })
    await mark.focus()
    await expect.poll(() => page.getByRole('tooltip').textContent(), { timeout: 10_000 })
      .toContain(target.marker)
    await mark.click()
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBeLessThan(initialTop)
    await expect.poll(async () => Math.abs(16 - await targetTop(page, target.key)), { timeout: 10_000 })
      .toBeLessThanOrEqual(4)
    await expect.poll(() => mark.getAttribute('aria-current'), { timeout: 10_000 }).toBe('location')
    const railScroll = rail.locator('[class*="railScroll"]')
    await expect.poll(() => mark.evaluate((button) => {
      const viewport = button.parentElement!.getBoundingClientRect()
      const rect = button.getBoundingClientRect()
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom
    }), { timeout: 10_000 }).toBe(true)
    await page.screenshot({ path: SHOTS.after })
    const jumpedTop = await scrollTop(page)

    const box = await scrollport.boundingBox()
    if (box === null) throw new Error('conversation scrollport has no layout box')
    await page.mouse.move(box.x + box.width / 2, box.y + 180)
    await page.mouse.wheel(0, 1_500)
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBeGreaterThan(jumpedTop + 500)
    await expect.poll(() => mark.getAttribute('aria-current'), { timeout: 10_000 }).toBeNull()
    expect(await rail.locator('[aria-current="location"]').count()).toBe(1)

    await page.setViewportSize({ width: 375, height: 800 })
    await expect.poll(() => scrollport.evaluate(host => host.clientWidth), { timeout: 10_000 })
      .toBeLessThan(840)
    await expect.poll(() => rail.count(), { timeout: 10_000 }).toBe(0)
    const compact = page.getByRole('button', { name: 'Jump to message' })
    await expect.poll(() => compact.isVisible(), { timeout: 10_000 }).toBe(true)
    await scrollport.evaluate((host) => { host.scrollTop = host.scrollHeight })
    await nextPaint(page)
    const mobileBefore = await scrollTop(page)
    await compact.click()
    await expect.poll(() => compact.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    const list = page.locator('#conversation-anchor-list')
    await expect.poll(() => list.getByRole('button').count(), { timeout: 10_000 })
      .toBe(anchors.length + 1)
    await page.screenshot({ path: SHOTS.mobile })
    const listBounds = await list.evaluate(element => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
    }))
    expect(listBounds.left).toBeGreaterThanOrEqual(0)
    expect(listBounds.right).toBeLessThanOrEqual(375)
    await list.getByRole('button', { name: new RegExp(target.marker) }).click()
    await expect.poll(() => compact.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('false')
    await expect.poll(() => list.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => scrollTop(page), { timeout: 10_000 }).toBeLessThan(mobileBefore)
    await expect.poll(async () => Math.abs(16 - await targetTop(page, target.key)), { timeout: 10_000 })
      .toBeLessThanOrEqual(4)

    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => scrollport.evaluate(host => host.clientWidth), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(840)
    const older = page.getByRole('button', { name: 'Load earlier', exact: true })
    let loadedCount = anchors.length
    for (let pageIndex = 0; pageIndex < 10 && loadedCount < FIXTURE.turns; pageIndex += 1) {
      await scrollport.evaluate((host) => { host.scrollTop = 0 })
      await nextPaint(page)
      await older.waitFor({ timeout: 10_000 })
      await older.click()
      await expect.poll(async () => (await loadedUserAnchors(page)).length, { timeout: 30_000 })
        .toBeGreaterThan(loadedCount)
      loadedCount = (await loadedUserAnchors(page)).length
    }
    const expandedAnchors = await loadedUserAnchors(page)
    expect(expandedAnchors.length).toBeGreaterThanOrEqual(FIXTURE.turns)
    expect(await older.count()).toBe(0)
    expect(expandedAnchors[0]?.marker).not.toBe(anchors[0]?.marker)
    await expect.poll(() => rail.getByRole('button').count(), { timeout: 10_000 })
      .toBe(expandedAnchors.length)
    const geometry = await railScroll.evaluate((viewport) => {
      const rail = viewport.getBoundingClientRect()
      const host = viewport.closest('[data-conversation-scroll]')!
      const composer = host.querySelector('[data-composer-seat]')!
      const visibleHeight = Math.min(host.getBoundingClientRect().bottom, composer.getBoundingClientRect().top)
        - host.getBoundingClientRect().top - 16
      const boxes = [...viewport.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      return {
        height: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        visibleHeight,
        centerOffset: Math.abs((rail.top + rail.bottom) / 2
          - (host.getBoundingClientRect().top + visibleHeight / 2)),
        rowHeights: boxes.map(box => box.height),
        rowPitches: boxes.slice(1).map((box, index) => box.top - boxes[index]!.top),
      }
    })
    expect(geometry.height).toBeLessThanOrEqual(geometry.visibleHeight - 96 + 1)
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height)
    expect(geometry.centerOffset).toBeLessThanOrEqual(4)
    expect(geometry.rowHeights.every(height => Math.abs(height - 10) <= 0.5)).toBe(true)
    expect(geometry.rowPitches.every(pitch => Math.abs(pitch - 10) <= 0.5)).toBe(true)
    await page.screenshot({ path: SHOTS.dense })

    // 先将细轨自身滚到底，再把屏幕外的早期标记带回可见区域；消息滚动不随细轨移动。
    const denseTarget = expandedAnchors[0]!
    const denseMark = rail.getByRole('button', { name: new RegExp(denseTarget.marker) })
    await railScroll.evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight })
    await nextPaint(page)
    expect(await denseMark.evaluate(button => (
      button.getBoundingClientRect().bottom <= button.parentElement!.getBoundingClientRect().top
    ))).toBe(true)
    const beforeRailScroll = await scrollTop(page)
    await denseMark.scrollIntoViewIfNeeded()
    expect(Math.abs(await scrollTop(page) - beforeRailScroll)).toBeLessThanOrEqual(1)
    const denseBox = await denseMark.boundingBox()
    if (denseBox === null) throw new Error(`rail mark for ${denseTarget.marker} has no visible box`)
    const point = { x: denseBox.x + denseBox.width / 2, y: denseBox.y + denseBox.height / 2 }
    const topmost = await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null
    ), point)
    expect(topmost).toContain(denseTarget.marker)
    await page.mouse.click(point.x, point.y)
    await expect.poll(async () => Math.abs(16 - await targetTop(page, denseTarget.key)), {
      timeout: 10_000,
      message: `dense mark ${denseTarget.marker} at (${point.x}, ${point.y}); pointer hit ${topmost}`,
    }).toBeLessThanOrEqual(4)
    await expect.poll(
      () => denseMark.getAttribute('aria-current'),
      { timeout: 10_000 },
    ).toBe('location')
    await expect.poll(() => denseMark.evaluate((button) => {
      const viewport = button.parentElement!.getBoundingClientRect()
      const rect = button.getBoundingClientRect()
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom
    }), { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(consoleErrors).toEqual([])
  }, 150_000)
})
