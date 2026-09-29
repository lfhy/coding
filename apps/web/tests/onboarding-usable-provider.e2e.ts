// 无密钥浏览器场景：在首次引导中创建自定义渠道，选定可用默认模型后退出；
// 取消创建窗口不关闭引导或丢失渠道。只经真实设置与凭据 wire 配置，不调用模型。
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
const CUSTOM_ROUTE = 'e2e-onboarding'
const CUSTOM_MODEL = 'e2e-onboarding-model'
const CUSTOM_KEY = 'sk-e2e-onboarding'

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

  it('keeps onboarding blocking when custom-channel creation is cancelled', async () => {
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

    const add = channels.getByRole('button', { name: '添加渠道', exact: true })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const createDialog = page.getByRole('dialog', { name: '添加渠道', exact: true })
    await createDialog.waitFor({ timeout: 10_000 })
    expect(await createDialog.getAttribute('aria-modal')).toBe('true')
    expect(await page.getByRole('dialog').count()).toBe(2)
    const bounds = await createDialog.boundingBox()
    if (bounds === null) throw new Error('添加渠道表单未显示')
    expect(Math.abs(bounds.x + bounds.width / 2 - 720)).toBeLessThanOrEqual(2)
    expect(Math.abs(bounds.y + bounds.height / 2 - 480)).toBeLessThanOrEqual(2)
    await createDialog.getByRole('textbox', { name: 'Provider ID' }).waitFor()
    await createDialog.getByRole('combobox', { name: 'API 协议' }).waitFor()
    expect(await createDialog.getByRole('button', { name: 'minimax-cn', exact: true }).count()).toBe(0)
    expect(await deepSeek.getAttribute('aria-current')).toBe('true')
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await createDialog.getByRole('button', { name: '取消', exact: true }).click()
    await createDialog.waitFor({ state: 'detached' })
    expect(await onboarding.count()).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    await setupKey.waitFor({ timeout: 10_000 })

    await add.click()
    await createDialog.waitFor()
    await page.keyboard.press('Escape')
    await createDialog.waitFor({ state: 'detached' })
    expect(await onboarding.count()).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    await setupKey.waitFor({ timeout: 10_000 })
    await deepSeek.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    expect(await onboarding.count()).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(1)
    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-provider-cancelled.png') })
    }

    await add.click()
    await createDialog.getByRole('textbox', { name: 'Provider ID' }).fill(CUSTOM_ROUTE)
    await createDialog.getByRole('textbox', { name: '显示名称' }).fill('E2E Gateway')
    await createDialog.getByRole('textbox', { name: 'API 地址' }).fill('https://gateway.example/v1')
    await createDialog.getByRole('textbox', { name: 'API 密钥' }).fill(CUSTOM_KEY)
    await createDialog.getByRole('button', { name: '添加模型' }).click()
    await createDialog.getByRole('textbox', { name: '模型 ID 1' }).fill(CUSTOM_MODEL)
    expect(await createDialog.getByRole('button', { name: '创建渠道', exact: true }).isEnabled()).toBe(true)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('starts only after the custom channel has a model and saves it as the default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const onboarding = page.getByRole('dialog', { name: ONBOARDING_TITLE })
    const createDialog = page.getByRole('dialog', { name: '添加渠道', exact: true })
    await createDialog.getByRole('button', { name: '创建渠道', exact: true }).click()
    await createDialog.waitFor({ state: 'detached', timeout: 15_000 })
    await onboarding.getByRole('complementary', { name: '提供方' })
      .getByRole('button', { name: 'E2E Gateway 已配置' }).waitFor({ timeout: 15_000 })
    await onboarding.getByRole('main').getByRole('heading', { name: 'E2E Gateway' }).waitFor()
    expect(await onboarding.count()).toBe(1)
    const start = onboarding.getByRole('button', { name: '开始使用' })
    expect(await start.isDisabled()).toBe(true)
    const model = onboarding.getByRole('combobox', { name: '默认模型' })
    await expect.poll(() => model.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1)
    const choices = await model.locator('option').evaluateAll(options => options.map(option => ({
      label: option.textContent ?? '', value: (option as HTMLOptionElement).value,
    })))
    const choice = choices.find(option => option.value === `${CUSTOM_ROUTE}\u0000${CUSTOM_MODEL}`)
    expect(choice?.label).toBeTruthy()
    if (choice === undefined) throw new Error('the custom channel model is not usable in onboarding')
    await model.selectOption(choice.value)
    expect(await start.isEnabled()).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-provider-ready.png') })
    }
    await start.click()
    await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    // 只有刚创建的渠道可用，DeepSeek 仍无凭据；默认选项必须属于新路由。
    const settingsDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settingsDocument).toContain(`${CUSTOM_ROUTE}:`)
    expect(settingsDocument).toContain('apiKeyEnv: E2E_ONBOARDING_API_KEY')
    expect(settingsDocument).toContain(`id: ${CUSTOM_MODEL}`)
    expect(settingsDocument).toContain('agent-default-model:')
    expect(settingsDocument).toContain(`provider: ${CUSTOM_ROUTE}`)
    expect(settingsDocument).toContain(`model: ${CUSTOM_MODEL}`)
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain(`E2E_ONBOARDING_API_KEY: ${CUSTOM_KEY}`)
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
