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
      const label = [...row.querySelectorAll('span')].find(span => span.textContent === row.querySelector('button')?.title)!
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

  it('悬停露出行尾动作；键盘可确认删除，非空目录和子笔记实际消失', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-row-actions'))
    await scaffold.ctx.fileLibrary.saveNote('Ideas/Archive/Draft.md', '# Draft')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    const folder = page.getByRole('button', { name: 'Ideas', exact: true })
    const folderRow = directory.getByRole('listitem').filter({ has: folder })
    const rename = folderRow.getByRole('button', { name: 'Rename “Ideas”' })
    const remove = folderRow.getByRole('button', { name: 'Delete “Ideas”' })
    const opacity = (locator: typeof rename) => locator.evaluate(button => getComputedStyle(button.parentElement!).opacity)
    await expect.poll(() => opacity(remove)).toBe('0')
    await folder.hover()
    expect(await opacity(rename)).toBe('1')
    expect(await opacity(remove)).toBe('1')
    await rename.click()
    const renameDialog = page.getByRole('dialog', { name: 'Rename folder' })
    await renameDialog.waitFor()
    expect(await folder.getAttribute('aria-expanded')).toBe('false')
    await renameDialog.getByRole('button', { name: 'Cancel' }).click()

    await page.mouse.move(0, 0)
    await folder.focus()
    for (let action = 0; action < 4; action += 1) await page.keyboard.press('Tab')
    expect(await remove.evaluate(button => document.activeElement === button)).toBe(true)
    expect(await opacity(remove)).toBe('1')
    await page.keyboard.press('Enter')
    const confirm = page.getByRole('dialog', { name: 'Delete', exact: true })
    await confirm.getByText(/all its files and subfolders/).waitFor()
    await page.keyboard.press('Escape')
    await confirm.waitFor({ state: 'hidden' })
    expect(await remove.evaluate(button => document.activeElement === button)).toBe(true)
    expect((await scaffold.ctx.fileLibrary.readNote('Ideas/Archive/Draft.md')).content).toBe('# Draft')

    await page.setViewportSize({ width: 620, height: 800 })
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await folder.hover()
    expect(await opacity(remove)).toBe('1')
    await remove.click()
    const removed = page.waitForResponse(response => response.url().endsWith('/api/notes/delete') && response.request().method() === 'DELETE')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    expect((await removed).status()).toBe(204)
    await folderRow.waitFor({ state: 'detached' })
    expect((await scaffold.ctx.fileLibrary.notesTree()).map(entry => entry.name)).toEqual(['Release notes.md'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
    expect(consoleLog.pageErrors).toEqual([])
  })

  it('从目录行和顶部加号创建，内容落在弹窗所示目录', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-create-location'))
    await scaffold.ctx.fileLibrary.createNoteDirectory('Projects')
    await scaffold.ctx.fileLibrary.createNoteDirectory('Archive', 'Projects')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    const projects = directory.getByRole('button', { name: 'Projects', exact: true })
    const createNote = directory.getByRole('button', { name: 'New note in “Projects”' })
    const createFolder = directory.getByRole('button', { name: 'New folder in “Projects”' })
    const noteDialog = page.getByRole('dialog', { name: 'New note' })
    const actionsOpacity = (button: typeof createNote) => button.evaluate(node => getComputedStyle(node.parentElement!).opacity)
    await expect.poll(() => actionsOpacity(createNote)).toBe('0')
    await projects.hover()
    expect(await actionsOpacity(createNote)).toBe('1')
    expect(await actionsOpacity(createFolder)).toBe('1')
    await createNote.click()
    await noteDialog.getByRole('button', { name: 'Save to Projects', exact: true }).waitFor()
    expect(await projects.getAttribute('aria-expanded')).toBe('false')
    await noteDialog.getByLabel('Note name').fill('Trip plan')
    await noteDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('heading', { name: 'Trip plan', exact: true }).waitFor()
    await directory.getByTitle('Trip plan', { exact: true }).waitFor()
    expect((await scaffold.ctx.fileLibrary.readNote('Projects/Trip plan.md')).content).toBe('')

    await page.setViewportSize({ width: 620, height: 800 })
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
    await directory.getByRole('button', { name: 'Archive', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    const folderDialog = page.getByRole('dialog', { name: 'New folder' })
    await folderDialog.getByRole('button', { name: 'Save to Projects / Archive', exact: true }).waitFor()
    await folderDialog.getByLabel('Folder name').fill('Interviews')
    await folderDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await directory.getByTitle('Interviews', { exact: true }).waitFor()
    await folderDialog.waitFor({ state: 'hidden' })

    await directory.getByRole('button', { name: 'New note', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New note', exact: true }).click()
    const root = noteDialog.getByRole('button', { name: 'Save to All notes', exact: true })
    await root.click()
    await page.keyboard.press('Escape')
    await noteDialog.getByRole('menu').waitFor({ state: 'hidden' })
    expect(await root.evaluate(button => document.activeElement === button)).toBe(true)
    await root.click()
    const locations = noteDialog.getByRole('menu')
    const labelLeft = (name: string) => locations.getByText(name, { exact: true }).evaluate(label => label.getBoundingClientRect().left)
    const [rootLeft, projectLeft, archiveLeft, interviewLeft] = await Promise.all([
      labelLeft('All notes'), labelLeft('Projects'), labelLeft('Archive'), labelLeft('Interviews'),
    ])
    expect(projectLeft).toBeGreaterThan(rootLeft)
    expect(archiveLeft).toBeGreaterThan(projectLeft)
    expect(interviewLeft).toBeGreaterThan(archiveLeft)
    await locations.getByRole('menuitem', { name: 'Projects / Archive / Interviews', exact: true }).click()
    await noteDialog.getByLabel('Note name').fill('Questionnaire')
    await noteDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await directory.getByTitle('Questionnaire', { exact: true }).waitFor()
    expect((await scaffold.ctx.fileLibrary.readNote('Projects/Archive/Interviews/Questionnaire.md')).content).toBe('')
    expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
    expect(consoleLog.pageErrors).toEqual([])
  })
})
