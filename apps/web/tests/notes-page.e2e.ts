/** 验证实际 Host 与客户端组合中的笔记存取、布局切换和助手草稿。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** 打开页头「New」的类型菜单；不匹配目录行或右键里的同类操作。 */
async function openNewSubmenu(page: Page, directory: Locator) {
  await directory.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New', exact: true }).click()
  return page.getByRole('menu', { name: 'New', exact: true })
}

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

    // 助手默认使用当前最小宽度，同时保持输入栏控件在同一行。
    const track = page.locator('[data-page-assistant-track]')
    expect(await track.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(400)
    const centers = await track.locator('[class*="_select"], [class*="_composerAction"]').evaluateAll(buttons =>
      buttons.map(button => button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2))
    expect(centers.length).toBeGreaterThan(1)
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
    const separator = page.locator('[data-side="assistant"]')
    const before = await track.evaluate(element => Math.round(element.getBoundingClientRect().width))
    const handle = await separator.boundingBox()
    if (handle === null) throw new Error('assistant separator is missing')
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 80, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.up()
    await expect.poll(() => track.evaluate(element => Math.round(element.getBoundingClientRect().width)))
      .toBeGreaterThan(before + 60)
    const widened = await track.evaluate(element => Math.round(element.getBoundingClientRect().width))

    // 导出入口只作用于已打开的笔记：菜单给出四种格式。
    const exportButton = main.getByRole('button', { name: 'Export', exact: true })
    await exportButton.click()
    for (const name of ['Markdown (.md)', 'Word (.docx)', 'PDF (.pdf)', 'Image (.png)']) {
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

    // 切回对话再打开笔记页：正文仍停在同一篇，保存状态与宽度偏好都保留。
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
    await expect.poll(() => main.count()).toBe(0)
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const restored = page.getByRole('main', { name: 'Release notes', exact: true })
    await restored.getByRole('heading', { name: 'Release checklist', exact: true }).waitFor()
    expect(await restored.locator('textarea').inputValue()).toBe(revised)
    expect(await track.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(widened)

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
    expect(await createNote.getAttribute('title')).toBe('New note')
    expect(await createFolder.getAttribute('title')).toBe('New folder')
    await createNote.click()
    await noteDialog.getByRole('button', { name: 'Save to Projects', exact: true }).waitFor()
    expect(await projects.getAttribute('aria-expanded')).toBe('false')
    await noteDialog.getByLabel('Note name').fill('Trip plan')
    await noteDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('heading', { name: 'Trip plan', exact: true }).waitFor()
    await directory.getByTitle('Trip plan', { exact: true }).waitFor()
    expect((await scaffold.ctx.fileLibrary.readNote('Projects/Trip plan.md')).content).toBe('')

    await page.setViewportSize({ width: 620, height: 800 })
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await directory.getByRole('button', { name: 'Archive', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New note', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    const folderDialog = page.getByRole('dialog', { name: 'New folder' })
    await folderDialog.getByRole('button', { name: 'Save to Projects / Archive', exact: true }).waitFor()
    await folderDialog.getByLabel('Folder name').fill('Interviews')
    await folderDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await directory.getByTitle('Interviews', { exact: true }).waitFor()
    await folderDialog.waitFor({ state: 'hidden' })

    const types = await openNewSubmenu(page, directory)
    await types.getByRole('menuitem', { name: 'Note', exact: true }).click()
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

  it('加号菜单按类型分组，在宽窄窗口均可完整展开', async () => {
    const menuPage = await newEnglishPage(browser)
    try {
      for (const width of [1024, 375]) {
        await menuPage.setViewportSize({ width, height: 800 })
        await menuPage.goto(scaffold.baseUrl, { waitUntil: 'load' })
        await menuPage.getByRole('button', { name: 'Notes', exact: true }).click()
        const directory = menuPage.getByRole('complementary', { name: 'Note directory' })
        const launcher = directory.getByRole('button', { name: 'New', exact: true })
        await launcher.click()
        const createEntry = menuPage.getByRole('menuitem', { name: 'New', exact: true })
        const importEntry = menuPage.getByRole('menuitem', { name: 'Import', exact: true })
        await createEntry.waitFor()
        expect(await menuPage.getByRole('menu').count()).toBe(1)
        expect(await menuPage.getByRole('menuitem').allTextContents()).toEqual(['New', 'Import'])

        await importEntry.hover()
        const importMenu = menuPage.getByRole('menu', { name: 'Import', exact: true })
        await importMenu.waitFor()
        expect(await importMenu.getByRole('menuitem').allTextContents()).toEqual(['Text', 'Presentation'])
        await createEntry.hover()
        const types = menuPage.getByRole('menu', { name: 'New', exact: true })
        await types.waitFor()
        expect(await types.getByRole('menuitem').allTextContents()).toEqual(['Folder', 'Note', 'Presentation'])

        // 实际命中浮层边缘也能发现祖先滚动区裁剪，而不只是检查坐标。
        const position = await types.evaluate((menu) => {
          const { left, top, right, bottom, width, height } = menu.getBoundingClientRect()
          if (left < 0 || top < 0 || right > innerWidth || bottom > innerHeight) return null
          const centerX = left + width / 2
          const centerY = top + height / 2
          const edges = [[left + 2, centerY], [right - 2, centerY], [centerX, top + 2], [centerX, bottom - 2]] as const
          return edges.every(([x, y]) => menu.contains(document.elementFromPoint(x, y))) ? left : null
        })
        expect(position).not.toBeNull()
        if (width === 1024) expect(position).toBeGreaterThan(await createEntry.evaluate(item => item.getBoundingClientRect().right))
        await types.getByRole('menuitem', { name: 'Folder', exact: true }).click()
        await menuPage.getByRole('dialog', { name: 'New folder', exact: true }).waitFor()
      }
    } finally {
      await menuPage.context().close()
    }
  })

  it('顶栏切换和关闭笔记标签，跨页恢复后窄屏仍由内容区独立滚动', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-tabs'))
    await scaffold.ctx.fileLibrary.createNoteDirectory('Tab notes')
    await scaffold.ctx.fileLibrary.saveNote('Tab notes/Meeting.md', '# Meeting\n')
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    // 共用同一会话的前几个场景已打开笔记；只核对本场景的标签与相邻切换，不依赖已有标签数量。
    const tabs = page.getByRole('tablist', { name: 'Open notes' })
    await directory.getByTitle('Release notes', { exact: true }).click()
    await expect.poll(() => tabs.getByRole('tab', { name: 'Release notes', exact: true }).getAttribute('aria-selected')).toBe('true')
    await directory.getByRole('button', { name: 'Tab notes', exact: true }).click()
    await directory.getByTitle('Meeting', { exact: true }).click()
    const meeting = tabs.getByRole('tab', { name: 'Meeting', exact: true })
    const release = tabs.getByRole('tab', { name: 'Release notes', exact: true })
    await expect.poll(() => meeting.getAttribute('aria-selected')).toBe('true')
    expect(await release.count()).toBe(1)
    expect(await meeting.getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(await meeting.getAttribute('id'))
    await meeting.focus()
    await page.keyboard.press('End')
    await expect.poll(() => meeting.getAttribute('aria-selected')).toBe('true')
    expect(await meeting.evaluate(node => document.activeElement === node)).toBe(true)
    await release.focus()
    await page.keyboard.press('Home')
    await expect.poll(() => release.getAttribute('aria-selected')).toBe('true')
    expect(await release.evaluate(node => document.activeElement === node)).toBe(true)

    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    await page.getByRole('complementary', { name: 'Note directory' }).waitFor()
    await expect.poll(() => meeting.count()).toBe(1)
    await page.setViewportSize({ width: 620, height: 800 })
    await release.click()
    await expect.poll(() => release.getAttribute('aria-selected')).toBe('true')
    await tabs.getByRole('button', { name: 'Close “Release notes”' }).click()
    await expect.poll(() => release.count()).toBe(0)
    expect(await meeting.count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
    await meeting.click()
    await expect.poll(() => meeting.getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('main', { name: 'Meeting', exact: true }).locator('textarea').inputValue()).toBe('# Meeting\n')
    await tabs.getByRole('button', { name: 'Close “Meeting”' }).click()
    await expect.poll(() => meeting.count()).toBe(0)
    expect(consoleLog.pageErrors).toEqual([])
  })

  it('新建笔记的保存位置可直接在根目录和子目录创建目录', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-create-subfolder-in-picker'))
    await page.setViewportSize({ width: 620, height: 800 })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    const types = await openNewSubmenu(page, directory)
    await types.getByRole('menuitem', { name: 'Note', exact: true }).click()

    const noteDialog = page.getByRole('dialog', { name: 'New note' })
    await noteDialog.getByLabel('Note name').fill('Picker draft')
    await noteDialog.getByRole('button', { name: 'Save to All notes', exact: true }).click()
    const locations = noteDialog.getByRole('menu')
    const bounds = await locations.boundingBox()
    if (bounds === null) throw new Error('save location menu is missing')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(620)

    await locations.getByRole('menuitem', { name: 'New subfolder in “All notes”', exact: true }).click()
    const subfolderDialog = page.getByRole('dialog', { name: 'New subfolder' })
    await subfolderDialog.getByLabel('Folder name').fill('Discarded picker folder')
    await subfolderDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await noteDialog.waitFor()
    expect(await noteDialog.getByLabel('Note name').inputValue()).toBe('Picker draft')
    let location = noteDialog.getByRole('button', { name: 'Save to All notes', exact: true })
    await expect.poll(() => location.evaluate(button => document.activeElement === button)).toBe(true)
    expect(await scaffold.ctx.fileLibrary.notesTree().then(entries => entries.some(entry => entry.name === 'Discarded picker folder'))).toBe(false)

    await location.click()
    await noteDialog.getByRole('menuitem', { name: 'New subfolder in “All notes”', exact: true }).click()
    await subfolderDialog.getByLabel('Folder name').fill('Picker root')
    await subfolderDialog.getByRole('button', { name: 'Create', exact: true }).click()
    location = noteDialog.getByRole('button', { name: 'Save to Picker root', exact: true })
    await location.waitFor()
    expect(await noteDialog.getByLabel('Note name').inputValue()).toBe('Picker draft')

    await location.click()
    await noteDialog.getByRole('menuitem', { name: 'New subfolder in “Picker root”', exact: true }).click()
    await subfolderDialog.getByLabel('Folder name').fill('Picker child')
    await subfolderDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await noteDialog.getByRole('button', { name: 'Save to Picker root / Picker child', exact: true }).waitFor()
    expect(await noteDialog.getByLabel('Note name').inputValue()).toBe('Picker draft')
    await noteDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await noteDialog.waitFor({ state: 'hidden' })
    expect((await scaffold.ctx.fileLibrary.readNote('Picker root/Picker child/Picker draft.md')).content).toBe('')
    expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)
    expect(consoleLog.pageErrors).toEqual([])
  })

  it('从全部笔记新建幻灯片，写出工程并打开工作台', async () => {
    onTestFailed(() => saveFailureShot(page, 'notes-create-presentation'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    const directory = page.getByRole('complementary', { name: 'Note directory' })
    const types = await openNewSubmenu(page, directory)
    await types.getByRole('menuitem', { name: 'Presentation', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New presentation', exact: true })
    await dialog.getByRole('button', { name: 'Save to All notes', exact: true }).waitFor()
    await dialog.getByLabel('Presentation name').fill('测试')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
    await directory.getByTitle('测试', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '测试', selected: true }).waitFor()
    await page.getByRole('button', { name: 'Add page', exact: true }).waitFor({ timeout: 15_000 })
    const deckPath = join(scaffold.ctx.fileLibrary.notesRootPath(), '测试.codingppt', 'deck.json')
    expect(JSON.parse(await readFile(deckPath, 'utf8'))).toMatchObject({ revision: 1, deck: { title: '测试' } })
    expect(consoleLog.pageErrors).toEqual([])
  })
})
