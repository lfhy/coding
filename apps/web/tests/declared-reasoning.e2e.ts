// 手动声明的 reasoningEfforts 进入 composer 的强度滑块；选择经会话 RPC
// 提交并写入 Agent 默认设置。场景不调用模型，无需录制流式 fixture。
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

/** 将初始默认路由指向本场景声明的模型。 */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: declared reasoning efforts reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let effortSnapshot: string
  const selections: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, localePreference: null })
    // 可选等级完全由模型声明；max 的底层 wire 值是 ultra，off 不发送推理参数。
    // 路由没有部署默认强度，弹层起始显示 Default。
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
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/session.selectModel')) return
      const envelope = request.postDataJSON() as { payload: Record<string, unknown> }
      selections.push(envelope.payload)
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared slider levels and records the selected payload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const effort = page.getByRole('dialog', { name: '推理等级与当前模型' })
    await expect.poll(() => effort.getAttribute('aria-busy'), { timeout: 10_000 }).toBe('false')
    const slider = effort.getByRole('slider', { name: '调整推理等级' })
    await slider.waitFor()
    expect(await slider.getAttribute('min')).toBe('0')
    expect(await slider.getAttribute('max')).toBe('3')
    expect(await slider.getAttribute('step')).toBe('1')
    expect(await slider.getAttribute('aria-valuetext')).toBe('Default')
    for (const level of ['none', 'High', 'Max']) {
      expect(await effort.getByText(level, { exact: true }).count()).toBe(1)
    }
    expect(await effort.getByText('Low', { exact: true }).count()).toBe(0)
    expect(await effort.getByRole('button', { name: /当前模型\s*Acme Think/ }).count()).toBe(1)
    effortSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="推理等级与当前模型"]', scaffold.workspaceCwd)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-strength-desktop.png'), fullPage: false })
    }

    // Default 是独立零档；往右依次提交 off、high，不跳过关闭推理档。
    await slider.focus()
    await slider.press('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('none')
    await expect.poll(() => selections.at(-1), { timeout: 10_000 }).toMatchObject({
      provider: 'acme-gateway', model: 'acme-think', reasoningEffort: 'off',
    })
    await expect.poll(() => effort.getAttribute('aria-busy')).toBe('false')
    await slider.press('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('High')
    await expect.poll(() => selections.at(-1), { timeout: 10_000 }).toMatchObject({
      provider: 'acme-gateway', model: 'acme-think', reasoningEffort: 'high',
    })
    expect(typeof selections.at(-1)?.sessionId).toBe('string')
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择模型，当前 Acme Think，推理等级 High')
    expect(await effort.isVisible()).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('opens the two-column model browser from the current-model link and filters its rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning-models'))
    const effort = page.getByRole('dialog', { name: '推理等级与当前模型' })
    await effort.getByRole('button', { name: /当前模型\s*Acme Think/ }).click()
    const models = page.getByRole('dialog', { name: '选择模型' })
    await expect.poll(() => models.getAttribute('aria-busy')).toBe('false')
    const providers = models.locator('[aria-label="渠道列表"]')
    const channel = providers.getByRole('button', { name: 'Acme Gateway' })
    await channel.waitFor()
    expect(await channel.getAttribute('aria-pressed')).toBe('true')
    const model = models.getByRole('button', { name: 'Acme Think' })
    await model.waitFor()
    expect(await model.getAttribute('aria-current')).toBe('true')
    const providerBounds = await providers.boundingBox()
    const modelBounds = await model.boundingBox()
    expect(providerBounds).not.toBeNull()
    expect(modelBounds).not.toBeNull()
    expect(providerBounds!.x + providerBounds!.width).toBeLessThanOrEqual(modelBounds!.x)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-model-browser-desktop.png'), fullPage: false })
    }

    const search = models.getByRole('searchbox', { name: '搜索模型' })
    await search.fill('not-a-declared-model')
    await models.getByText('没有匹配的模型。').waitFor()
    expect(await model.count()).toBe(0)
    await search.fill('think')
    await model.waitFor()
    expect(await models.getByRole('button', { name: 'Acme Think' }).count()).toBe(1)
    await models.getByRole('button', { name: '返回推理等级' }).click()
    await effort.waitFor()
    expect(await effort.getByRole('slider').getAttribute('aria-valuetext')).toBe('High')
    await page.keyboard.press('Escape')
    await effort.waitFor({ state: 'detached' })
    expect(await page.getByRole('button', { name: /^选择模型/ }).evaluate(node => node === document.activeElement)).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps both panels operable after narrowing and on a fresh narrow page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning-narrow'))
    await page.setViewportSize({ width: 375, height: 812 })
    await expect.poll(() => page.locator('[data-sidebar-collapsed]').getAttribute('data-sidebar-collapsed')).toBe('true')
    await expect.poll(async () => (await page.locator('#dsh-layout-sidebar').boundingBox())?.width ?? 375)
      .toBeLessThanOrEqual(56)
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    const effort = page.getByRole('dialog', { name: '推理等级与当前模型' })
    await effort.waitFor()
    await expect.poll(() => effort.getAttribute('aria-busy')).toBe('false')
    const bounds = await effort.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    const slider = effort.getByRole('slider', { name: '调整推理等级' })
    expect(await slider.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    })).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-strength-375.png'), fullPage: false })
    }
    await effort.getByRole('button', { name: /当前模型\s*Acme Think/ }).click()
    const models = page.getByRole('dialog', { name: '选择模型' })
    await models.waitFor()
    const modelBounds = await models.boundingBox()
    expect(modelBounds).not.toBeNull()
    expect(modelBounds!.x).toBeGreaterThanOrEqual(0)
    expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    expect(await models.getByRole('button', { name: 'Acme Think' }).isVisible()).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-model-browser-375.png'), fullPage: false })
    }
    await page.keyboard.press('Escape')
    await effort.waitFor()
    await page.keyboard.press('Escape')
    await effort.waitFor({ state: 'detached' })
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
      const freshMenu = fresh.getByRole('dialog', { name: '推理等级与当前模型' })
      await expect.poll(() => freshMenu.getAttribute('aria-busy')).toBe('false')
      const first = freshMenu.getByRole('slider', { name: '调整推理等级' })
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

  it('matches the refreshed accessible snapshot', async () => {
    await compareOrRefreshGolden(UI_EXPECTED, effortSnapshot, MODE)
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
