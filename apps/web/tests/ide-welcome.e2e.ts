/** 验证真实 Host 与 Client 组合中的代码工作区入口和欢迎页。 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('代码工作区入口', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleLog: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    consoleLog = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('只显示欢迎内容，目录选择取消后按 Escape 返回对话', async () => {
    onTestFailed(() => saveFailureShot(page, 'ide-welcome'))
    await page.getByRole('button', { name: 'Code', exact: true }).click()

    const title = page.getByRole('heading', { level: 1, name: 'Code workspace' })
    await title.waitFor()
    await page.getByRole('heading', { level: 2, name: 'Open a project and start coding' }).waitFor()
    await page.locator('#dsh-layout-sidebar').waitFor({ state: 'hidden' })
    expect(await page.locator('[data-page-assistant-track]').count()).toBe(0)

    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    await page.keyboard.press('Escape')
    await title.waitFor({ state: 'detached' })
    await page.locator('#dsh-layout-sidebar').waitFor({ state: 'visible' })
    expect(consoleLog.pageErrors).toEqual([])
  })
})
