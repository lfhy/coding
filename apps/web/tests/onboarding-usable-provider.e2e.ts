// 无密钥浏览器场景：在首次引导中添加非 DeepSeek 渠道，保存可用默认模型后退出；
// 取消添加草稿不关闭引导或丢失渠道。只经真实设置与凭据 wire 配置，不调用模型。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-usable-provider', import.meta.url))
const DISMISSED_EXPECTED = join(SNAPSHOT_DIR, 'dismissed.expected.md')
const MODE = webSnapshotMode()
const ONBOARDING_TITLE = '配置模型，开始使用'

describe.skipIf(MODE === 'record')('web e2e: another usable provider ends first-run onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, localePreference: null })
    browser = await chromium.launch()
    // 不预设 Host 语言偏好，固定中文浏览器语言以覆盖中文界面。
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps one onboarding modal while a provider draft is cancelled', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-setup-card-cancel'))
    const onboarding = page.getByRole('dialog', { name: ONBOARDING_TITLE })
    await onboarding.waitFor({ timeout: 15_000 })
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    expect(await onboarding.getByRole('button', { name: '开始使用' }).isDisabled()).toBe(true)
    const channels = onboarding.getByRole('complementary', { name: '提供方' })
    const deepSeek = channels.getByRole('button', { name: 'DeepSeek', exact: true })
    await deepSeek.waitFor({ timeout: 10_000 })
    expect(await deepSeek.getAttribute('aria-current')).toBe('true')
    const setupKey = onboarding.getByRole('textbox', { name: 'API 密钥', exact: true })
    await setupKey.waitFor({ timeout: 10_000 })

    const add = channels.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = onboarding.getByRole('main').getByRole('combobox', { name: '提供方' })
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    expect(await onboarding.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(1)

    // 取消右列草稿与 ESC 都不能解除引导；DeepSeek 渠道仍留在左列。
    await onboarding.getByRole('button', { name: '取消', exact: true }).click()
    expect(await pick.count()).toBe(0)
    await deepSeek.waitFor({ timeout: 10_000 })
    await setupKey.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    expect(await onboarding.count()).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(1)
    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-provider-cancelled.png') })
    }

    await add.click()
    await pick.selectOption('minimax-cn')
    await onboarding.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor({ timeout: 10_000 })

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('starts only after the other provider has a model and saves it as the default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const onboarding = page.getByRole('dialog', { name: ONBOARDING_TITLE })
    await onboarding.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await onboarding.getByRole('button', { name: '保存', exact: true }).click()
    await onboarding.getByRole('complementary', { name: '提供方' })
      .getByRole('button', { name: 'minimax-cn 已配置' }).waitFor({ timeout: 15_000 })
    await onboarding.getByRole('main').getByRole('heading', { name: 'minimax-cn' }).waitFor()
    await onboarding.getByText('已保存 minimax-cn。', { exact: true }).waitFor()
    expect(await onboarding.count()).toBe(1)
    const start = onboarding.getByRole('button', { name: '开始使用' })
    expect(await start.isDisabled()).toBe(true)
    const model = onboarding.getByRole('combobox', { name: '默认模型' })
    await expect.poll(() => model.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1)
    const choices = await model.locator('option').evaluateAll(options => options.map(option => ({
      label: option.textContent ?? '', value: (option as HTMLOptionElement).value,
    })))
    const choice = choices.find(option => option.value.startsWith('minimax-cn\u0000'))
    expect(choice?.label).toBeTruthy()
    if (choice === undefined) throw new Error('minimax-cn has no usable model in the onboarding catalog')
    await model.selectOption(choice.value)
    expect(await start.isEnabled()).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-provider-ready.png') })
    }
    await start.click()
    await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    // 只有 minimax-cn 可用，DeepSeek 仍无凭据；默认选项必须属于这条路由。
    const settingsDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settingsDocument).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    expect(settingsDocument).toContain('agent-default-model:')
    expect(settingsDocument).toContain('provider: minimax-cn')
    expect(settingsDocument).toContain(`model: ${choice.value.split('\u0000')[1]}`)
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    await page.addInitScript(() => {
      const sightings: string[] = []
      ;(window as unknown as { __takeoverSightings: string[] }).__takeoverSightings = sightings
      setInterval(() => {
        if (document.querySelector('[role="dialog"][aria-label="配置模型，开始使用"]') !== null) {
          sightings.push('chrome')
        }
        if (document.getElementById('root')?.inert === true) sightings.push('inert')
      }, 8)
    })
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await page.waitForTimeout(400)
    expect(await page.evaluate(() =>
      (window as unknown as { __takeoverSightings: string[] }).__takeoverSightings)).not.toContain('chrome')
    // 有已保存且可用的默认模型时，空白会话重载不应重新出现引导。
    await expect.poll(
      async () => page.getByRole('dialog', { name: ONBOARDING_TITLE }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    // 模型分区保留 DeepSeek 渠道行，未配置密钥也不会重新出现引导弹窗。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    const deepSeek = settings.getByRole('complementary', { name: '提供方' }).getByRole('button', { name: 'DeepSeek', exact: true })
    await deepSeek.waitFor({ timeout: 10_000 })
    await deepSeek.click()
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('dialog', { name: ONBOARDING_TITLE }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['dismissed.expected.md'])
  })
})
