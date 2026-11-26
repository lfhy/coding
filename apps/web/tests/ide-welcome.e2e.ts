/** 验证真实 Host 与 Client 组合中的代码工作区入口、欢迎页和三栏编辑器。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  }, 60_000)

  it('打开最近工作区后显示三栏，读取并版本化保存文件', async () => {
    onTestFailed(() => saveFailureShot(page, 'ide-workspace'))
    const project = join(scaffold.workspaceCwd, 'ide-project')
    await mkdir(join(project, 'src'), { recursive: true })
    await writeFile(join(project, 'src', 'index.ts'), 'const answer = 1\n')
    await scaffold.ctx.workspaceRegistry.create(project, 'IDE project')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    const recent = page.getByRole('button', { name: /IDE project/ })
    if (await recent.count() > 0) await recent.click()
    await page.getByRole('heading', { level: 1, name: 'IDE project', exact: true }).waitFor({ timeout: 60_000 })
    await page.locator('[data-page-assistant-track]').waitFor({ state: 'visible' })

    await page.getByText('src', { exact: true }).click()
    await page.getByText('index.ts', { exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'index.ts editor', exact: true })
    await editor.waitFor()
    await editor.fill('const answer = 42\n')
    await editor.press('Control+s')
    await page.getByText('Saved', { exact: true }).waitFor()
    expect(await readFile(join(scaffold.workspaceCwd, 'ide-project', 'src', 'index.ts'), 'utf8'))
      .toBe('const answer = 42\n')
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    }))
    expect(metrics.width).toBe(metrics.viewportWidth)
    expect(metrics.height).toBe(metrics.viewportHeight)
    expect(consoleLog.pageErrors).toEqual([])
  })
})
