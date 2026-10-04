// 手动声明的 reasoningEfforts 进入 composer 的强度滑块；选择经会话 RPC
// 提交并写入 Agent 默认设置。场景不调用模型，无需录制流式 fixture。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
const VISUAL_PROVIDER = 'reference-efforts'
const VISUAL_MODEL = 'astra'

/** 为深色强度面板提供含 Max 与 Ultra 的确切模型目录，不执行网络请求。 */
class ReferenceEffortAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Reference' } }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: VISUAL_MODEL, name: '6 Astra' }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider, id: model, name: '6 Astra',
      reasoning: {
        efforts: ['off', 'minimal', 'low', 'medium', 'max', 'ultra'].map(id => ({
          id: ReasoningEffortId(id), name: id === 'ultra' ? 'Ultra' : id === 'max' ? 'Max' : id,
        })),
        defaultEffort: ReasoningEffortId('ultra'),
      },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('reference effort adapter must not stream in this scenario')
  }
}

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
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([VISUAL_PROVIDER], new ReferenceEffortAdapter()),
      'declared reasoning visual adapter',
    )
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'dark' })
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/session.selectModel')) return
      const envelope = request.postDataJSON() as { payload: Record<string, unknown> }
      selections.push(envelope.payload)
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
    expect(await page.title()).toContain('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers exactly the declared slider levels and records the selected payload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    expect(await trigger.textContent()).toBe('Acme ThinkDefault')
    await trigger.click()
    const effort = page.getByRole('dialog', { name: '推理等级与当前模型' })
    await expect.poll(() => effort.getAttribute('aria-busy'), { timeout: 10_000 }).toBe('false')
    const slider = effort.getByRole('slider', { name: '调整推理等级' })
    await slider.waitFor()
    expect(await trigger.textContent()).toBe('选择强度')
    expect(await slider.getAttribute('min')).toBe('0')
    expect(await slider.getAttribute('max')).toBe('3')
    expect(await slider.getAttribute('step')).toBe('1')
    expect(await slider.getAttribute('aria-valuetext')).toBe('Default')
    expect(await effort.getByText('Default', { exact: true }).count()).toBe(1)
    expect(await effort.getByText('none', { exact: true }).count()).toBe(0)
    expect(await effort.getByRole('button', { name: /当前模型\s*Acme Think/ }).count()).toBe(1)
    effortSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="推理等级与当前模型"]', scaffold.workspaceCwd)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-strength-desktop.png'), fullPage: false })
    }

    // Default 是独立零档；往右依次提交 off、high，不跳过关闭推理档。
    await slider.focus()
    await slider.press('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('none')
    await effort.getByText('none', { exact: true }).waitFor()
    await expect.poll(() => selections.at(-1), { timeout: 10_000 }).toMatchObject({
      provider: 'acme-gateway', model: 'acme-think', reasoningEffort: 'off',
    })
    await expect.poll(() => effort.getAttribute('aria-busy')).toBe('false')
    await slider.press('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('High')
    await effort.getByText('High', { exact: true }).waitFor()
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
    expect(await page.getByRole('button', { name: /^选择模型，当前/ }).textContent()).toBe('选择强度')
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
    expect(await page.getByRole('button', { name: /^选择模型/ }).textContent()).toBe('Acme ThinkHigh')
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
    expect(await trigger.textContent()).toBe('Acme ThinkHigh')
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

    const fresh = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'dark' })
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

  it('previews the Ultra and Max palettes for an exact model without sending a prompt', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-effort-colors'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.click()
    await page.getByRole('dialog', { name: '推理等级与当前模型' })
      .getByRole('button', { name: /当前模型/ }).click()
    const models = page.getByRole('dialog', { name: '选择模型' })
    await models.getByRole('group', { name: '渠道列表' }).getByRole('button', { name: 'Reference' }).click()
    await models.getByRole('button', { name: '6 Astra' }).click()
    await expect.poll(() => trigger.getAttribute('aria-label')).toContain('推理等级 Ultra')
    expect(await trigger.textContent()).toBe('6 AstraUltra')
    await trigger.click()
    expect(await trigger.textContent()).toBe('选择强度')
    const effort = page.getByRole('dialog', { name: '推理等级与当前模型' })
    const title = effort.locator('strong')
    const slider = effort.getByRole('slider', { name: '调整推理等级' })
    await expect.poll(() => effort.getAttribute('aria-busy')).toBe('false')
    expect(await effort.getByRole('status').count()).toBe(0)
    await expect.poll(() => title.textContent()).toBe('Ultra')
    expect(await title.evaluate(node => getComputedStyle(node).color)).toBe('rgb(179, 86, 249)')
    expect(await effort.locator('[aria-hidden="true"]').first().evaluate(node => getComputedStyle(node).backgroundImage))
      .toContain('linear-gradient')
    expect(await effort.getByRole('button', { name: '当前模型 6 Astra' }).textContent()).toBe('6 Astra')
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-ultra-reference.png'), fullPage: false })
    }

    const bounds = await slider.boundingBox()
    expect(bounds).not.toBeNull()
    const y = bounds!.y + bounds!.height / 2
    await page.mouse.move(bounds!.x + bounds!.width - 14, y)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 14 + (bounds!.width - 28) * 4 / 5, y, { steps: 5 })
    await expect.poll(() => title.textContent()).toBe('Max')
    await expect.poll(() => title.evaluate(node => getComputedStyle(node).color)).toBe('rgb(24, 119, 238)')
    expect(selections.at(-1)?.reasoningEffort).toBe('ultra')
    await page.mouse.up()
    await expect.poll(() => selections.at(-1)?.reasoningEffort).toBe('max')
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-max-reference.png'), fullPage: false })
    }
    await page.keyboard.press('Escape')
    await effort.waitFor({ state: 'detached' })
    expect(await trigger.textContent()).toBe('6 AstraMax')
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await trigger.evaluate((node) => { (node as HTMLElement).blur() })
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'reasoning-collapsed-reference.png'), fullPage: false })
    }
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the refreshed accessible snapshot', async () => {
    await compareOrRefreshGolden(UI_EXPECTED, effortSnapshot, MODE)
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
