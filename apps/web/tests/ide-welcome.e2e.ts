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
    await writeFile(join(project, 'src', 'util.ts'), 'export const util = 1\n')
    await writeFile(join(project, 'package.json'), '{"name":"ide-project"}\n')
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
    const opened = page.getByRole('region', { name: 'Open Editors', exact: true })
    await opened.waitFor()
    const previewTab = page.getByRole('tab', { name: /index\.ts/u })
    const tabBar = await page.getByRole('tablist', { name: 'Open files', exact: true }).boundingBox()
    const paneBox = await page.getByRole('region', { name: 'Editor group 1', exact: true }).boundingBox()
    expect(tabBar?.width).toBeGreaterThan(600)
    expect(tabBar?.width).toBeLessThanOrEqual((paneBox?.width ?? 0) + 1)
    expect(await previewTab.locator('span').last().evaluate(element => getComputedStyle(element).fontStyle))
      .toBe('italic')

    await page.getByText('util.ts', { exact: true }).click()
    await page.getByRole('textbox', { name: 'util.ts editor', exact: true }).waitFor()
    expect(await page.getByRole('tab', { name: /index\.ts/u }).count()).toBe(0)
    const utilTab = page.getByRole('tab', { name: /util\.ts/u })
    expect(await utilTab.locator('span').last().evaluate(element => getComputedStyle(element).fontStyle))
      .toBe('italic')
    await utilTab.dblclick()
    expect(await utilTab.locator('span').last().evaluate(element => getComputedStyle(element).fontStyle))
      .toBe('normal')

    await page.getByText('index.ts', { exact: true }).click()
    await editor.waitFor()
    expect(await page.getByRole('tab', { name: /util\.ts/u }).count()).toBe(1)
    expect(await previewTab.locator('span').last().evaluate(element => getComputedStyle(element).fontStyle))
      .toBe('italic')
    await editor.fill('const answer = 42\n')
    expect(await previewTab.locator('span').last().evaluate(element => getComputedStyle(element).fontStyle))
      .toBe('normal')
    await editor.press('Control+s')
    await page.getByText('Saved', { exact: true }).waitFor()
    expect(await readFile(join(scaffold.workspaceCwd, 'ide-project', 'src', 'index.ts'), 'utf8'))
      .toBe('const answer = 42\n')

    const packageFile = page.locator('button[role="listitem"][title="package.json"]')
    const fileTabs = page.getByRole('tablist', { name: 'Open files', exact: true })
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    await packageFile.dispatchEvent('dragstart', { dataTransfer })
    await fileTabs.dispatchEvent('dragover', { dataTransfer })
    await page.getByText('Drop to open in new group', { exact: true }).waitFor()
    expect(await page.getByText('Drop to open in new group', { exact: true }).getAttribute('data-side')).toBe('left')
    await packageFile.dispatchEvent('dragend', { dataTransfer })
    await page.getByText('Drop to open in new group', { exact: true }).waitFor({ state: 'detached' })
    await dataTransfer.dispose()
    await packageFile.dragTo(fileTabs, { targetPosition: { x: 8, y: 18 } })
    const firstGroup = page.getByRole('region', { name: 'Editor group 1', exact: true })
    const secondGroup = page.getByRole('region', { name: 'Editor group 2', exact: true })
    await firstGroup.waitFor()
    await secondGroup.waitFor()
    await firstGroup.getByRole('textbox', { name: 'package.json editor', exact: true }).waitFor()
    expect(await firstGroup.getByRole('tab', { name: /package\.json/u }).count()).toBe(1)
    expect(await secondGroup.getByRole('tab', { name: /util\.ts/u }).count()).toBe(1)
    expect(await secondGroup.getByRole('tab', { name: /index\.ts/u }).count()).toBe(1)
    expect(await page.getByRole('tab', { name: /package\.json/u }).locator('span').last()
      .evaluate(element => getComputedStyle(element).fontStyle)).toBe('normal')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Files"]')
      ?.querySelectorAll('button[title]').length === 0)
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    }))
    expect(metrics.width).toBe(metrics.viewportWidth)
    expect(metrics.height).toBe(metrics.viewportHeight)
    expect(consoleLog.pageErrors).toEqual([])
  })

  it('切换工作区保留各自标签，拖动标签可分屏', async () => {
    onTestFailed(() => saveFailureShot(page, 'ide-split'))
    const other = join(scaffold.workspaceCwd, 'ide-other')
    await mkdir(join(other, 'docs'), { recursive: true })
    await writeFile(join(other, 'docs', 'note.md'), '# note\n')
    await scaffold.ctx.workspaceRegistry.create(other, 'IDE other')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Code', exact: true }).click()

    // 欢迎页开项目 A，打开一个文件。
    await page.getByRole('button', { name: /IDE project/ }).click()
    await page.getByRole('heading', { level: 1, name: 'IDE project', exact: true }).waitFor({ timeout: 60_000 })
    await page.getByText('src', { exact: true }).click()
    await page.getByText('index.ts', { exact: true }).click()
    await page.getByRole('tab', { name: /index\.ts/u }).waitFor()
    await page.getByRole('tab', { name: /index\.ts/u }).dblclick()
    // 分屏需要把标签从一栏拖到另一栏，先打开第二个文件。
    await page.getByText('util.ts', { exact: true }).click()
    await page.getByRole('tab', { name: /util\.ts/u }).waitFor()

    // 页内切到项目 B，再切回来：标签仍在。
    await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'IDE other', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: 'IDE other', exact: true }).waitFor({ timeout: 60_000 })
    expect(await page.getByRole('tab', { name: /index\.ts/u }).count()).toBe(0)
    await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'IDE project', exact: true }).click()
    await page.getByRole('tab', { name: /index\.ts/u }).waitFor({ timeout: 60_000 })

    // 拖到编辑区右半区形成第二个分组。
    const tab = page.locator('[draggable="true"]', { has: page.getByRole('tab', { name: /util\.ts/u }) }).first()
    const body = page.locator('[data-pane-body]').first()
    const box = await body.boundingBox()
    expect(box).not.toBeNull()
    await tab.dragTo(body, { targetPosition: { x: (box?.width ?? 100) - 8, y: (box?.height ?? 100) / 2 } })
    await page.getByRole('region', { name: 'Editor group 2', exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByRole('region', { name: /Editor group/u }).count()).toBe(2)

    const packageFile = page.locator('button[role="listitem"][title="package.json"]')
    const firstBody = page.locator('[data-pane-body]').first()
    const firstBox = await firstBody.boundingBox()
    expect(firstBox).not.toBeNull()
    await packageFile.dragTo(firstBody, {
      targetPosition: { x: (firstBox?.width ?? 100) / 2, y: 8 },
    })
    await page.getByRole('region', { name: 'Editor group 3', exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByRole('region', { name: /Editor group/u }).count()).toBe(3)
    expect(await page.locator('[data-orientation="column"]').count()).toBe(1)
    expect(consoleLog.pageErrors).toEqual([])
  })
})
