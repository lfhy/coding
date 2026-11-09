/** 通过真实 Web 装配验证新对话的右栏不会继承同工作区的旧显示状态。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from 'coding-settings'
import type { ReplayOverrideDoc } from 'coding-llm-replay'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const PROMPT = 'Reply with one short sentence, then stop.'
const REPLY = 'The conversation is ready.'

const replay: ReplayOverrideDoc = [{ kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: REPLY },
  { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
  { type: 'usage', usage: { inputTokens: 32, outputTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
] }]

describe('web e2e: new conversation workbench isolation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-new-conversation-workbench-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replay))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
    })
    // 固定本场景的可回放模型，避免选择上次运行保留的本机默认渠道。
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('#dsh-layout-sidebar').waitFor({ timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'new conversation workbench cleanup failed')
  })

  it('keeps the inherited right panel closed after the first message but permits an explicit open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-new-conversation-workbench'))
    const frame = page.locator('#dsh-layout-sidebar').locator('..')
    const hero = page.locator('[data-phase="hero"]')
    const workbench = page.locator('#dsh-layout-workbench')
    const priorOpen = hero.getByRole('button', { name: 'Open right sidebar' })
    await priorOpen.click()
    await expect.poll(() => frame.getAttribute('data-workbench-shown')).toBe('true')

    await page.getByRole('button', { name: 'New chat' }).first().click()
    await expect.poll(() => frame.getAttribute('data-workbench-shown')).toBeNull()
    expect(await workbench.getAttribute('aria-hidden')).toBe('true')
    expect(await hero.getByRole('button', { name: 'Open right sidebar' }).getAttribute('aria-pressed')).toBe('false')

    const settled = scaffold.whenTurnSettled(30_000)
    const composer = page.locator('textarea:enabled').last()
    await composer.fill(PROMPT)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await settled
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await frame.getAttribute('data-workbench-shown')).toBeNull()
    expect(await workbench.getAttribute('aria-hidden')).toBe('true')

    const right = page.locator('[data-phase="active"]').getByRole('button', { name: 'Open right sidebar' })
    await right.click()
    await expect.poll(() => frame.getAttribute('data-workbench-shown')).toBe('true')
    expect(await workbench.getAttribute('aria-hidden')).toBeNull()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
