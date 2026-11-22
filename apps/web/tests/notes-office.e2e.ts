/** 在真实 Web 装配中验收 Word 和 Excel 的页面操作、助手改写与 Office 文件往返。 */
import { readFile } from 'node:fs/promises'
import { resolveSessionPreset } from 'coding-agent-presets'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from 'coding-llm'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const PROVIDER = 'notes-office-fixture'
const TOOL = 'notes_office'
const READ = CallId('office-read')
const READ_SHEET = CallId('office-read-sheet')
const EDIT = CallId('office-edit')
const EXPORT = CallId('office-export')
const REPLY = 'The current note is updated and exported.'
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

type Kind = 'word' | 'excel'
type ReadReply = {
  path: string
  revision: string
  kind: Kind
  paragraphs?: { index: number; runs: { text: string }[] }[]
  sheets?: { id: string; name: string }[]
  cells?: { row: number; column: number; value: unknown }[]
}

/** 外部模型替身，用真实工具回执确定目标、版本与工作表。 */
class OfficeAdapter extends LlmAdapter {
  constructor(private readonly kind: Kind) { super() }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'editor', name: 'Test editor' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    expect(options.tools?.some(tool => tool.name === TOOL)).toBe(true)
    const messages = options.messages.flatMap(message => message.content)
    const result = (id: typeof READ): unknown => {
      const block = messages.find(item => item.type === 'tool-result' && item.toolCallId === id)
      if (block?.type !== 'tool-result') return undefined
      const text = block.content.find(item => item.type === 'text')
      if (block.isError === true || text?.type !== 'text') throw new Error(`办公笔记工具调用失败: ${JSON.stringify(block.content)}`)
      return JSON.parse(text.text) as unknown
    }
    const exported = result(EXPORT) as { name: string; fileId: string } | undefined
    if (exported !== undefined) {
      expect(exported.fileId).toBeTruthy()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    let id = READ
    let args: object = { action: 'read' }
    const edited = result(EDIT) as { path: string; revision: string } | undefined
    const read = result(READ) as ReadReply | undefined
    const sheet = result(READ_SHEET) as ReadReply | undefined
    if (edited !== undefined) {
      id = EXPORT
      args = { action: 'export', path: edited.path, revision: edited.revision }
    } else if (read !== undefined) {
      expect(read.kind).toBe(this.kind)
      const target = { path: read.path, revision: read.revision }
      if (read.kind === 'word') {
        expect(read.paragraphs?.[0]?.runs.map(run => run.text).join('')).toBe('Draft summary')
        id = EDIT
        args = { ...target, action: 'edit', edits: [{ op: 'replace_paragraph', index: 0,
          paragraph: { style: 'heading1', runs: [{ text: 'Reviewed summary', bold: true }] },
        }] }
      } else {
        const sheetId = read.sheets?.[0]?.id
        expect(sheetId).toBeTruthy()
        if (sheet === undefined) {
          id = READ_SHEET
          args = { ...target, action: 'read', sheetId }
        } else {
          expect(sheet.cells?.find(cell => cell.row === 0 && cell.column === 0)).toMatchObject({ value: 12 })
          id = EDIT
          args = { ...target, action: 'edit', edits: [{ op: 'set_cells', sheetId, cells: [
            { row: 0, column: 0, value: 34 }, { row: 0, column: 1, value: 68, formula: '=A1*2' },
          ] }] }
        }
      }
    }
    const serialized = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: serialized }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: serialized } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** 用独立的最小 OOXML 包测试外部导入，不依赖本项目导出器。 */
function externalFile(kind: Kind): Buffer {
  const word = kind === 'word'
  const main = word ? 'word/document.xml' : 'xl/workbook.xml'
  const type = word ? 'wordprocessingml.document' : 'spreadsheetml.sheet'
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>
      ${word ? '' : '<Override PartName="/xl/worksheets/input.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'}
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="${main}"/></Relationships>`,
  }
  if (word) {
    parts[main] = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Original document</w:t></w:r></w:p></w:body></w:document>'
  } else {
    parts[main] = `<workbook xmlns="${SPREADSHEET}" xmlns:r="${OFFICE_RELS}"><sheets><sheet name="Source" sheetId="1" r:id="rId1"/></sheets></workbook>`
    parts['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/worksheet" Target="worksheets/input.xml"/></Relationships>`
    parts['xl/worksheets/input.xml'] = `<worksheet xmlns="${SPREADSHEET}"><sheetData><row r="1">
      <c r="A1" t="inlineStr"><is><t>Original workbook</t></is></c><c r="B1" t="b"><v>1</v></c>
    </row></sheetData></worksheet>`
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)]))))
}

/** 通过真实菜单打开新建弹窗或系统文件选择器。 */
async function selectType(page: Page, group: 'New' | 'Import', label: string) {
  const directory = page.getByRole('complementary', { name: 'Note directory' })
  await directory.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: group, exact: true }).click()
  await page.getByRole('menu', { name: group }).getByRole('menuitem', { name: label, exact: true }).click()
}

/** 向已呈现的画布输入，经过编辑器自己的输入、选择和保存流程。 */
async function enterOfficeText(page: Page, kind: Kind, text: string) {
  const editor = page.locator(`[data-note-office-editor="${kind}"]`)
  const textCanvas = editor.locator('canvas#univer-doc-main-canvas:visible')
  if (kind === 'word') {
    await textCanvas.click({ position: { x: 160, y: 125 } })
    await page.keyboard.insertText(text)
  } else {
    const sheetCanvas = editor.locator('canvas[id^="univer-sheet-main-canvas"]')
    await sheetCanvas.click({ position: { x: 72, y: 34 } })
    await textCanvas.click({ position: { x: 20, y: 8 } })
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }
}

it.each([
  ['word', 'Word document', 'Document name', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['excel', 'Excel workbook', 'Workbook name', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
] as const)('%s 笔记在浏览器中创建、编辑、导出和导入，助手使用同一份文件', async (kind, label, field, ext, mimeType) => {
  const scaffold = await launchWebScaffold({ defaultModel: { provider: PROVIDER, model: 'editor' }, toolsMode: 'native' })
  try {
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], new OfficeAdapter(kind)), '办公笔记测试模型')
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(15_000)
    try {
      const log = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      await selectType(page, 'New', label)
      const create = page.getByRole('dialog', { name: `New ${label}` })
      await create.getByLabel(field).fill('Meeting')
      const published = page.waitForResponse(response => response.url().endsWith('/api/notes/tabs')
        && (response.request().postDataJSON() as { activeKind: Kind }).activeKind === kind)
      await create.getByRole('button', { name: 'Create', exact: true }).click()
      const receipt = await published
      expect(receipt.status()).toBe(200)
      const { sessionId, activeTabPath } = receipt.request().postDataJSON() as { sessionId: string; activeTabPath: string }
      expect(activeTabPath).toBe(kind === 'word' ? 'Meeting.codingword' : 'Meeting.codingexcel')
      const agent = scaffold.ctx.agents.list().find(item => item.id === sessionId)
      if (agent === undefined) throw new Error('笔记助手会话未装载')
      expect(resolveSessionPreset(agent.session)).toBe('notes')
      expect(scaffold.ctx.tools.get(TOOL)).toBeUndefined()

      await enterOfficeText(page, kind, kind === 'word' ? 'Draft summary' : '12')
      const office = page.locator('[data-note-office-editor]')
      const save = office.getByRole('button', { name: 'Save', exact: true })
      if (await save.isEnabled()) await save.click()
      await expect.poll(async () => (await scaffold.ctx.fileLibrary.readNoteOffice(activeTabPath)).document,
        { timeout: 15_000 }).toMatchObject(kind === 'word' ? { paragraphs: [{ runs: [{ text: 'Draft summary' }] }] }
        : { sheets: [{ cells: [{ row: 0, column: 0, value: 12 }] }] })

      const input = page.locator('[data-page-assistant-track] textarea:visible').first()
      await input.fill('Review the current note and export a copy.')
      const refreshed = page.waitForResponse(async (response) => {
        if (!response.ok() || !response.url().includes('/api/notes/office/read?')) return false
        const snapshot = await response.json() as { document: unknown }
        return JSON.stringify(snapshot.document).includes(kind === 'word' ? 'Reviewed summary' : '"formula":"=A1*2"')
      })
      await input.press('Enter')
      await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 25_000 })
      await page.getByText('编辑办公笔记', { exact: true }).waitFor()
      await refreshed
      const saved = await scaffold.ctx.fileLibrary.readNoteOffice(activeTabPath)
      expect(saved.document).toMatchObject(kind === 'word' ? {
        paragraphs: [{ style: 'heading1', runs: [{ text: 'Reviewed summary', bold: true }] }],
      } : { sheets: [{ cells: [{ row: 0, column: 0, value: 34 }, { row: 0, column: 1, formula: '=A1*2' }] }] })
      const managed = scaffold.ctx.fileLibrary.list(0, 10, { kind: 'export', category: 'document', sessionId })
      expect(managed.items).toHaveLength(1)
      expect(managed.items[0]).toMatchObject({ name: `Meeting.${ext}`, mediaType: mimeType })
      expect(agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(kind === 'word' ? 3 : 4)

      await page.setViewportSize({ width: 740, height: 810 })
      await office.getByRole('button', { name: 'Export', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Export ${label}` })
      const downloaded = page.waitForEvent('download')
      await dialog.getByRole('button', { name: `Download ${label}` }).click()
      const download = await downloaded
      expect(download.suggestedFilename()).toBe(`Meeting.${ext}`)
      const exportedParts = unzipSync(await readFile(await download.path()))
      const documentXml = kind === 'word' ? exportedParts['word/document.xml']
        : Object.entries(exportedParts).find(([path]) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))?.[1]
      expect(documentXml).toBeDefined()
      expect(strFromU8(documentXml!)).toContain(kind === 'word' ? 'Reviewed summary' : '<f>A1*2</f>')
      expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)

      const chosen = page.waitForEvent('filechooser')
      await selectType(page, 'Import', label)
      await (await chosen).setFiles({ name: `External.${ext}`, mimeType, buffer: externalFile(kind) })
      await page.getByRole('tab', { name: 'External', selected: true }).waitFor()
      const importedPath = kind === 'word' ? 'External.codingword' : 'External.codingexcel'
      const imported = await scaffold.ctx.fileLibrary.readNoteOffice(importedPath)
      expect(imported.document).toMatchObject(kind === 'word' ? { paragraphs: [{ runs: [{ text: 'Original document', italic: true }] }] }
        : { sheets: [{ name: 'Source', cells: [{ value: 'Original workbook' }, { value: true }] }] })

      const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
      if (await expand.isVisible()) await expand.click()
      const directory = page.getByRole('complementary', { name: 'Note directory' })
      await directory.getByTitle('External', { exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const rename = page.getByRole('dialog', { name: `Rename ${label}` })
      await rename.getByLabel(field).fill('Renamed')
      await rename.getByRole('button', { name: 'Rename', exact: true }).click()
      await page.getByRole('tab', { name: 'Renamed', selected: true }).waitFor()
      const renamedPath = importedPath.replace('External', 'Renamed')
      expect((await scaffold.ctx.fileLibrary.readNoteOffice(renamedPath)).revision).toBe(imported.revision)
      await directory.getByTitle('Renamed', { exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog', { name: 'Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
      await directory.getByTitle('Renamed', { exact: true }).waitFor({ state: 'detached' })
      await expect(scaffold.ctx.fileLibrary.readNoteOffice(renamedPath)).rejects.toThrow('笔记不存在')

      await page.getByRole('tab', { name: 'Meeting' }).click()
      await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      await page.getByRole('tab', { name: 'Meeting', selected: true }).waitFor()
      expect((await scaffold.ctx.fileLibrary.readNoteOffice(activeTabPath)).revision).toBe(saved.revision)
      expect(log.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `notes-office-${kind}`)
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
