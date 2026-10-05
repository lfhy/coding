// 真实 Loader + Host 设置场景：三种搜索来源的独立设置、只写凭据与窄屏控件可达性。
// 全程不调用模型或外网。
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const DEFAULT_REF = credentialRef('DEEPSEEK_SEARCH_API_KEY')
const SEARCH_REF = credentialRef('DSH_SEARCH_SETTINGS_E2E_KEY')
const SEARCH_KEY = 'sk-e2e-search-settings-private'
const ENDPOINT = 'https://search.example.test/anthropic/v1'
const MODEL = 'deepseek-search-e2e'
const DUCKDUCKGO_PROXY = 'http://127.0.0.1:7890'
const DEEPSEEK_PROXY = 'http://127.0.0.1:7891'
const TAVILY_PROXY = 'http://127.0.0.1:7892'
const TAVILY_ENDPOINT = 'https://tavily.example.test'
const TAVILY_REF = credentialRef('TAVILY_API_KEY')
const CUSTOM_TAVILY_REF = credentialRef('DSH_TAVILY_SETTINGS_E2E_KEY')
const TAVILY_KEY = 'tvly-e2e-search-settings-private'

function namespaceSettings(yaml: string, name: string): string {
  const block = yaml.match(new RegExp(`(?:^|\\n)${name}:\\n((?:[ \\t]+[^\\n]*\\n)*)`))
  if (block === null) throw new Error(`设置文档缺少 ${name} 命名空间`)
  return block[1]!
}

describe('web e2e: independent search settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const originalSearchEnvironment = process.env.DEEPSEEK_SEARCH_API_KEY
  const originalTavilyEnvironment = process.env.TAVILY_API_KEY

  beforeAll(async () => {
    // 环境密钥优先于隔离 Home；测试不读取、覆盖或暴露开发者的真实搜索凭据。
    Reflect.deleteProperty(process.env, 'DEEPSEEK_SEARCH_API_KEY')
    Reflect.deleteProperty(process.env, 'TAVILY_API_KEY')
    scaffold = await launchWebScaffold({ localePreference: null })
    await scaffold.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'sk-e2e-search-settings-onboarding')
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      if (originalSearchEnvironment === undefined) Reflect.deleteProperty(process.env, 'DEEPSEEK_SEARCH_API_KEY')
      else process.env.DEEPSEEK_SEARCH_API_KEY = originalSearchEnvironment
      if (originalTavilyEnvironment === undefined) Reflect.deleteProperty(process.env, 'TAVILY_API_KEY')
      else process.env.TAVILY_API_KEY = originalTavilyEnvironment
    }
  })

  it('persists each provider settings and isolated keys without exposing key text', async () => {
    onTestFailed(async () => {
      try { await page?.screenshot({ path: join(tmpdir(), 'dsh-search-settings-failed.png'), fullPage: true }) }
      catch { /* 浏览器关闭后不能让截图失败覆盖原始断言。 */ }
    })
    const settingsPath = join(scaffold.harnessHome, 'settings.yaml')
    const credentialsPath = join(scaffold.harnessHome, '.credentials.yaml')
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    await trigger.click()
    const settingsPage = page.getByRole('main', { name: '设置', exact: true }).first()
    await settingsPage.waitFor({ timeout: 10_000 })
    const nav = settingsPage.getByRole('navigation').getByRole('button', { name: '联网搜索', exact: true })
    await nav.click()
    await expect.poll(() => nav.getAttribute('aria-current')).toBe('true')
    const section = settingsPage.getByRole('region', { name: '联网搜索' })
    await section.getByRole('heading', { name: '联网搜索' }).waitFor({ timeout: 10_000 })
    const duckduckgo = section.getByRole('radio', { name: /DuckDuckGo/ })
    const deepseek = section.getByRole('radio', { name: /DeepSeek 官方/ })
    const tavily = section.getByRole('radio', { name: /Tavily/ })
    const visibleInput = (label: string) => section.getByLabel(label, { exact: true }).and(section.locator('input:visible'))
    const endpoint = visibleInput('接口地址')
    const model = visibleInput('搜索模型')
    const proxy = visibleInput('HTTP 代理地址')
    const keyRef = visibleInput('密钥环境变量名')
    const key = visibleInput('专用搜索密钥')
    await expect.poll(() => duckduckgo.isChecked()).toBe(true)
    expect(await deepseek.isChecked()).toBe(false)
    expect(await tavily.isChecked()).toBe(false)
    await expect.poll(() => scaffold.ctx.credentials.describe(DEFAULT_REF))
      .toMatchObject({ configured: false })
    expect(await endpoint.isVisible()).toBe(false)
    expect(await model.isVisible()).toBe(false)
    expect(await keyRef.isVisible()).toBe(false)
    expect(await key.isVisible()).toBe(false)
    expect(await proxy.isVisible()).toBe(true)
    expect(await section.getByText('免费，无需配置密钥。', { exact: true }).count()).toBe(1)
    await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await proxy.fill(DUCKDUCKGO_PROXY)
    await section.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => namespaceSettings(await readFile(settingsPath, 'utf8'), 'web-search-duckduckgo'))
      .toContain(`proxyURL: ${DUCKDUCKGO_PROXY}`)
    expect(await readFile(settingsPath, 'utf8')).not.toContain('web-search-deepseek:')
    expect(await readFile(settingsPath, 'utf8')).not.toContain('web-search-tavily:')

    await deepseek.focus()
    await deepseek.press('Space')
    await expect.poll(() => deepseek.isChecked(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toMatch(/web:\n\s+searchProvider: deepseek-official/)
    await section.getByText('此引用没有密钥；选用 DeepSeek 官方时搜索不可用。', { exact: true })
      .waitFor({ timeout: 10_000 })
    expect(await proxy.inputValue()).toBe('')
    await endpoint.fill(ENDPOINT)
    await model.fill(MODEL)
    await proxy.fill(DEEPSEEK_PROXY)
    await keyRef.fill(SEARCH_REF)
    await section.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toMatch(/web-search-deepseek:\n(?:\s+[^\n]+\n)*\s+apiKeyEnv: DSH_SEARCH_SETTINGS_E2E_KEY/)
    const configured = await readFile(settingsPath, 'utf8')
    const deepSeekSettings = namespaceSettings(configured, 'web-search-deepseek')
    expect(deepSeekSettings).toContain(`baseURL: ${ENDPOINT}`)
    expect(deepSeekSettings).toContain(`model: ${MODEL}`)
    expect(deepSeekSettings).toContain(`proxyURL: ${DEEPSEEK_PROXY}`)
    expect(namespaceSettings(configured, 'web-search-duckduckgo')).toContain(`proxyURL: ${DUCKDUCKGO_PROXY}`)
    expect(configured).not.toContain(SEARCH_KEY)
    await expect.poll(() => keyRef.inputValue(), { timeout: 10_000 }).toBe(SEARCH_REF)
    await section.getByText('此引用没有密钥；选用 DeepSeek 官方时搜索不可用。', { exact: true })
      .waitFor({ timeout: 10_000 })
    expect(await scaffold.ctx.credentials.describe(SEARCH_REF)).toMatchObject({ configured: false })

    await expect.poll(() => key.isEnabled(), { timeout: 10_000 }).toBe(true)
    await key.fill(SEARCH_KEY)
    await section.getByRole('button', { name: '保存密钥', exact: true }).click()
    await section.getByText('此引用已配置密钥。', { exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => key.inputValue(), { timeout: 10_000 }).toBe('')
    expect(await scaffold.ctx.credentials.describe(SEARCH_REF))
      .toMatchObject({ configured: true, source: 'file', writable: true })
    await expect.poll(async () => readFile(credentialsPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${SEARCH_REF}: ${SEARCH_KEY}`)
    expect(await readFile(settingsPath, 'utf8')).not.toContain(SEARCH_KEY)
    expect(await page.content()).not.toContain(SEARCH_KEY)
    expect(await page.locator('body').ariaSnapshot()).not.toContain(SEARCH_KEY)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'search-settings-deepseek.png') })
    }

    await tavily.click()
    await expect.poll(() => tavily.isChecked(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toMatch(/web:\n\s+searchProvider: tavily/)
    expect(await model.isVisible()).toBe(false)
    expect(await endpoint.inputValue()).toBe('https://api.tavily.com')
    expect(await proxy.inputValue()).toBe('')
    expect(await keyRef.inputValue()).toBe(TAVILY_REF)
    await section.getByText('此引用没有密钥；选用 Tavily 时搜索不可用。', { exact: true })
      .waitFor({ timeout: 10_000 })
    await expect.poll(() => scaffold.ctx.credentials.describe(TAVILY_REF))
      .toMatchObject({ configured: false })

    await endpoint.fill(TAVILY_ENDPOINT)
    await proxy.fill(TAVILY_PROXY)
    await keyRef.fill(CUSTOM_TAVILY_REF)
    await section.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => namespaceSettings(await readFile(settingsPath, 'utf8'), 'web-search-tavily'), { timeout: 10_000 })
      .toContain(`apiKeyEnv: ${CUSTOM_TAVILY_REF}`)
    await keyRef.fill(TAVILY_REF)
    await section.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => namespaceSettings(await readFile(settingsPath, 'utf8'), 'web-search-tavily'), { timeout: 10_000 })
      .toContain(`apiKeyEnv: ${TAVILY_REF}`)
    const withTavily = await readFile(settingsPath, 'utf8')
    const tavilySettings = namespaceSettings(withTavily, 'web-search-tavily')
    expect(tavilySettings).toContain(`baseURL: ${TAVILY_ENDPOINT}`)
    expect(tavilySettings).toContain(`proxyURL: ${TAVILY_PROXY}`)
    expect(tavilySettings).not.toContain('model:')
    expect(namespaceSettings(withTavily, 'web-search-deepseek')).toContain(`proxyURL: ${DEEPSEEK_PROXY}`)
    expect(namespaceSettings(withTavily, 'web-search-duckduckgo')).toContain(`proxyURL: ${DUCKDUCKGO_PROXY}`)
    await expect.poll(() => key.isEnabled(), { timeout: 10_000 }).toBe(true)
    await key.fill(TAVILY_KEY)
    await section.getByRole('button', { name: '保存密钥', exact: true }).click()
    await section.getByText('此引用已配置密钥。', { exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => key.inputValue(), { timeout: 10_000 }).toBe('')
    expect(await scaffold.ctx.credentials.describe(TAVILY_REF))
      .toMatchObject({ configured: true, source: 'file', writable: true })
    await expect.poll(async () => readFile(credentialsPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${TAVILY_REF}: ${TAVILY_KEY}`)
    for (const secret of [SEARCH_KEY, TAVILY_KEY]) {
      expect(await readFile(settingsPath, 'utf8')).not.toContain(secret)
      expect(await page.content()).not.toContain(secret)
      expect(await page.locator('body').ariaSnapshot()).not.toContain(secret)
    }

    await duckduckgo.click()
    await expect.poll(() => duckduckgo.isChecked(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => readFile(settingsPath, 'utf8'), { timeout: 10_000 })
      .toMatch(/web:\n\s+searchProvider: duckduckgo/)
    expect(await section.getByText('免费，无需配置密钥。', { exact: true }).count()).toBe(1)
    expect(await scaffold.ctx.credentials.describe(SEARCH_REF)).toMatchObject({ configured: true })
    expect(await scaffold.ctx.credentials.describe(TAVILY_REF)).toMatchObject({ configured: true })
    expect(await proxy.inputValue()).toBe(DUCKDUCKGO_PROXY)
    expect(await endpoint.isVisible()).toBe(false)
    expect(await model.isVisible()).toBe(false)
    expect(await keyRef.isVisible()).toBe(false)
    expect(await key.isVisible()).toBe(false)

    await page.setViewportSize({ width: 375, height: 812 })
    const pageBox = await settingsPage.boundingBox()
    if (pageBox === null) throw new Error('375px 联网搜索设置页未绘制')
    expect(pageBox.x).toBeGreaterThanOrEqual(0)
    expect(pageBox.x + pageBox.width).toBeLessThanOrEqual(375)
    expect(await settingsPage.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    for (const [provider, fields] of [
      [duckduckgo, [proxy]],
      [deepseek, [endpoint, model, proxy, keyRef, key]],
      [tavily, [endpoint, proxy, keyRef, key]],
    ] as const) {
      await provider.click()
      await expect.poll(() => provider.isChecked(), { timeout: 10_000 }).toBe(true)
      if (provider !== duckduckgo) await expect.poll(() => key.isEnabled(), { timeout: 10_000 }).toBe(true)
      if (provider === duckduckgo) {
        expect(await proxy.inputValue()).toBe(DUCKDUCKGO_PROXY)
        expect(await endpoint.isVisible()).toBe(false)
        expect(await key.isVisible()).toBe(false)
      } else if (provider === deepseek) {
        expect(await endpoint.inputValue()).toBe(ENDPOINT)
        expect(await model.inputValue()).toBe(MODEL)
        expect(await proxy.inputValue()).toBe(DEEPSEEK_PROXY)
        expect(await keyRef.inputValue()).toBe(SEARCH_REF)
      } else {
        expect(await endpoint.inputValue()).toBe(TAVILY_ENDPOINT)
        expect(await proxy.inputValue()).toBe(TAVILY_PROXY)
        expect(await keyRef.inputValue()).toBe(TAVILY_REF)
        expect(await model.isVisible()).toBe(false)
      }
      for (const control of [duckduckgo, deepseek, tavily, ...fields]) {
        await control.scrollIntoViewIfNeeded()
        const box = await control.boundingBox()
        if (box === null) throw new Error(`375px 搜索控件未绘制: ${await control.getAttribute('id')}`)
        expect(box.width).toBeGreaterThanOrEqual(fields.includes(control) ? 100 : 12)
        expect(box.x).toBeGreaterThanOrEqual(pageBox.x)
        expect(box.x + box.width).toBeLessThanOrEqual(pageBox.x + pageBox.width + 1)
        await control.focus()
        expect(await control.evaluate(node => document.activeElement === node)).toBe(true)
      }
    }
    expect(await model.isVisible()).toBe(false)
    if (process.env.DSH_SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: join(process.env.DSH_SCREENSHOT_DIR, 'search-settings-mobile.png') })
    }
    await settingsPage.getByRole('button', { name: '返回', exact: true }).click()
    await expect.poll(() => settingsPage.count()).toBe(0)
    expect(await page.locator('vite-error-overlay, nextjs-portal, [data-vite-error-overlay]').count()).toBe(0)
    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
