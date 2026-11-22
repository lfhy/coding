/** 在真实 Web 组合中验收导图编辑、助手写盘和现有笔记标签行为。 */
import { resolveSessionPreset } from 'coding-agent-presets'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from 'coding-llm'
import { strToU8, zipSync } from 'fflate'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const PROVIDER = 'notes-mindmap-fixture'
const TOOL = 'notes_mindmap'
const READ = CallId('mindmap-read')
const EDIT = CallId('mindmap-edit')
const REPLY = 'I updated the transport branch.'

/** 只替换外部模型：从真实读取回执取得目标和版本，之后交给笔记工具编辑。 */
class MindmapAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'editor', name: 'Test editor' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    expect(options.tools?.some(tool => tool.name === TOOL)).toBe(true)
    const messages = options.messages.flatMap(message => message.content)
    const result = (id: typeof READ) => {
      const block = messages.find(item => item.type === 'tool-result' && item.toolCallId === id)
      if (block?.type !== 'tool-result') return undefined
      expect(block.isError).not.toBe(true)
      const text = block.content.find(item => item.type === 'text')
      if (text?.type !== 'text') throw new Error('导图工具未返回文本回执')
      return JSON.parse(text.text) as { path: string; revision: string; topics: { id: string; text: string }[] }
    }
    const read = result(READ)
    if (result(EDIT) !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = read === undefined ? READ : EDIT
    const topic = read?.topics.find(item => item.text === 'Transport')
    if (read !== undefined && topic === undefined) throw new Error('活动导图未包含用户指定的分支')
    const args = JSON.stringify(read === undefined ? { action: 'read' } : {
      action: 'edit', path: read.path, revision: read.revision, edits: [{ op: 'rename', id: topic!.id, text: 'Train plan' }],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('新建和导入导图，浏览器与笔记助手共用编辑结果', async () => {
  const scaffold = await launchWebScaffold({ defaultModel: { provider: PROVIDER, model: 'editor' }, toolsMode: 'native' })
  try {
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], new MindmapAdapter()), '笔记导图测试模型')
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    try {
      const log = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      const directory = page.getByRole('complementary', { name: 'Note directory' })
      const plus = directory.getByRole('button', { name: 'New', exact: true })
      await plus.click()
      await page.getByRole('menuitem', { name: 'New', exact: true }).click()
      await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Mind map' }).click()
      const create = page.getByRole('dialog', { name: 'New mind map' })
      await create.getByLabel('Mind map name').fill('Trip map')
      const published = page.waitForResponse(response => response.url().endsWith('/api/notes/tabs')
        && response.request().postDataJSON().activeKind === 'mindmap')
      await create.getByRole('button', { name: 'Create', exact: true }).click()
      const receipt = await published
      expect(receipt.status()).toBe(200)
      const { sessionId, activeTabPath } = receipt.request().postDataJSON() as { sessionId: string; activeTabPath: string }
      expect(activeTabPath).toBe('Trip map.codingmindmap')
      const assistant = scaffold.ctx.agents.list().find(agent => agent.id === sessionId)
      if (assistant === undefined) throw new Error('笔记助手会话未装载')
      expect(resolveSessionPreset(assistant.session)).toBe('notes')
      expect(scaffold.ctx.tools.get(TOOL)).toBeUndefined()

      const canvas = page.getByRole('region', { name: 'Mind map canvas' })
      await canvas.getByRole('button', { name: 'Trip map', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Add child node', exact: true }).click()
      const add = page.getByRole('dialog', { name: 'Add child node' })
      await add.getByLabel('Node text').fill('Transport')
      await add.getByRole('button', { name: 'Add child node' }).click()
      await canvas.getByRole('button', { name: 'Transport', exact: true }).waitFor()
      expect((await scaffold.ctx.fileLibrary.readNoteMindmap(activeTabPath)).document.root.children[0]?.text).toBe('Transport')
      expect(await page.getByRole('button', { name: 'Export', exact: true }).count()).toBe(0)

      const input = page.locator('[data-page-assistant-track] textarea:visible').first()
      await input.fill('Rename Transport in the current mind map to Train plan.')
      await input.press('Enter')
      await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 20_000 })
      const toolTitle = page.getByText('编辑思维导图', { exact: true })
      await toolTitle.waitFor()
      await canvas.getByRole('button', { name: 'Train plan' }).waitFor()
      expect((await scaffold.ctx.fileLibrary.readNoteMindmap(activeTabPath)).document.root.children[0]?.text).toBe('Train plan')
      expect(assistant.session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)

      await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      await canvas.getByRole('button', { name: 'Train plan' }).waitFor()
      await toolTitle.waitFor()

      const topic = { title: 'Conference', children: { attached: [{ title: 'Venue' }] } }
      const xmind = Buffer.from(zipSync({ 'content.json': strToU8(JSON.stringify([{ rootTopic: topic }])) }))
      const native = Buffer.from(JSON.stringify({ version: 1, root: { id: 'root', text: 'Checklist', children: [] } }))
      for (const [file, bytes, name] of [
        ['Imported plan.xmind', xmind, 'Conference'], ['Native copy.codingmindmap', native, 'Checklist'],
      ] as const) {
        await plus.click()
        await page.getByRole('menuitem', { name: 'Import', exact: true }).click()
        const chosen = page.waitForEvent('filechooser')
        await page.getByRole('menu', { name: 'Import' }).getByRole('menuitem', { name: 'Mind map' }).click()
        await (await chosen).setFiles({ name: file, mimeType: 'application/octet-stream', buffer: bytes })
        await page.getByRole('menu', { name: 'Import' }).waitFor({ state: 'hidden' })
        await canvas.getByRole('button', { name, exact: true }).waitFor()
      }
      expect((await scaffold.ctx.fileLibrary.readNoteMindmap('Imported plan.codingmindmap')).document.root.children[0]?.text).toBe('Venue')

      await page.setViewportSize({ width: 620, height: 800 })
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      const imported = directory.getByTitle('Native copy', { exact: true })
      await imported.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const rename = page.getByRole('dialog', { name: 'Rename mind map' })
      await rename.getByLabel('Mind map name').fill('Renamed copy')
      await rename.getByRole('button', { name: 'Rename', exact: true }).click()
      await page.getByRole('tab', { name: 'Renamed copy', selected: true }).waitFor()
      expect((await scaffold.ctx.fileLibrary.readNoteMindmap('Renamed copy.codingmindmap')).document.root.text).toBe('Checklist')
      expect(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true)

      await directory.getByTitle('Renamed copy', { exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog', { name: 'Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
      await directory.getByTitle('Renamed copy', { exact: true }).waitFor({ state: 'detached' })
      await expect(scaffold.ctx.fileLibrary.readNoteMindmap('Renamed copy.codingmindmap')).rejects.toThrow('笔记不存在')
      expect(log.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'notes-mindmap')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
