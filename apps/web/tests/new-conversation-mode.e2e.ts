/** 真实新对话入口：顶部双模式单向同步侧栏，普通对话无需选项目，切换保留草稿。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from 'coding-settings'
import type { ReplayOverrideDoc } from 'coding-llm-replay'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPLY = 'The standalone conversation is ready.'
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/new-conversation-mode', import.meta.url))
const MODE = webSnapshotMode()
const replay: ReplayOverrideDoc = [{ kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: REPLY },
  { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
  { type: 'usage', usage: { inputTokens: 32, outputTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
] }]

describe('新对话页工作与对话入口', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-new-conversation-mode-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(replay))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride,
    })
    await scaffold.ctx.settings.update(settingsNamespace('agent-default-model'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await scaffold.ctx.settings.update(settingsNamespace('agent-presets'), { default: 'minimal' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('tablist', { name: 'New conversation mode', exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
  })

  it('顶部单向切换发起方式，侧栏只筛选列表，草稿跨项目与普通对话保留', async () => {
    onTestFailed(() => saveFailureShot(page, 'new-conversation-mode'))
    const top = page.getByRole('tablist', { name: 'New conversation mode', exact: true })
    const sidebar = page.locator('#dsh-layout-sidebar').getByRole('tablist', { name: 'Browse sessions', exact: true })
    const topWork = top.getByRole('tab', { name: 'Work', exact: true })
    const topConversation = top.getByRole('tab', { name: 'Conversations', exact: true })
    const input = page.locator('textarea').last()
    const offsetFromCenter = await top.evaluate((element) => {
      const capsule = element.getBoundingClientRect()
      const content = element.closest('[data-phase="hero"]')!.getBoundingClientRect()
      return Math.abs(capsule.x + capsule.width / 2 - content.x - content.width / 2)
    })
    expect(offsetFromCenter).toBeLessThanOrEqual(1)
    const outline = await top.evaluate((element) => {
      const style = getComputedStyle(element)
      return { width: style.borderTopWidth, color: style.borderTopColor }
    })
    expect(outline.width).toBe('1px')
    expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')
    expect((await topWork.boundingBox())?.height).toBe(36)
    expect((await topWork.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(96)
    expect((await sidebar.getByRole('tab', { name: 'Work', exact: true }).boundingBox())?.height).toBe(28)
    expect(await topWork.getAttribute('aria-selected')).toBe('true')
    expect(await input.evaluate((element: HTMLTextAreaElement) => element.disabled || element.readOnly)).toBe(true)
    await sidebar.getByRole('tab', { name: 'Recent', exact: true }).click()
    expect(await topWork.getAttribute('aria-selected')).toBe('true')
    expect(scaffold.ctx.sessions.list()).toHaveLength(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'work.expected.md'),
      await captureStableAria(page, '[data-phase="hero"]', scaffold.workspaceCwd), MODE)

    await topConversation.click()
    await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => !element.disabled && !element.readOnly)).toBe(true)
    expect(await topConversation.getAttribute('aria-selected')).toBe('true')
    expect(await sidebar.getByRole('tab', { name: 'Conversations', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('button', { name: 'Choose workspace', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(0)
    expect(scaffold.ctx.sessions.list()).toHaveLength(1)
    const standaloneId = scaffold.ctx.sessions.list()[0]!.id
    const standalone = scaffold.ctx.agents.get(standaloneId)!
    expect(scaffold.ctx.agentPresets.composedPreset(standalone.ctx)).toBe('standard')
    expect(await page.getByRole('button', { name: /mode$/ }).count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'conversation.expected.md'),
      await captureStableAria(page, '[data-phase="hero"]', scaffold.workspaceCwd), MODE)
    await input.fill('Keep this draft while changing the entry mode.')

    for (const name of ['Work', 'Recent'] as const) {
      await sidebar.getByRole('tab', { name, exact: true }).click()
      expect(await topConversation.getAttribute('aria-selected')).toBe('true')
      expect(await input.isEnabled()).toBe(true)
      expect(scaffold.ctx.sessions.list()).toHaveLength(1)
    }

    await topWork.click()
    await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.disabled || element.readOnly)).toBe(true)
    expect(await sidebar.getByRole('tab', { name: 'Work', exact: true }).getAttribute('aria-selected')).toBe('true')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await expect.poll(() => input.inputValue()).toBe('Keep this draft while changing the entry mode.')
    await topConversation.click()
    await expect.poll(() => input.isEnabled()).toBe(true)
    await expect.poll(() => input.inputValue()).toBe('Keep this draft while changing the entry mode.')
    expect(await page.getByRole('button', { name: 'Choose workspace', exact: true }).count()).toBe(0)
    await topWork.click()
    await expect.poll(() => input.isEnabled()).toBe(true)
    expect(await input.inputValue()).toBe('Keep this draft while changing the entry mode.')
    await page.reload({ waitUntil: 'load' })
    await top.waitFor({ timeout: 30_000 })
    await expect.poll(() => input.inputValue()).toBe('Keep this draft while changing the entry mode.')
    expect(await topWork.getAttribute('aria-selected')).toBe('true')
    await topConversation.click()
    await expect.poll(() => topConversation.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => !element.disabled && !element.readOnly)).toBe(true)
    expect(await page.getByRole('button', { name: /mode$/ }).count()).toBe(0)
    const settled = scaffold.whenTurnSettled(30_000)
    await input.fill('Reply with one short sentence and stop.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await settled
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await top.count()).toBe(0)
    const workspaceSessions = scaffold.ctx.workspaceRegistry.list().flatMap(workspace => workspace.sessionIds)
    expect(workspaceSessions).not.toContain(standaloneId)
    expect(tripwire.pageErrors).toEqual([])
    const dimensions = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight, viewportHeight: innerHeight,
    }))
    expect(dimensions.height).toBe(dimensions.viewportHeight)
  }, 90_000)
})
