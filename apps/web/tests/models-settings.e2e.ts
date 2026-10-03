// 真实 Web 组合与 HTTP wire 的模型设置回放：全屏设置页中的独立图片识别分区、
// 渠道详情、只写凭据和本机 GET /v1/models 均经 Chromium 操作。
// 不发出模型生成请求；测试路由选 minimax-cn，避免开发者的通用环境密钥遮蔽派生引用。
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-settings', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CUSTOM_MODAL_EXPECTED = join(SNAPSHOT_DIR, 'custom-channel-modal.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const DECLARED_EXPECTED = join(SNAPSHOT_DIR, 'declared.expected.md')
const DECLARED_EDIT_EXPECTED = join(SNAPSHOT_DIR, 'declared-edit.expected.md')
const MODEL_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'model-picker.expected.md')
const NATIVE_DELETE_EXPECTED = join(SNAPSHOT_DIR, 'native-delete.expected.md')
const DELETE_EXPECTED = join(SNAPSHOT_DIR, 'delete.expected.md')
const VISION_CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'vision-configured.expected.md')
const MODE = webSnapshotMode()
const STALE_EDITOR_CONFLICT = '这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。'
// import { deriveKeyRef } from '@deepseek-ai/dsh-client-ui-settings-models/src/client/store.ts'
// 浏览器 lane 属于 Host 图；仅镜像渠道 ID 到凭据引用的规则，避免引入 Client 工程。
const channelKeyRef = (route: string): string => `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

describe('web e2e: Models settings page configures a dormant provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let modelServer: Server
  let modelBaseURL: string
  let expandedModelListing = false
  let declaredRoute = ''
  const modelRequests: { method: string | undefined; path: string | undefined; authorization: string | undefined }[] = []
  const consoleErrors: string[] = []

  const settings = () => page.getByRole('main', { name: '设置', exact: true }).first()
  const providerRail = () => settings().getByRole('complementary', { name: '提供方' })
  const provider = (name: string) => providerRail().getByRole('button').filter({ hasText: name }).first()
  const settingsDocument = () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
  const settingsDocumentIfPresent = async (): Promise<string> => {
    try { return await settingsDocument() } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
  const stableSnapshot = async (selector: string): Promise<string> => {
    const snapshot = (await captureStableAria(page, selector, scaffold.workspaceCwd))
      .replaceAll(modelBaseURL, 'http://127.0.0.1:<mock-port>/v1')
    return declaredRoute.length === 0 ? snapshot : snapshot
      .replaceAll(declaredRoute, 'channel-<generated-id>')
      .replaceAll(channelKeyRef(declaredRoute), 'CHANNEL_GENERATED_ID_API_KEY')
  }
  const screenshot = async (name: string, width: number, height: number, detail: 'channel' | 'vision' = 'channel'): Promise<void> => {
    if (process.env.DSH_SCREENSHOT_DIR === undefined && width !== 375) return
    await page.setViewportSize({ width, height })
    if (width === 375) {
      const dialog = settings()
      const bounds = await dialog.boundingBox()
      if (bounds === null) throw new Error('375px 模型详情未显示')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      expect(bounds.width).toBeGreaterThanOrEqual(width - 32)
      const hit = async (target: Locator, rightEdge = false): Promise<void> => {
        await target.scrollIntoViewIfNeeded()
        const box = await target.boundingBox()
        if (box === null) throw new Error('375px 设置控件未显示')
        const point = { x: rightEdge ? box.x + box.width - 8 : box.x + box.width / 2, y: box.y + box.height / 2 }
        expect(await target.evaluate((node, at) => {
          const top = document.elementFromPoint(at.x, at.y)
          return top !== null && (top === node || node.contains(top))
        }, point)).toBe(true)
      }
      await hit(dialog.getByRole('navigation').getByRole('button', { name: '模型' }))
      if (detail === 'channel') {
        await hit(dialog.getByRole('main').getByRole('button', { name: '提供方' }))
        await hit(dialog.getByRole('textbox', { name: 'API 地址' }), true)
        await hit(dialog.getByRole('button', { name: '保存', exact: true }))
        expect(await dialog.getByRole('main').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      } else {
        const navigation = dialog.getByRole('navigation')
        const region = dialog.getByRole('region', { name: '视觉理解工具' })
        const select = region.getByRole('combobox', { name: '视觉模型' })
        await hit(navigation.getByRole('button', { name: '图片识别 Fallback' }))
        await hit(select, true)
        const [navBox, regionBox] = await Promise.all([navigation.boundingBox(), region.boundingBox()])
        if (navBox === null || regionBox === null) throw new Error('375px 图片识别导航或详情未显示')
        expect(navBox.y + navBox.height).toBeLessThanOrEqual(regionBox.y + 1)
        expect(regionBox.width).toBeGreaterThanOrEqual(280)
        expect(regionBox.x).toBeGreaterThanOrEqual(bounds.x)
        expect(regionBox.x + regionBox.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
        const selected = await select.evaluate((node) => {
          const input = node as HTMLSelectElement
          const style = getComputedStyle(input)
          const canvas = document.createElement('canvas')
          const measure = canvas.getContext('2d')
          if (measure === null) throw new Error('无法测量视觉模型选项宽度')
          measure.font = style.font
          const label = input.selectedOptions[0]?.textContent ?? ''
          const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8
          return { label, fits: measure.measureText(label).width <= available }
        })
        expect(selected).toEqual({ label: 'cerebras / Acme Beta', fits: true })
        expect(await dialog.getByRole('button', { name: '保存', exact: true }).count()).toBe(0)
        expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      }
    }
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, name), fullPage: false })
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
  }

  beforeAll(async () => {
    modelServer = createServer((request, response) => {
      modelRequests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
      })
      response.writeHead(request.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' })
      const data = [
        { id: 'acme-2026-alpha', name: 'Acme Alpha', context_window: 128000, max_output_tokens: 8192 },
        { id: 'acme-2026-beta', name: 'Acme Beta' },
        { id: 'orion-2025-basic', name: 'Orion Basic' },
      ]
      response.end(JSON.stringify({ data: expandedModelListing
        ? [...data, ...Array.from({ length: 28 }, (_, index) => ({
          id: `geom-${2000 + index}-base`, name: `Geometry ${index + 1}`,
        }))]
        : data }))
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model listing has no port')
    modelBaseURL = `http://127.0.0.1:${address.port}/v1`
    // 模型设置要测试未配置的 minimax-cn；另用已就绪的 DeepSeek 路由完成首次引导。
    scaffold = await launchWebScaffold({ localePreference: null, deepSeekMissingCredential: true })
    await scaffold.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'sk-e2e-onboarding-models')
    browser = await chromium.launch()
    // 不预设 Host 语言偏好，固定中文浏览器语言以覆盖中文界面。
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(page.url()).toBe(scaffold.baseUrl + '/')
    expect(await page.title()).not.toBe('')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (modelServer !== undefined) {
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
    }
  })

  it('opens only a centered custom-channel form without exposing built-in routes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-empty'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settings()
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await providerRail().waitFor({ timeout: 10_000 })
    const modelsNav = dialog.getByRole('navigation').getByRole('button', { name: '模型' })
    expect(await modelsNav.getAttribute('aria-current')).toBe('true')
    await provider('DeepSeek').waitFor({ timeout: 10_000 })
    await providerRail().getByRole('button', { name: 'DeepSeek 已配置' }).waitFor({ timeout: 10_000 })
    for (const dormant of ['anthropic', 'openai', 'minimax-cn', 'amazon-bedrock']) {
      expect(await provider(dormant).count()).toBe(0)
    }
    // 已安装但未配置的目录路由不进入可添加列表；唯一入口直接打开自定义表单。
    const add = providerRail().getByRole('button', { name: '添加渠道', exact: true })
    await add.waitFor({ timeout: 10_000 })
    expect(await providerRail().getByRole('button', { name: '添加渠道', exact: true }).count()).toBe(1)
    expect(await providerRail().getByRole('button', { name: '添加提供方' }).count()).toBe(0)
    expect(await providerRail().getByRole('button', { name: '添加自定义提供方' }).count()).toBe(0)
    // 等待设置镜像和自定义协议列表就绪。
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    // 详情编辑器独立读取凭据；渠道徽标就绪不代表密钥占位提示已完成加载。
    await expect.poll(() => dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).getAttribute('placeholder'),
      { timeout: 10_000 }).toBe('已配置——输入新值可替换')
    const createDialog = page.getByRole('dialog', { name: '添加渠道', exact: true })
    const originalSettings = await settingsDocumentIfPresent()
    await compareOrRefreshGolden(EMPTY_EXPECTED, await stableSnapshot('main[aria-labelledby]:has(> div > nav)'), MODE)
    for (const viewport of [{ width: 1536, height: 1024 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport)
      await add.click()
      await createDialog.waitFor({ timeout: 10_000 })
      expect(await createDialog.getAttribute('aria-modal')).toBe('true')
      const bounds = await createDialog.boundingBox()
      if (bounds === null) throw new Error('添加渠道弹窗未显示')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
      expect(await createDialog.getByRole('textbox', { name: 'Provider ID' }).count()).toBe(0)
      const nameInput = createDialog.getByRole('textbox', { name: '渠道名称', exact: true })
      const protocol = createDialog.getByRole('combobox', { name: '上游请求格式', exact: true })
      const url = createDialog.getByRole('textbox', { name: 'API 地址', exact: true })
      const key = createDialog.getByRole('textbox', { name: 'API 密钥', exact: true })
      await nameInput.waitFor()
      await protocol.waitFor()
      expect(await nameInput.evaluate(node => document.activeElement === node)).toBe(true)
      const tabs = createDialog.getByRole('tab')
      expect(await tabs.count()).toBe(2)
      expect(await tabs.allTextContents()).toEqual(['渠道信息', '模型配置'])
      expect(await tabs.nth(0).getAttribute('aria-selected')).toBe('true')
      expect(await tabs.nth(1).getAttribute('aria-selected')).toBe('false')
      const next = createDialog.getByRole('button', { name: '下一步', exact: true })
      expect(await next.isDisabled()).toBe(true)
      expect(await createDialog.getByRole('button', { name: '创建渠道', exact: true }).count()).toBe(0)
      expect(await createDialog.getByRole('button', { name: '添加模型', exact: true }).count()).toBe(0)
      const [protocolBox, urlBox, keyBox] = await Promise.all([protocol.boundingBox(), url.boundingBox(), key.boundingBox()])
      if (protocolBox === null || urlBox === null || keyBox === null) throw new Error('渠道连接控件未显示')
      expect(protocolBox.width).toBeCloseTo(urlBox.width, 0)
      expect(protocolBox.width).toBeCloseTo(keyBox.width, 0)
      expect(protocolBox.x).toBeCloseTo(urlBox.x, 0)
      expect(protocolBox.x).toBeCloseTo(keyBox.x, 0)
      const nameLabel = createDialog.locator('label[for]').filter({ hasText: '渠道名称' }).first()
      expect(await nameLabel.getAttribute('for')).toBe(await nameInput.getAttribute('id'))
      await createDialog.getByRole('textbox', { name: 'API 地址' }).focus()
      await nameLabel.click()
      expect(await nameInput.evaluate(node => document.activeElement === node)).toBe(true)
      expect(await createDialog.getByRole('button', { name: 'anthropic', exact: true }).count()).toBe(0)
      expect(await createDialog.getByRole('button', { name: 'minimax-cn', exact: true }).count()).toBe(0)
      expect(await createDialog.getByRole('button', { name: '添加自定义渠道' }).count()).toBe(0)
      if (viewport.width === 1536) {
        const snapshot = await stableSnapshot('[role="dialog"][aria-label="添加渠道"]')
        await compareOrRefreshGolden(CUSTOM_MODAL_EXPECTED, snapshot, MODE)
      }
      if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
        await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR,
          viewport.width === 375 ? 'models-settings-add-channel-mobile.png'
            : viewport.width === 768 ? 'models-settings-add-channel-tablet.png' : 'models-settings-add-channel-desktop.png') })
        if (viewport.width === 1536) {
          await page.emulateMedia({ colorScheme: 'dark' })
          await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
          await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'models-settings-add-channel-dark.png') })
          await page.emulateMedia({ colorScheme: 'light' })
          await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
        }
      }
      await nameInput.fill('未提交渠道')
      await url.fill('https://draft.example/v1')
      await key.fill('sk-e2e-draft')
      await next.click()
      expect(await tabs.nth(0).getAttribute('aria-selected')).toBe('false')
      expect(await tabs.nth(1).getAttribute('aria-selected')).toBe('true')
      await createDialog.getByRole('button', { name: '添加模型', exact: true }).waitFor()
      expect(await createDialog.getByRole('textbox', { name: 'API 地址', exact: true }).count()).toBe(0)
      expect(await createDialog.getByRole('button', { name: '创建渠道', exact: true }).isDisabled()).toBe(true)
      expect(await settingsDocumentIfPresent()).toBe(originalSettings)
      if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
        await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, `models-settings-add-channel-models-${viewport.width}.png`) })
        if (viewport.width === 1536) {
          await page.emulateMedia({ colorScheme: 'dark' })
          await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
          await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'models-settings-add-channel-models-dark.png') })
          await page.emulateMedia({ colorScheme: 'light' })
          await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
        }
      }
      await createDialog.getByRole('button', { name: '上一步', exact: true }).click()
      expect(await nameInput.inputValue()).toBe('未提交渠道')
      expect(await url.inputValue()).toBe('https://draft.example/v1')
      expect(await key.inputValue()).toBe('sk-e2e-draft')
      await next.focus()
      await page.keyboard.press('Enter')
      await createDialog.getByRole('button', { name: '添加模型', exact: true }).click()
      await createDialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('draft-model')
      await createDialog.getByRole('button', { name: '上一步', exact: true }).click()
      await next.click()
      expect(await createDialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).inputValue()).toBe('draft-model')
      expect(await settingsDocumentIfPresent()).toBe(originalSettings)
      if (viewport.width === 375) await page.keyboard.press('Escape')
      else await createDialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect.poll(() => createDialog.count()).toBe(0)
      expect(await provider('DeepSeek').getAttribute('aria-current')).toBe('true')
      expect(await settingsDocumentIfPresent()).toBe(originalSettings)
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
  }, 60_000)

  it('refuses a key no HTTP header can carry before anything is written', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-illegal-key'))
    // 内置路由只能由外部配置或已有 profile 出现，测试夹具据此准备后续编辑流程。
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: { 'minimax-cn': {} },
    })
    const dialog = settings()
    await dialog.getByRole('navigation').getByRole('button', { name: '通用设置', exact: true }).click()
    await dialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
    await expect.poll(() => provider('minimax-cn').count(), { timeout: 10_000 }).toBe(1)
    await provider('minimax-cn').click()
    await dialog.getByRole('main').getByRole('heading', { name: 'minimax-cn', exact: true }).waitFor()
    const key = dialog.getByLabel('API 密钥')
    const save = dialog.getByRole('button', { name: '保存', exact: true })

    // 无法进入 HTTP Header 的密钥须由表单指明错误字段，避免保存后首轮请求才触发 ByteString 错误。
    await key.fill('sk-\u{1F600}minimax')
    await dialog.getByText('该 API 密钥格式错误，请检查。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(false)

    // 清空输入恢复提交能力：空字段表示保留已存密钥，不妨碍编辑其他设置。
    await key.fill('')
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await dialog.getByText('该 API 密钥格式错误，请检查。').count()).toBe(0)
  }, 60_000)

  it('retains a reference-free provider-native profile when saving a blank key', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-auth'))
    const dialog = settings()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await provider('minimax-cn').waitFor({ timeout: 10_000 })
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('img', { name: 'API 密钥已配置' }).count()).toBe(0)
    expect(await dialog.getByRole('img', { name: 'API 密钥缺失' }).count()).toBe(0)
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('minimax-cn: {}')
    expect(document).not.toContain('MINIMAX_CN_API_KEY')
  }, 60_000)

  it('describes reference-free deletion without claiming a credential exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-delete'))
    const settingsDialog = settings()
    await settingsDialog.getByRole('button', { name: '删除', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '删除 minimax-cn？' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="删除 minimax-cn？"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(NATIVE_DELETE_EXPECTED, snapshot, MODE)
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
  }, 60_000)

  it('keeps a configured channel editable when its credential is missing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-missing-credential'))
    // 固定缺失引用，而非依赖开发机的环境密钥；该 profile 此时不能注册可用路由。
    const missingRef = credentialRef('DSH_E2E_MISSING_MINIMAX_CREDENTIAL')
    const missingDescribe = page.waitForRequest(request =>
      request.url().endsWith('/api/credentials.describe') && request.postData()?.includes(missingRef) === true,
    { timeout: 10_000 })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: { 'minimax-cn': { apiKeyEnv: missingRef } },
    })
    await missingDescribe
    await expect.poll(async () => scaffold.ctx.credentials.describe(missingRef))
      .toMatchObject({ configured: false })
    const dialog = settings()
    // 外部写入后重新挂载编辑器，使用更新后的设置修订号。
    await dialog.getByRole('navigation').getByRole('button', { name: '通用设置', exact: true }).click()
    await dialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
    await expect.poll(() => provider('minimax-cn').count(), { timeout: 10_000 }).toBe(1)
    await provider('minimax-cn').click()
    await dialog.getByRole('main').getByRole('heading', { name: 'minimax-cn', exact: true }).waitFor()
    const key = dialog.getByRole('textbox', { name: 'API 密钥', exact: true })
    await expect.poll(() => key.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await key.inputValue()).toBe('')
    expect(await dialog.getByRole('button', { name: '保存', exact: true }).isEnabled()).toBe(true)
    expect(await dialog.getByRole('button', { name: '删除', exact: true }).isVisible()).toBe(true)
    const restoredDescribe = page.waitForRequest(request =>
      request.url().endsWith('/api/credentials.describe') && request.postData()?.includes('MINIMAX_CN_API_KEY') === true,
    { timeout: 10_000 })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' } },
    })
    await restoredDescribe
    await dialog.getByRole('navigation').getByRole('button', { name: '通用设置', exact: true }).click()
    await dialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
  }, 60_000)

  it('stores the key under the derived reference and keeps the route live', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-add'))
    const dialog = settings()
    await provider('minimax-cn').click()
    await dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The profile lands in settings.yaml with only the derived reference, the
    // key value lands in the harness home's .credentials.yaml, the dormant route
    // registers, and the topology frame invalidates the page into the row.
    await dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText(STALE_EDITOR_CONFLICT).count()).toBe(0)
    await expect.poll(async () => (await provider('minimax-cn').textContent())?.includes('已配置'), { timeout: 10_000 }).toBe(true)
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('minimax-cn:')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    expect(document).not.toContain('sk-e2e-minimax')
    const credentialFile = join(scaffold.harnessHome, '.credentials.yaml')
    await expect.poll(
      async () => readFile(credentialFile, 'utf8').catch(() => ''),
      { timeout: 10_000 },
    ).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(await page.content()).not.toContain('sk-e2e-minimax')
  }, 60_000)

  it('applies a customized-settings field as a merge patch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-customized'))
    const dialog = settings()
    await provider('minimax-cn').click()
    const url = dialog.getByLabel('API 地址')
    await url.waitFor({ timeout: 10_000 })
    await url.fill('https://gateway.minimax.example/v1')
    expect(await settingsDocument()).not.toContain('https://gateway.minimax.example/v1')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    // The persistent detail editor is reset after Apply, while the saved URL
    // remains visible beside the write-only credential field.
    await expect.poll(async () => url.inputValue(), { timeout: 10_000 }).toBe('https://gateway.minimax.example/v1')
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText(STALE_EDITOR_CONFLICT).count()).toBe(0)
    await dialog.getByRole('button', { name: '保存', exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('baseURL: https://gateway.minimax.example/v1')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const snapshot = await stableSnapshot('main[aria-labelledby]:has(> div > nav)')
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    await screenshot('models-settings-desktop.png', 1876, 1472)
    await screenshot('models-settings-reference.png', 1536, 1024)
    await screenshot('models-settings-mobile.png', 375, 812)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('fetches a real model listing and imports grouped candidates into an unsaved draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-picker'))
    const settingsDialog = settings()
    // minimax-cn 使用 anthropic-messages；夹具预置 cerebras 后仍在界面编辑
    // 密钥和本机 mock 地址，验证 OpenAI 兼容渠道的真实 GET /models。
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: { cerebras: {} },
    })
    await settingsDialog.getByRole('navigation').getByRole('button', { name: '通用设置', exact: true }).click()
    await settingsDialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
    await expect.poll(() => provider('cerebras').count(), { timeout: 10_000 }).toBe(1)
    await provider('cerebras').click()
    await settingsDialog.getByRole('main').getByRole('heading', { name: 'cerebras', exact: true }).waitFor()
    await settingsDialog.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-cerebras')
    await settingsDialog.getByRole('textbox', { name: 'API 地址' }).fill(modelBaseURL)
    await settingsDialog.getByRole('button', { name: '保存', exact: true }).click()
    await settingsDialog.getByText('已保存 cerebras。', { exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(settingsDocument, { timeout: 10_000 }).toContain(`baseURL: ${modelBaseURL}`)
    await provider('cerebras').waitFor({ timeout: 10_000 })
    const searchProviders = providerRail().getByRole('textbox', { name: '搜索模型平台…' })
    await searchProviders.fill('cere')
    expect(await providerRail().getByRole('button').filter({ hasText: 'minimax-cn' }).count()).toBe(0)
    await provider('cerebras').click()
    await settingsDialog.getByRole('heading', { name: 'cerebras' }).waitFor()
    expect(await settingsDialog.getByRole('textbox', { name: 'API 地址' }).inputValue()).toBe(modelBaseURL)
    await searchProviders.fill('')
    const documentBefore = await settingsDocument()
    await settingsDialog.getByRole('button', { name: '获取可用模型' }).click()

    const picker = page.getByRole('dialog', { name: 'cerebras 模型目录' })
    await picker.waitFor({ timeout: 10_000 })
    expect(modelRequests).toEqual([{ method: 'GET', path: '/v1/models', authorization: 'Bearer sk-e2e-cerebras' }])
    const boxes = picker.getByRole('checkbox')
    const count = await boxes.count()
    expect(count).toBe(3)
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => false),
    )

    await picker.getByRole('button', { name: '全选' }).click()
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )
    await picker.getByRole('button', { name: '取消全选' }).click()
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => false),
    )
    await picker.getByRole('button', { name: '全选' }).waitFor()
    const snapshot = await stableSnapshot('[role="dialog"][aria-label="cerebras 模型目录"]')
    await compareOrRefreshGolden(MODEL_PICKER_EXPECTED, snapshot, MODE)
    await screenshot('models-settings-picker.png', 1698, 1234)

    await picker.getByRole('button', { name: '全选' }).click()
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )
    await picker.getByRole('textbox', { name: '搜索模型 ID 或名称' }).fill('acme-2026')
    expect(await boxes.count()).toBe(2)
    await picker.getByRole('button', { name: '导入模型家族 acme-2026' }).click()
    const ids = settingsDialog.getByRole('textbox', { name: /^模型 ID \d+$/ })
    await expect.poll(async () => ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .toContain('acme-2026-alpha')
    expect(await ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .toContain('acme-2026-beta')
    expect(await settingsDocument()).toBe(documentBefore)
    await picker.getByRole('textbox', { name: '搜索模型 ID 或名称' }).fill('orion')
    await picker.getByRole('button', { name: '添加模型 orion-2025-basic' }).click()
    await picker.getByRole('button', { name: '取消', exact: true }).click()
    expect(await settingsDocument()).toBe(documentBefore)

    const importedIndex = (await ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .indexOf('acme-2026-alpha') + 1
    expect(importedIndex).toBeGreaterThan(0)
    const firstTrigger = settingsDialog.getByRole('button', { name: `模型设置 ${importedIndex}` })
    const firstCard = page.getByRole('dialog', { name: `模型设置 ${importedIndex}` })
    const table = settingsDialog.locator('[class*="modelTableScroller"]')
    const row = firstTrigger.locator('..')
    for (const viewport of [
      { width: 1680, height: 1000 }, { width: 768, height: 1024 }, { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport)
      await firstTrigger.scrollIntoViewIfNeeded()
      const [beforeTable, beforeRow] = await Promise.all([table.boundingBox(), row.boundingBox()])
      if (beforeTable === null || beforeRow === null) throw new Error('模型目录表格或模型行未显示')
      await firstTrigger.click()
      await firstCard.waitFor()
      expect(await firstTrigger.getAttribute('aria-expanded')).toBe('true')
      expect(await firstTrigger.getAttribute('aria-haspopup')).toBe('dialog')
      expect(await firstCard.evaluate(node => node.closest('[class*="modelTableScroller"]') === null)).toBe(true)
      expect(await firstCard.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
      expect(await table.boundingBox()).toEqual(beforeTable)
      expect(await row.boundingBox()).toEqual(beforeRow)
      const bounds = await firstCard.boundingBox()
      if (bounds === null) throw new Error('独立模型设置窗口未显示')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1)
      expect(await firstCard.getAttribute('aria-modal')).toBe('true')
      const levels = firstCard.getByRole('button', { name: /^思考档位:/ })
      await levels.click()
      expect(await table.boundingBox()).toEqual(beforeTable)
      expect(await row.boundingBox()).toEqual(beforeRow)
      const menu = page.getByRole('menu')
      expect(await firstCard.evaluate(node => node.contains(document.querySelector('[role="menu"]')))).toBe(true)
      const menuBounds = await menu.boundingBox()
      if (menuBounds === null) throw new Error('思考档位菜单未显示')
      expect(menuBounds.x).toBeGreaterThanOrEqual(0)
      expect(menuBounds.y).toBeGreaterThanOrEqual(0)
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height + 1)
      expect(await menu.getByRole('menuitemcheckbox', { name: 'high', exact: true }).getAttribute('aria-checked')).toBe('true')
      expect(await menu.evaluate(node => ({ role: document.activeElement?.getAttribute('role'),
        inside: node.contains(document.activeElement), label: document.activeElement?.getAttribute('aria-label') })))
        .toEqual({ role: 'menuitemcheckbox', inside: true, label: null })
      await page.keyboard.press('ArrowDown')
      expect(await menu.evaluate(node => node.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Home')
      expect(await menu.getByRole('menuitemcheckbox', { name: '无' }).evaluate(node => document.activeElement === node))
        .toBe(true)
      await expect.poll(async () => {
        const box = await firstCard.boundingBox()
        return box === null ? Number.POSITIVE_INFINITY : box.y + box.height
      }).toBeLessThanOrEqual(viewport.height + 1)
      if (viewport.width === 375) {
        for (const level of ['minimal', 'medium', 'xhigh']) {
          await menu.getByRole('menuitemcheckbox', { name: level }).click()
        }
        await expect.poll(async () => {
          const [triggerBox, listBox] = await Promise.all([levels.boundingBox(), menu.boundingBox()])
          if (triggerBox === null || listBox === null) return Number.NEGATIVE_INFINITY
          return listBox.y - (triggerBox.y + triggerBox.height)
        }).toBeGreaterThanOrEqual(3)
      }
      if (viewport.width === 375 && process.env.DSH_SCREENSHOT_DIR !== undefined) {
        await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'models-settings-popover-mobile.png') })
      }
      if (viewport.width === 375) {
        for (const name of ['取消', '保存']) {
          const action = firstCard.getByRole('button', { name, exact: true })
          await action.scrollIntoViewIfNeeded()
          const box = await action.boundingBox()
          if (box === null) throw new Error(`375px 模型设置${name}按钮未显示`)
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
          expect(await action.evaluate((node) => {
            const box = node.getBoundingClientRect()
            const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            return top !== null && (top === node || node.contains(top))
          })).toBe(true)
        }
      }
      await page.keyboard.press('Escape')
      expect(await firstCard.isVisible()).toBe(true)
      const capacity = firstCard.getByRole('textbox', { name: `上下文窗口 ${importedIndex}` })
      await capacity.scrollIntoViewIfNeeded()
      expect(await capacity.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node
      })).toBe(true)
      const cardVision = firstCard.getByRole('button', { name: '视觉', exact: true })
      const initialVision = await cardVision.getAttribute('aria-pressed')
      await cardVision.click()
      expect(await cardVision.getAttribute('aria-pressed')).toBe(initialVision === 'true' ? 'false' : 'true')
      await cardVision.click()
      expect(await cardVision.getAttribute('aria-pressed')).toBe(initialVision)
      expect(await firstCard.evaluate(node => getComputedStyle(node.parentElement as Element).position)).toBe('fixed')
      await page.keyboard.press('Escape')
      await expect.poll(() => firstCard.count()).toBe(0)
      expect(await settingsDialog.isVisible()).toBe(true)
      expect(await firstTrigger.evaluate(node => document.activeElement === node)).toBe(true)
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await firstTrigger.click()
    const vision = firstCard.getByRole('button', { name: '视觉', exact: true })
    const reasoning = firstCard.getByRole('button', { name: '推理', exact: true })
    expect(await vision.getAttribute('aria-pressed')).toBe('true')
    expect(await reasoning.getAttribute('aria-pressed')).toBe('true')
    const levels = firstCard.getByRole('button', { name: /^思考档位:/ })
    expect(await levels.count()).toBe(1)
    expect(await levels.getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByRole('menuitemcheckbox', { name: 'high', exact: true }).count()).toBe(0)
    await levels.click()
    const menu = page.getByRole('menu')
    const high = menu.getByRole('menuitemcheckbox', { name: 'high', exact: true })
    expect(await high.getAttribute('aria-checked')).toBe('true')
    expect(await menu.getByRole('menuitemcheckbox', { name: 'max' }).getAttribute('aria-checked')).toBe('true')
    await high.click()
    expect(await high.getAttribute('aria-checked')).toBe('false')
    await high.click()
    expect(await high.getAttribute('aria-checked')).toBe('true')
    await screenshot('models-settings-reasoning-levels.png', 1536, 1024)
    await page.keyboard.press('Escape')
    expect(await firstCard.isVisible()).toBe(true)
    expect(await levels.getAttribute('aria-expanded')).toBe('false')
    await vision.click()
    await reasoning.click()
    expect(await vision.getAttribute('aria-pressed')).toBe('false')
    expect(await reasoning.getAttribute('aria-pressed')).toBe('false')
    expect(await levels.count()).toBe(0)
    await firstCard.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => firstCard.count()).toBe(0)
    const betaIndex = (await ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .indexOf('acme-2026-beta') + 1
    expect(betaIndex).toBeGreaterThan(0)
    await settingsDialog.getByRole('button', { name: `模型设置 ${betaIndex}` }).click()
    await expect.poll(() => firstCard.count()).toBe(0)
    const betaCard = page.getByRole('dialog', { name: `模型设置 ${betaIndex}` })
    expect(await betaCard.getByRole('button', { name: '视觉', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await betaCard.getByRole('button', { name: '取消', exact: true }).click()
    await firstTrigger.click()
    await firstCard.getByRole('textbox', { name: `上下文窗口 ${importedIndex}` }).fill('256K')
    await firstCard.getByRole('textbox', { name: `最大输出 token ${importedIndex}` }).fill('16K')
    await screenshot('models-settings-expanded-model.png', 1536, 1024)
    expect(await settingsDocument()).toBe(documentBefore)
    await firstCard.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => firstCard.count()).toBe(0)
    await settingsDialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(settingsDocument, { timeout: 10_000 }).toContain('acme-2026-alpha')
    const saved = await settingsDocument()
    expect(saved).toContain('acme-2026-beta')
    expect(saved).toContain('orion-2025-basic')
    expect(saved).toContain('contextWindow: 256000')
    expect(saved).toContain('maxTokens: 16000')
    expect(saved).toContain('reasoningEfforts: false')
    expect(saved).not.toContain('sk-e2e-cerebras')
    await settingsDialog.getByText('已保存 cerebras。', { exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => settingsDialog.getByRole('textbox', { name: /^模型 ID \d+$/ })
      .evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)), { timeout: 10_000 })
      .toEqual(expect.arrayContaining(['acme-2026-alpha', 'acme-2026-beta', 'orion-2025-basic']))
    await screenshot('models-settings-saved-models.png', 1876, 1472)
    await screenshot('models-settings-saved-models-reference.png', 1536, 1024)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await screenshot('models-settings-saved-models-dark.png', 1536, 1024)
    await settingsDialog.getByRole('button', { name: `模型设置 ${betaIndex}` }).click()
    const darkCard = page.getByRole('dialog', { name: `模型设置 ${betaIndex}` })
    await darkCard.getByRole('button', { name: /^思考档位:/ }).click()
    await screenshot('models-settings-reasoning-levels-dark.png', 1536, 1024)
    await page.keyboard.press('Escape')
    await darkCard.getByRole('button', { name: '取消', exact: true }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('discards canceled model edits and applies popup Save only to the provider draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-popup-draft'))
    const dialog = settings()
    const ids = dialog.getByRole('textbox', { name: /^模型 ID \d+$/ })
    const index = (await ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .indexOf('acme-2026-alpha') + 1
    expect(index).toBeGreaterThan(0)
    const trigger = dialog.getByRole('button', { name: `模型设置 ${index}` })
    const card = page.getByRole('dialog', { name: `模型设置 ${index}` })
    const capacity = card.getByRole('textbox', { name: `上下文窗口 ${index}` })
    const documentBefore = await settingsDocument()

    await trigger.click()
    expect(await capacity.inputValue()).toBe('256K')
    await capacity.fill('512K')
    await card.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect(await settingsDocument()).toBe(documentBefore)

    await trigger.click()
    expect(await capacity.inputValue()).toBe('256K')
    await capacity.fill('384K')
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect(await settingsDocument()).toBe(documentBefore)

    await trigger.click()
    expect(await capacity.inputValue()).toBe('384K')
    await capacity.fill('256K')
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect(await settingsDocument()).toBe(documentBefore)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps a long discovered family list scrollable without collapsing rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-picker-geometry'))
    const dialog = settings()
    await provider('cerebras').click()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    expandedModelListing = true
    const picker = page.getByRole('dialog', { name: 'cerebras 模型目录' })
    try {
      await dialog.getByRole('button', { name: '获取可用模型' }).click()
      await picker.waitFor({ timeout: 10_000 })
      const list = picker.locator('ul[class*="candidateList"]')
      const groups = list.locator('li[class*="candidateGroup"]')
      await expect.poll(() => groups.count(), { timeout: 10_000 }).toBe(30)
      const geometry = await list.evaluate(node => ({
        viewport: node.clientHeight,
        content: node.scrollHeight,
      }))
      expect(geometry.content).toBeGreaterThan(geometry.viewport + 500)
      expect(geometry.viewport).toBeGreaterThan(200)
      const first = groups.first()
      const last = groups.last()
      for (const group of [first, last]) {
        const height = await group.evaluate(node => node.getBoundingClientRect().height)
        expect(height).toBeGreaterThanOrEqual(76)
      }
      const lastCheckbox = last.getByRole('checkbox', { name: 'geom-2027-base' })
      const lastLabel = lastCheckbox.locator('..')
      await lastLabel.scrollIntoViewIfNeeded()
      const [listBox, labelBox] = await Promise.all([list.boundingBox(), lastLabel.boundingBox()])
      if (listBox === null || labelBox === null) throw new Error('模型家族滚动区域或末行未显示')
      const center = labelBox.y + labelBox.height / 2
      expect(center).toBeGreaterThanOrEqual(listBox.y)
      expect(center).toBeLessThanOrEqual(listBox.y + listBox.height)
      await lastLabel.click()
      expect(await lastCheckbox.isChecked()).toBe(true)
      expect(await list.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await screenshot('models-settings-picker-many-families.png', 1680, 1000)
    } finally {
      expandedModelListing = false
      if (await picker.isVisible()) await picker.getByRole('button', { name: '取消', exact: true }).click()
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    }
  }, 60_000)

  it('switches to independent image fallback detail and persists a paired visual target', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-vision-fallback'))
    const dialog = settings()
    const modelPanel = await dialog.boundingBox()
    const navigation = dialog.getByRole('navigation')
    const fallback = navigation.getByRole('button', { name: '图片识别 Fallback' })
    expect(await providerRail().getByRole('button', { name: '图片识别 Fallback' }).count()).toBe(0)
    await fallback.click()
    await expect.poll(() => fallback.getAttribute('aria-current')).toBe('true')
    expect(await navigation.getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBeNull()
    const detail = dialog.getByRole('region', { name: '视觉理解工具' })
    await detail.getByRole('heading', { name: '视觉理解工具' }).waitFor()
    expect(await dialog.getByRole('complementary', { name: '提供方' }).count()).toBe(0)
    expect(await dialog.getByRole('heading', { name: 'cerebras' }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '保存', exact: true }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '删除', exact: true }).count()).toBe(0)
    const panel = await dialog.boundingBox()
    if (panel === null) throw new Error('图片识别分区未绘制')
    expect(panel).toEqual(modelPanel)

    const select = detail.getByRole('combobox', { name: '视觉模型' })
    await expect.poll(async () => select.locator('option').allTextContents(), { timeout: 10_000 })
      .toContain('cerebras / Acme Beta')
    expect(await select.inputValue()).toBe('')
    const before = await settingsDocument()
    await select.selectOption(JSON.stringify(['cerebras', 'acme-2026-beta']))
    await expect.poll(async () => select.inputValue(), { timeout: 10_000 })
      .toBe(JSON.stringify(['cerebras', 'acme-2026-beta']))
    await expect.poll(settingsDocument, { timeout: 10_000 }).not.toBe(before)
    const configured = await settingsDocument()
    expect((load(configured) as Record<string, unknown>)['vision-understanding'])
      .toMatchObject({ provider: 'cerebras', model: 'acme-2026-beta' })
    const snapshot = await stableSnapshot('main[aria-labelledby]:has(> div > nav)')
    await compareOrRefreshGolden(VISION_CONFIGURED_EXPECTED, snapshot, MODE)
    await screenshot('models-settings-vision-desktop.png', 1876, 1472, 'vision')
    await screenshot('models-settings-vision-reference.png', 1536, 1024, 'vision')
    await screenshot('models-settings-vision-mobile.png', 375, 812, 'vision')

    await select.selectOption('')
    await expect.poll(async () => select.inputValue(), { timeout: 10_000 }).toBe('')
    await expect.poll(async () => {
      const section = (load(await settingsDocument()) as Record<string, Record<string, unknown>>)['vision-understanding']
      return { provider: section?.['provider'], model: section?.['model'] }
    }, { timeout: 10_000 }).toEqual({ provider: undefined, model: undefined })
    const cleared = await settingsDocument()
    expect((load(cleared) as Record<string, Record<string, unknown>>)['vision-understanding']?.['provider']).toBeUndefined()
    expect((load(cleared) as Record<string, Record<string, unknown>>)['vision-understanding']?.['model']).toBeUndefined()
    await navigation.getByRole('button', { name: '模型' }).click()
    await provider('cerebras').click()
    await dialog.getByRole('main').getByRole('heading', { name: 'cerebras' }).waitFor()
    expect(await navigation.getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBe('true')
    expect(await fallback.getAttribute('aria-current')).toBeNull()
    expect(await detail.count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '保存', exact: true }).isVisible()).toBe(true)
    expect(await dialog.getByRole('button', { name: '删除', exact: true }).isVisible()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('declares a route the adapter does not ship', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declare'))
    const dialog = settings()
    const searchProviders = providerRail().getByRole('textbox', { name: '搜索模型平台…' })
    await searchProviders.fill('openai')
    const add = providerRail().getByRole('button', { name: '添加渠道', exact: true })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    const createDialog = page.getByRole('dialog', { name: '添加渠道', exact: true })
    expect(await createDialog.getByRole('textbox', { name: 'Provider ID' }).count()).toBe(0)
    await createDialog.getByRole('textbox', { name: '渠道名称', exact: true }).fill('Acme Gateway')
    await createDialog.getByLabel('API 地址').fill('https://gateway.acme.example/v1')
    await createDialog.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-acme')
    const beforeCreate = await settingsDocument()
    await createDialog.getByRole('button', { name: '下一步', exact: true }).click()
    expect(await settingsDocument()).toBe(beforeCreate)
    // 推理强度属于单个模型能力，而非整个渠道；composer 中的切换会一并记录所选强度。
    expect(await createDialog.getByLabel('推理强度').count()).toBe(0)
    await createDialog.getByRole('button', { name: '添加模型' }).click()
    await createDialog.getByLabel('模型 ID 1').fill('acme-large')
    await page.setViewportSize({ width: 375, height: 812 })
    const mobileCreate = createDialog.getByRole('button', { name: '创建渠道', exact: true })
    await mobileCreate.scrollIntoViewIfNeeded()
    const mobileAction = await mobileCreate.boundingBox()
    if (mobileAction === null) throw new Error('375px 自定义渠道创建按钮未显示')
    expect(mobileAction.x).toBeGreaterThanOrEqual(0)
    expect(mobileAction.x + mobileAction.width).toBeLessThanOrEqual(375)
    expect(mobileAction.y + mobileAction.height).toBeLessThanOrEqual(812)
    expect(await mobileCreate.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const top = node.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return top === node || node.contains(top)
    })).toBe(true)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'models-settings-add-channel-filled-mobile.png') })
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    const failure = '模拟凭据写入失败'
    let rejectedWrites = 0
    let profileWrites = 0
    await page.route('**/api/settings.mutate', async (route) => {
      const envelope = route.request().postDataJSON() as {
        payload: { ns: string; ops: { op: string; path: string[]; value?: { displayName?: string } }[] }
      }
      const profile = envelope.payload.ops.find(op => op.op === 'set' && op.path[0] === 'providers'
        && op.value?.displayName === 'Acme Gateway')
      if (envelope.payload.ns === 'llm-pi-ai' && profile !== undefined) {
        profileWrites += 1
        declaredRoute = profile.path[1] ?? ''
        expect(declaredRoute).toMatch(/^channel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }
      await route.continue()
    })
    let releaseWrite: (() => void) | undefined
    const credentialGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    await page.route('**/api/credentials.set', async (route) => {
      const envelope = route.request().postDataJSON() as { rpcId: string; payload: { ref: string } }
      expect(declaredRoute).not.toBe('')
      expect(envelope.payload.ref).toBe(channelKeyRef(declaredRoute))
      rejectedWrites += 1
      await credentialGate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: false, error: { code: 'credential-rejected', message: failure, details: { ref: envelope.payload.ref } } },
        }),
      })
    })
    try {
      const create = createDialog.getByRole('button', { name: '创建渠道', exact: true })
      await create.focus()
      expect(await createDialog.evaluate(node => node.contains(node.ownerDocument.activeElement))).toBe(true)
      await create.click()
      await expect.poll(() => rejectedWrites, { timeout: 10_000 }).toBe(1)
      const creating = createDialog.getByRole('button', { name: '创建中…' })
      await creating.waitFor({ timeout: 10_000 })
      expect(await creating.isDisabled()).toBe(true)
      expect(await createDialog.evaluate(node => node.contains(node.ownerDocument.activeElement))).toBe(true)
      for (let step = 0; step < 3; step += 1) {
        await page.keyboard.press('Tab')
        expect(await createDialog.evaluate(node => node.contains(node.ownerDocument.activeElement))).toBe(true)
      }
      releaseWrite?.()
      await createDialog.getByText(failure).waitFor({ timeout: 10_000 })
      const retry = createDialog.getByRole('button', { name: '重试', exact: true })
      await expect.poll(() => retry.isEnabled()).toBe(true)
      expect(await createDialog.getByRole('tab').nth(0).getAttribute('aria-selected')).toBe('true')
      expect(await createDialog.getByRole('textbox', { name: '渠道名称', exact: true }).isDisabled()).toBe(true)
      const key = createDialog.getByRole('textbox', { name: 'API 密钥', exact: true })
      expect(await key.isEnabled()).toBe(true)
      expect(await key.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true)
      await expect.poll(settingsDocument, { timeout: 10_000 }).toContain(`${declaredRoute}:`)
      expect(await settingsDocument()).toContain(`apiKeyEnv: ${channelKeyRef(declaredRoute)}`)
      expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')).not.toContain(channelKeyRef(declaredRoute))
      expect(profileWrites).toBe(1)
      expect(await searchProviders.inputValue()).toBe('openai')
      expect(await provider('Acme Gateway').count()).toBe(0)
    } finally {
      releaseWrite?.()
      await page.unroute('**/api/credentials.set')
    }
    await createDialog.getByRole('button', { name: '重试', exact: true }).click()

    await expect.poll(() => createDialog.count()).toBe(0)
    expect(profileWrites).toBe(1)
    await page.unroute('**/api/settings.mutate')
    await expect.poll(() => searchProviders.inputValue()).toBe('')
    await provider('Acme Gateway').waitFor({ timeout: 10_000 })
    await expect.poll(() => provider('Acme Gateway').getAttribute('aria-current')).toBe('true')
    await dialog.getByRole('main').getByRole('heading', { name: 'Acme Gateway', exact: true }).waitFor()
    await page.setViewportSize({ width: 375, height: 812 })
    await dialog.getByRole('main').getByRole('button', { name: '提供方', exact: true }).click()
    await provider('Acme Gateway').waitFor()
    expect(await provider('Acme Gateway').getAttribute('aria-current')).toBe('true')
    expect(await searchProviders.inputValue()).toBe('')
    await provider('Acme Gateway').click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    await dialog.getByRole('main').getByRole('heading', { name: 'Acme Gateway', exact: true }).waitFor()
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain(`${declaredRoute}:`)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8'))
      .toContain(`${channelKeyRef(declaredRoute)}: sk-e2e-acme`)

    // “自定义”标记取决于适配器目录，而非是否有 profile：新路由不在目录，minimax-cn 在目录。
    await provider('Acme Gateway').click()
    await expect.poll(async () => dialog.getByLabel('上游请求格式').count(), { timeout: 10_000 }).toBe(1)
    expect(await provider('minimax-cn').getByText('自定义').count()).toBe(0)

    const snapshot = await stableSnapshot('main[aria-labelledby]:has(> div > nav)')
    await compareOrRefreshGolden(DECLARED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('reopens the name and protocol a declared route was created with', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declared-identity'))
    const dialog = settings()
    await provider('Acme Gateway').click()
    // 创建草稿填写的名称和协议可直接重开编辑，不需要手改 settings.yaml。
    const protocol = dialog.getByLabel('上游请求格式')
    await protocol.waitFor({ timeout: 10_000 })
    expect(await protocol.inputValue()).toBe('openai-completions')
    const name = dialog.getByLabel('显示名称', { exact: true })
    expect(await name.inputValue()).toBe('Acme Gateway')
    const snapshot = await stableSnapshot('main[aria-labelledby]:has(> div > nav)')
    await compareOrRefreshGolden(DECLARED_EDIT_EXPECTED, snapshot, MODE)

    await protocol.selectOption('anthropic-messages')
    await name.fill('Acme 网关')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => dialog.getByLabel('上游请求格式').inputValue(), { timeout: 10_000 })
      .toBe('anthropic-messages')
    // 协议改动重新解析渠道，名称改动同步刷新目录行；不可服务的 profile 会在写入时拒绝。
    await dialog.getByText('Acme 网关', { exact: true }).first().waitFor({ timeout: 10_000 })
    // 保存结果使用刷新后的名称，身份仍是同一个自动生成的渠道 ID。
    await dialog.getByText(`已保存 Acme 网关 (${declaredRoute})。`, { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('api: anthropic-messages')
    expect(document).toContain('displayName: Acme 网关')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('confirms an identified provider deletion before removing its profile and key', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-delete'))
    const settingsDialog = settings()
    await provider('minimax-cn').click()
    await settingsDialog.getByRole('button', { name: '删除', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '删除 minimax-cn？' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="删除 minimax-cn？"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(DELETE_EXPECTED, snapshot, MODE)

    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('minimax-cn:')
    await settingsDialog.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('dialog', { name: '删除 minimax-cn？' })
      .getByRole('button', { name: '删除 minimax-cn', exact: true }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).not.toContain('minimax-cn:')
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8'))
      .not.toContain('MINIMAX_CN_API_KEY')
    await expect.poll(
      async () => page.getByRole('dialog', { name: '删除 minimax-cn？' }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
  }, 60_000)

  it('keeps DeepSeek channel names identical through live edits and reopening', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-deepseek-name'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settings()
    await dialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
    await provider('DeepSeek').click()
    const assertName = async (name: string): Promise<void> => {
      await expect.poll(() => providerRail().getByRole('button').filter({ hasText: name }).count(), { timeout: 10_000 }).toBe(1)
      await dialog.getByRole('main').getByRole('heading', { name, exact: true }).waitFor({ timeout: 10_000 })
      await expect.poll(() => dialog.getByRole('textbox', { name: '渠道名称', exact: true }).inputValue(), { timeout: 10_000 }).toBe(name)
    }
    await assertName('DeepSeek')
    const customName = '个人 DeepSeek 渠道'
    await dialog.getByRole('textbox', { name: '渠道名称', exact: true }).fill(customName)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await assertName(customName)
    await expect.poll(settingsDocument, { timeout: 10_000 }).toContain(`channelName: ${customName}`)
    expect(await providerRail().getByRole('button', { name: /^DeepSeek(?: 已配置)?$/ }).count()).toBe(0)
    await screenshot('models-settings-deepseek-renamed.png', 1920, 1080)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await dialog.getByRole('navigation').getByRole('button', { name: '模型', exact: true }).click()
    await provider(customName).click()
    await assertName(customName)

    await dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-deepseek-renamed')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await assertName(customName)
    await expect.poll(() => dialog.getByRole('textbox', { name: 'API 密钥', exact: true }).inputValue()).toBe('')
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })
    await assertName(customName)
    const document = load(await settingsDocument()) as Record<string, Record<string, unknown>>
    expect(document['llm-deepseek']?.['channelName']).toBe(customName)
    expect(document['llm-deepseek']?.['apiKeyEnv']).not.toBe(customName)
    expect(document['agent-default-model']).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('DEEPSEEK_API_KEY: sk-e2e-deepseek-renamed')
    expect(credentials).not.toContain(customName)
    expect(await page.content()).not.toContain('sk-e2e-deepseek-renamed')
    expect(await page.locator('body').ariaSnapshot()).not.toContain('sk-e2e-deepseek-renamed')
    expect(consoleErrors.some(line => line.includes('sk-e2e-deepseek-renamed'))).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'configured.expected.md', 'declared-edit.expected.md', 'declared.expected.md',
      'custom-channel-modal.expected.md', 'delete.expected.md', 'empty.expected.md', 'model-picker.expected.md',
      'native-delete.expected.md', 'vision-configured.expected.md',
    ])
  })
})
