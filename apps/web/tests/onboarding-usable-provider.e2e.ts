// 无密钥浏览器场景：其他可用渠道不再触发 DeepSeek 首次引导；取消添加草稿后，
// 中列渠道与右列详情仍可使用。只经真实设置与凭据 wire 配置，不调用模型。
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
const CREDENTIAL_STEP = '添加一个 API Key 开始使用'

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

  it('dismisses onboarding without losing the independent provider draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-setup-card-cancel'))
    const credentialStep = page.getByRole('dialog', { name: CREDENTIAL_STEP })
    await credentialStep.waitFor({ timeout: 15_000 })
    await credentialStep.getByRole('button', { name: '稍后配置' }).click()
    await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    expect(await settings.getByRole('navigation').getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBe('true')
    const channels = settings.getByRole('complementary', { name: '提供方' })
    const deepSeek = channels.getByRole('button', { name: 'DeepSeek', exact: true })
    await deepSeek.waitFor({ timeout: 10_000 })
    expect(await deepSeek.getAttribute('aria-current')).toBe('true')
    const setupKey = settings.getByRole('textbox', { name: 'API 密钥', exact: true })
    await setupKey.waitFor({ timeout: 10_000 })

    const add = channels.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const pick = settings.getByRole('main').getByRole('combobox', { name: '提供方' })
    await pick.waitFor({ timeout: 10_000 })
    await pick.selectOption('minimax-cn')
    expect(await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(1)

    // 取消右列草稿不关闭整个设置对话框，也不抹去中列的 DeepSeek 渠道。
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    expect(await pick.count()).toBe(0)
    await deepSeek.waitFor({ timeout: 10_000 })
    await setupKey.waitFor({ timeout: 10_000 })
    const dismissed = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DISMISSED_EXPECTED, dismissed, MODE)

    await add.click()
    await pick.selectOption('minimax-cn')
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor({ timeout: 10_000 })

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stops prompting for DeepSeek once the other provider can serve requests', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    // 只有 minimax-cn 可用，DeepSeek 仍无凭据。
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // 已有其他可用渠道时，空白会话重载也不应重新出现首次引导。
    await expect.poll(
      async () => page.getByRole('dialog', { name: CREDENTIAL_STEP }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    // 模型分区保留 DeepSeek 渠道行，未配置密钥也不会重新出现引导弹窗。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    const deepSeek = settings.getByRole('complementary', { name: '提供方' }).getByRole('button', { name: 'DeepSeek', exact: true })
    await deepSeek.waitFor({ timeout: 10_000 })
    await deepSeek.click()
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('dialog', { name: CREDENTIAL_STEP }).count()).toBe(0)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['dismissed.expected.md'])
  })
})
