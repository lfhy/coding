// 无密钥浏览器场景：首次引导在同一弹窗中配置 DeepSeek 并选定默认模型；
// 凭据写入隔离目录，渠道详情继续编辑端点和逐模型能力，不触发模型请求。
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/onboarding-deepseek-config', import.meta.url))
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const MODELS_CARD_EXPECTED = join(SNAPSHOT_DIR, 'models-card.expected.md')
const MODE = webSnapshotMode()
const ONBOARDING_TITLE = '配置模型，开始使用'

describe.skipIf(MODE === 'record')('web e2e: first-run DeepSeek credential setup', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, localePreference: null })
    // 独立 Home 的旧默认不可用，要求用户明确选定当前目录中的可启动模型。
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'unavailable-e2e', model: 'missing-model',
    })
    browser = await chromium.launch()
    // 不预设 Host 语言偏好，固定中文浏览器语言以覆盖中文界面。
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('requires a usable default model after storing the key and provider settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    const onboarding = page.getByRole('dialog', { name: ONBOARDING_TITLE })
    await onboarding.waitFor({ timeout: 15_000 })
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toBe('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    const introChannels = onboarding.getByRole('complementary', { name: '提供方' })
    await introChannels.getByRole('button', { name: /^DeepSeek/ }).waitFor({ timeout: 10_000 })
    const keyInput = onboarding.getByLabel('API 密钥', { exact: true })
    await keyInput.waitFor({ timeout: 10_000 })
    const initial = await captureStableAria(page, '[role="dialog"][aria-label="配置模型，开始使用"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MISSING_EXPECTED, initial, MODE)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-deepseek-missing.png') })
    }

    const start = onboarding.getByRole('button', { name: '开始使用' })
    const defaultModel = onboarding.getByRole('combobox', { name: '默认模型' })
    expect(await start.isDisabled()).toBe(true)
    expect(await defaultModel.isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    expect(await onboarding.count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await onboarding.getByLabel('API 地址', { exact: true }).fill('https://gateway.example/v1')
    await onboarding.getByRole('button', { name: '模型设置 2' }).click()
    const onboardingCard = page.getByRole('dialog', { name: '模型设置 2' })
    expect(await onboardingCard.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    expect(await onboarding.count()).toBe(1)
    await onboardingCard.getByLabel('最大输出 token 2').fill('32K')
    await onboardingCard.getByRole('button', { name: '保存', exact: true }).click()
    await onboardingCard.waitFor({ state: 'detached' })
    const secret = `dsh_onboarding_${randomBytes(12).toString('hex')}`
    await keyInput.fill(secret)
    await onboarding.getByRole('button', { name: '保存', exact: true }).click()
    await introChannels.getByRole('button', { name: 'DeepSeek 已配置' }).waitFor({ timeout: 15_000 })
    expect(await onboarding.count()).toBe(1)
    expect(await start.isDisabled()).toBe(true)
    await expect.poll(() => defaultModel.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1)

    const stored = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(stored.includes(`DEEPSEEK_API_KEY: ${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    const configuredSettings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(configuredSettings).toContain('baseURL: https://gateway.example/v1')
    expect(configuredSettings).toContain('maxTokens: 32000')
    expect(configuredSettings).toContain('provider: unavailable-e2e')

    await defaultModel.selectOption('deepseek-official\u0000deepseek-v4-pro')
    expect(await start.isEnabled()).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-deepseek-ready.png') })
    }
    await start.click()
    await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    const selectedSettings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(selectedSettings).toContain('agent-default-model:')
    expect(selectedSettings).toContain('provider: deepseek-official')
    expect(selectedSettings).toContain('model: deepseek-v4-pro')

    // 普通设置保留三列；欢迎弹窗不曾叠出第二个设置模态框。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    expect(await settings.getByRole('navigation').getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBe('true')
    const channels = settings.getByRole('complementary', { name: '提供方' })
    const deepSeekChannel = channels.getByRole('button', { name: /^DeepSeek/ })
    await deepSeekChannel.waitFor({ timeout: 10_000 })
    await deepSeekChannel.click()
    const configuredInput = settings.getByLabel('API 密钥', { exact: true })
    await configuredInput.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => configuredInput.getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe('已配置——输入新值可替换')
    await settings.getByRole('navigation').getByRole('button', { name: '图片识别 Fallback' }).click()
    await settings.getByRole('region', { name: '视觉理解工具' }).waitFor({ timeout: 10_000 })
    expect(await settings.getByRole('navigation').getByRole('button', { name: '图片识别 Fallback' }).getAttribute('aria-current')).toBe('true')
    await settings.getByRole('navigation').getByRole('button', { name: '模型' }).click()
    await settings.getByRole('complementary', { name: '提供方' }).getByRole('button', { name: /^DeepSeek/ }).click()
    await configuredInput.waitFor({ timeout: 10_000 })

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: ONBOARDING_TITLE }).count()).toBe(0)

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('blocks input without painting takeover chrome until a configured reload is resolved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-configured-reload'))
    // 目录尚未确认默认模型时禁止输入，但已有配置的用户不应看到弹窗闪现。
    // 初始化脚本会在后续导航继续采样；本文件之后没有应当出现引导层的场景。
    await page.addInitScript(() => {
      const sightings: string[] = []
      ;(window as unknown as { __takeoverSightings: string[] }).__takeoverSightings = sightings
      setInterval(() => {
        if (document.querySelector(
          '[role="dialog"][aria-label="配置模型，开始使用"]',
        ) !== null) {
          sightings.push('chrome')
        }
        if (document.getElementById('root')?.inert === true) sightings.push('inert')
      }, 8)
    })
    // 所有尚未发出的设置描述请求都等待释放，避免只延迟第一笔而失去窗口覆盖。
    let released = false
    const heldRoutes: Array<() => void> = []
    const releaseDescribe = (): void => {
      released = true
      for (const resolve of heldRoutes.splice(0)) resolve()
    }
    await page.route('**/api/settings.describe', async (route) => {
      if (!released) await new Promise<void>((resolve) => { heldRoutes.push(resolve) })
      await route.continue()
    })
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'commit' })
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // 设置描述悬而未决期间，工作台虽可见但不能开始会话。
    await page.waitForTimeout(600)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    releaseDescribe()
    await expect.poll(() => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 10_000 }).toBe(false)
    await page.unroute('**/api/settings.describe')
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    const sightings = await page.evaluate(() =>
      (window as unknown as { __takeoverSightings: string[] }).__takeoverSightings)
    expect(sightings).toContain('inert')
    expect(sightings).not.toContain('chrome')
    expect(await page.getByRole('dialog', { name: ONBOARDING_TITLE }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('configures arbitrary DeepSeek models and prompts after the selected model is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-models'))
    // 凭据场景在保存后重载，此处重新打开设置模态框。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    const deepSeekChannel = settings.getByRole('complementary', { name: '提供方' }).getByRole('button', { name: /^DeepSeek/ })
    await deepSeekChannel.waitFor({ timeout: 10_000 })
    await deepSeekChannel.click()
    await settings.getByRole('button', { name: /删除模型/ }).first().click()
    await settings.getByRole('button', { name: '添加模型' }).click()
    const customModelId = settings.getByLabel('模型 ID 2')
    await customModelId.fill('private-preview')
    await settings.getByLabel('模型名称 2').fill('Private Preview')
    await settings.getByRole('button', { name: '模型设置 2' }).click()
    const privatePreview = page.getByRole('dialog', { name: '模型设置 2' })
    expect(await privatePreview.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    const vision = privatePreview.getByRole('button', { name: '视觉' })
    if (await vision.getAttribute('aria-pressed') !== 'true') await vision.click()
    const reasoning = privatePreview.getByRole('button', { name: '推理' })
    if (await reasoning.getAttribute('aria-pressed') !== 'true') await reasoning.click()
    expect(await vision.getAttribute('aria-pressed')).toBe('true')
    expect(await reasoning.getAttribute('aria-pressed')).toBe('true')
    const levels = privatePreview.getByRole('button', { name: /^思考档位:/ })
    expect(await levels.getAttribute('aria-haspopup')).toBe('menu')
    await levels.click()
    const levelMenu = page.getByRole('menu')
    const max = levelMenu.getByRole('menuitemcheckbox', { name: 'max' })
    expect(await max.getAttribute('aria-checked')).toBe('true')
    await max.click()
    expect(await max.getAttribute('aria-checked')).toBe('false')
    expect(await levelMenu.getByRole('menuitemcheckbox', { name: '无' }).getAttribute('aria-checked')).toBe('true')
    expect(await levelMenu.getByRole('menuitemcheckbox', { name: 'high', exact: true }).getAttribute('aria-checked'))
      .toBe('true')
    await page.keyboard.press('Escape')
    await privatePreview.getByLabel('上下文窗口 2').fill('131072')
    await privatePreview.getByLabel('最大输出 token 2').fill('64K')

    const modelEditor = await captureStableAria(page, '[role="dialog"][aria-modal="true"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelEditor, MODE)
    const modelCard = await captureStableAria(page, '[role="dialog"][aria-label="模型设置 2"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_CARD_EXPECTED, modelCard, MODE)
    await privatePreview.getByRole('button', { name: '保存', exact: true }).click()
    await privatePreview.waitFor({ state: 'detached' })
    const settingsPath = join(scaffold.harnessHome, 'settings.yaml')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('id: private-preview')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => readFile(settingsPath, 'utf8'), { timeout: 15_000 }).toContain('id: private-preview')
    const savedSettings = await readFile(settingsPath, 'utf8')
    expect(savedSettings).toContain('id: deepseek-v4-pro')
    expect(savedSettings).toContain('id: private-preview')
    expect(savedSettings).toContain('name: Private Preview')
    expect(savedSettings).toContain('contextWindow: 131072')
    expect(savedSettings).toContain('maxTokens: 64000')
    expect(savedSettings).toContain('inputModalities:')
    expect(savedSettings).toContain('- image')
    expect(savedSettings).toContain('reasoningEfforts:')
    expect(savedSettings).toContain('- high')
    expect(savedSettings).not.toContain('  - max')
    expect(savedSettings).not.toMatch(/^\s*- id: deepseek-v4-flash$/m)

    await page.keyboard.press('Escape')
    // scaffold 启动时没有工作区，连接工作区后才能看到输入框中的模型入口。
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'model-fallback-e2e')

    const modelTrigger = page.getByRole('button', { name: /^选择模型/ })
    await modelTrigger.waitFor({ timeout: 10_000 })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: 'DeepSeek' }).click()
    expect(await page.getByText('deepseek-v4-flash', { exact: true }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).waitFor({ timeout: 10_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['missing.expected.md', 'models.expected.md', 'models-card.expected.md'],
    )
  })
})

describe.skipIf(MODE === 'record')('web e2e: 375px first-run model setup', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, localePreference: null })
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'unavailable-mobile-e2e', model: 'missing-model',
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('navigates the provider list and completes setup without clipping or blocked controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-mobile-375'))
    const onboarding = page.getByRole('dialog', { name: ONBOARDING_TITLE })
    await onboarding.waitFor({ timeout: 15_000 })
    expect(new URL(page.url()).origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(await page.title()).toBe('Coding')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    const assertLayout = async (): Promise<void> => {
      const bounds = await onboarding.boundingBox()
      if (bounds === null) throw new Error('375px 欢迎弹窗未显示')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
      expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(812)
      expect(await onboarding.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    }
    const assertHit = async (control: Locator): Promise<void> => {
      await control.scrollIntoViewIfNeeded()
      const box = await control.boundingBox()
      if (box === null) throw new Error('375px 欢迎弹窗控件未显示')
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThan(375)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThan(812)
      expect(await control.evaluate((node, at) => {
        const top = document.elementFromPoint(at.x, at.y)
        return top !== null && (top === node || node.contains(top))
      }, point)).toBe(true)
    }

    const channels = onboarding.getByRole('complementary', { name: '提供方' })
    const deepSeek = channels.getByRole('button', { name: 'DeepSeek', exact: true })
    await deepSeek.waitFor({ timeout: 10_000 })
    await assertLayout()
    await assertHit(deepSeek)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-mobile-list-375.png'), fullPage: false })
    }
    await deepSeek.click()

    const detail = onboarding.getByRole('main')
    const back = detail.getByRole('button', { name: '提供方', exact: true })
    await onboarding.getByLabel('API 密钥', { exact: true }).waitFor({ timeout: 10_000 })
    await assertLayout()
    expect(await detail.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    await assertHit(back)
    await back.click()
    await deepSeek.waitFor({ timeout: 10_000 })
    await assertHit(deepSeek)
    await deepSeek.click()

    const key = onboarding.getByLabel('API 密钥', { exact: true })
    const save = detail.getByRole('button', { name: '保存', exact: true })
    await key.fill(`dsh_mobile_${randomBytes(12).toString('hex')}`)
    await assertHit(save)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-mobile-detail-375.png'), fullPage: false })
    }
    await save.click()

    const model = onboarding.getByRole('combobox', { name: '默认模型' })
    const start = onboarding.getByRole('button', { name: '开始使用' })
    await expect.poll(() => model.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1)
    expect(await start.isDisabled()).toBe(true)
    await assertLayout()
    await assertHit(model)
    await model.selectOption('deepseek-official\u0000deepseek-v4-pro')
    expect(await start.isEnabled()).toBe(true)
    await assertHit(start)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'onboarding-mobile-ready-375.png'), fullPage: false })
    }
    await start.click()
    await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    await page.getByRole('textbox', { name: '选择工作区' }).click()
    await page.getByRole('menuitem', { name: '打开文件夹' }).waitFor({ timeout: 10_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
