// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's effort pane — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, localePreference: null })
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the pane leads with the provider-default entry.
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared levels and records the picked one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Acme Gateway' }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('menuitem', { name: 'Acme Gateway' }).waitFor()
    await page.getByRole('menuitem', { name: 'Acme Gateway' }).click()
    await page.getByRole('menuitem', { name: /推理等级/ }).click()

    // Declared levels, nothing else: the provider-default entry (the route
    // configures no `reasoning`), then none/High/Max — minimal, low, medium,
    // and xhigh were not declared and must not be offered.
    const levels = page.getByRole('menuitemradio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual(['Default', 'none', 'High', 'Max'])
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    // Picking a level is the same gesture that saves the default selection, so
    // the effort lands in the Agent default Settings section beside provider/model.
    await page.getByRole('menuitemradio', { name: 'High' }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the menu operable after narrowing and on a fresh narrow page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning-narrow'))
    await page.setViewportSize({ width: 375, height: 812 })
    await expect.poll(() => page.locator('[data-sidebar-collapsed]').getAttribute('data-sidebar-collapsed')).toBe('true')
    await expect.poll(async () => (await page.locator('#dsh-layout-sidebar').boundingBox())?.width ?? 375)
      .toBeLessThanOrEqual(56)
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const menu = page.getByRole('menu', { name: '渠道、模型与推理等级' })
    await menu.waitFor()
    await expect.poll(() => menu.getAttribute('aria-busy')).toBe('false')
    const bounds = await menu.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    const firstChannel = menu.getByRole('menuitem').first()
    expect(await firstChannel.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    })).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'model-menu-375.png'), fullPage: false })
    }
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    const fresh = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: ZH_BROWSER_LOCALE })
    const freshTripwire = watchConsole(fresh)
    try {
      await fresh.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await fresh.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(() => fresh.locator('[data-sidebar-collapsed]').getAttribute('data-sidebar-collapsed'))
        .toBe('true')
      const freshTrigger = fresh.getByRole('button', { name: /^选择模型/ })
      await freshTrigger.waitFor({ timeout: 15_000 })
      await freshTrigger.click()
      const freshMenu = fresh.getByRole('menu', { name: '渠道、模型与推理等级' })
      await expect.poll(() => freshMenu.getAttribute('aria-busy')).toBe('false')
      const first = freshMenu.getByRole('menuitem').first()
      expect(await first.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      })).toBe(true)
      if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
        await fresh.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'model-menu-fresh-375.png'), fullPage: false })
      }
      expect(await fresh.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
      expect(freshTripwire.warnings).toEqual([])
      expect(freshTripwire.pageErrors).toEqual([])
    } finally {
      await fresh.close()
    }
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
