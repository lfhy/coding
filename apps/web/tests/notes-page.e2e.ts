/** 验证实际 Host 与客户端组合中的笔记存取、布局切换和助手草稿。 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('Web 笔记工作区', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleLog: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await scaffold.ctx.fileLibrary.createNoteDirectory('Ideas')
    await scaffold.ctx.fileLibrary.saveNote('Release notes.md', '# Release checklist\n\n- Review docs\n')
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    consoleLog = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('宽屏并排编辑，缩窄后按需打开助手和预览，关闭时保留草稿', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-page'))
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    // 进入笔记页先停在欢迎页；点目录里的笔记才打开正文。
    const welcome = page.getByRole('main', { name: 'Notes', exact: true })
    await welcome.getByRole('heading', { level: 2 }).first().waitFor()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    await directory.getByTitle('Release notes').click()

    const main = page.getByRole('main', { name: 'Release notes', exact: true })
    const editor = main.locator('textarea')
    const heading = main.getByRole('heading', { name: 'Release checklist', exact: true })
    const toggle = main.getByRole('button', { name: 'AI Assistant', exact: true })
    const dock = page.getByRole('complementary', { name: 'AI assistant', exact: true })
    await heading.waitFor()
    await dock.waitFor()
    // 助手页头的「新对话」由笔记页登记入口后才渲染。
    await dock.getByRole('button', { name: 'New conversation', exact: true }).waitFor()
    expect(await editor.isVisible()).toBe(true)
    expect(await page.locator('[data-conversation-scroll]:visible').count()).toBe(1)

    // 导出入口只作用于已打开的笔记：菜单给出四种格式。
    const exportButton = main.getByRole('button', { name: 'Export', exact: true })
    await exportButton.click()
    for (const name of ['Markdown (.md)', 'Word (.docx)', 'PDF (print to save)', 'Image (.png)']) {
      await page.getByRole('menuitem', { name, exact: true }).waitFor()
    }
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menuitem', { name: 'Markdown (.md)', exact: true }).count()).toBe(0)

    const alignment = await directory.getByRole('listitem').evaluateAll(rows => rows.map((row) => {
      const box = row.getBoundingClientRect()
      const label = [...row.querySelectorAll('span')].find(span => span.textContent === row.getAttribute('title'))!
      const labelBox = label.getBoundingClientRect()
      const iconBox = row.querySelector('svg')!.getBoundingClientRect()
      return {
        height: box.height,
        labelStart: labelBox.left,
        offset: Math.abs(labelBox.top + labelBox.height / 2 - (iconBox.top + iconBox.height / 2)),
      }
    }))
    expect(alignment).toHaveLength(2)
    const [first, second] = alignment
    expect(first?.height).toBe(second?.height)
    expect(first?.labelStart).toBe(second?.labelStart)
    expect(Math.max(...alignment.map(row => row.offset))).toBeLessThanOrEqual(1)

    const revised = '# Release checklist\n\n- Review docs\n- Check notes layout\n'
    await editor.fill(revised)
    await expect.poll(async () => (await scaffold.ctx.fileLibrary.readNote('Release notes.md')).content).toBe(revised)
    const assistantInput = page.locator('[data-page-assistant-track] textarea:visible').first()
    await dock.getByRole('button', { name: 'Summarize', exact: true }).click()
    const prompt = await assistantInput.inputValue()
    expect(prompt).toContain('Summarize this content')
    await expect.poll(() => assistantInput.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await dock.getByRole('tab', { name: 'Work', exact: true }).count()).toBe(0)

    await page.setViewportSize({ width: 620, height: 800 })
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await editor.isVisible()).toBe(true)
    expect(await heading.isVisible()).toBe(false)
    await main.getByRole('button', { name: 'Preview', exact: true }).click()
    await heading.waitFor()
    expect(await editor.isVisible()).toBe(false)
    await toggle.click()
    const drawer = page.getByRole('dialog', { name: 'AI assistant', exact: true })
    await drawer.waitFor()
    expect(await assistantInput.inputValue()).toBe(prompt)
    await page.keyboard.press('Escape')
    await expect.poll(() => drawer.count()).toBe(0)
    expect(await toggle.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await heading.isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
    expect(consoleLog.pageErrors).toEqual([])
  })
})
