// 真实 Web/Host 组装：拖入演示文稿、粘贴未知格式文件后只展示保存名，
// 提交与持久消息仍携带 Home 文件库的绝对路径；回放模型不访问外部服务。
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayOverrideDoc } from 'coding-llm-replay'
import { settingsNamespace } from 'coding-settings'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const ANSWER = 'STAGED_FILES_RECEIVED'
const REPLAY: ReplayOverrideDoc = [{
  kind: 'chunks',
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: ANSWER },
    { type: 'block-end', index: 0, block: { type: 'text', text: ANSWER } },
    { type: 'usage', usage: { inputTokens: 128, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
}]

/** 经页面原有拖放或粘贴入口提交原始文件，而不是伪造 Host 返回路径。 */
async function intakeFile(page: Page, name: string, entry: 'drop' | 'paste'): Promise<void> {
  await page.evaluate(async ({ name, entry }) => {
    const file = new File(['saved content'], name, { type: 'application/octet-stream' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    if (entry === 'paste') {
      const input = document.querySelector('textarea:enabled')
      if (input === null) throw new Error('composer missing')
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    } else {
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, { name, entry })
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: staged file display and managed paths', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  const prompts: unknown[] = []

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-staged-file-display-'))
    const override = join(replayDir, 'replay.override.json')
    await writeFile(override, JSON.stringify(REPLAY))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride: override,
    })
    // 固定回放渠道，避免本机默认模型设置把请求送往未录制的其他渠道。
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (request.url().endsWith('/api/session.prompt')) prompts.push(request.postDataJSON())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'staged file e2e cleanup failed')
  })

  it('shows file names before and after sending while keeping the actual paths in the prompt and log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-staged-file-display'))
    const input = page.locator('textarea:enabled').first()
    await input.fill('Review ')
    await intakeFile(page, '演示 slides.pptx', 'drop')
    await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe('Review @演示 slides.pptx')
    await input.press('End')
    await input.pressSequentially(' and ')
    await intakeFile(page, 'notes.xyz', 'paste')
    await expect.poll(() => input.inputValue(), { timeout: 15_000 })
      .toBe('Review @演示 slides.pptx and @notes.xyz')
    expect(await page.locator('[data-reference-appearance="file"]').allTextContents())
      .toEqual(['@演示 slides.pptx', '@notes.xyz'])
    expect(await input.inputValue()).not.toContain('.dsh-uploads/')

    const uploadRoot = join(scaffold.harnessHome, 'files', 'uploads')
    const saved = await readdir(uploadRoot)
    expect(saved).toHaveLength(2)
    const deck = saved.find(name => name.endsWith('-演示 slides.pptx'))
    const notes = saved.find(name => name.endsWith('-notes.xyz'))
    expect(deck).toMatch(/^[a-f\d-]{36}-演示 slides\.pptx$/u)
    expect(notes).toMatch(/^[a-f\d-]{36}-notes\.xyz$/u)
    if (deck === undefined || notes === undefined) throw new Error('uploaded file missing')
    for (const name of saved) {
      expect(await readFile(join(uploadRoot, name), 'utf8'))
        .toBe('saved content')
    }
    await expect(readdir(join(scaffold.workspaceCwd, 'workspace', '.dsh-uploads')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const deckPath = join(uploadRoot, deck).replaceAll('\\', '/')
    const notesPath = join(uploadRoot, notes).replaceAll('\\', '/')
    const canonical = `Review @"${deckPath}" and @"${notesPath}"`
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    const id = await settled
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as { payload: { content: Array<{ type: string; text?: string }> } }
    expect(prompt.payload.content.find(block => block.type === 'text')?.text).toBe(canonical)
    const session = scaffold.ctx.sessions.get(id)
    const sent = session?.events.flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(sent).toContain(canonical)
    const response = await page.request.get(`${scaffold.baseUrl}/api/files/list?offset=0&limit=50`)
    expect(response.status()).toBe(200)
    const listed = await response.text()
    expect(listed).not.toContain(scaffold.harnessHome)
    const files = JSON.parse(listed) as { total: number; items: unknown[] }
    expect(files.total).toBe(2)
    expect(files.items).toHaveLength(2)
    expect(files.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'upload', name: '演示 slides.pptx', relativePath: `uploads/${deck}`,
        mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: Buffer.byteLength('saved content'), sessionId: id,
      }),
      expect.objectContaining({
        kind: 'upload', name: 'notes.xyz', relativePath: `uploads/${notes}`,
        mediaType: 'application/octet-stream', bytes: Buffer.byteLength('saved content'), sessionId: id,
      }),
    ]))
    const bubble = page.locator('[data-chat-flow-kind="user"] [data-ref-chip="file"]')
    await expect.poll(() => bubble.allTextContents(), { timeout: 15_000 })
      .toEqual(['演示 slides.pptx', 'notes.xyz'])
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.locator('[data-chat-flow-kind="user"] [data-ref-chip="file"]').allTextContents(),
      { timeout: 15_000 }).toEqual(['演示 slides.pptx', 'notes.xyz'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
