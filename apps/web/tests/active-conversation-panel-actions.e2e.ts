/** 冷启动一段非空会话，验证面板入口属于可见会话页头而非 Hero 或侧栏。 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/code-mode-round/session.jsonl', import.meta.url))
const SEED_ID = 'active-conversation-panel-actions-web-e2e'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: active conversation panel actions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('#dsh-layout-sidebar').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps terminal and files toggles in the active session header and opens the terminal', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-active-conversation-panel-actions'))
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    // 冷列表先以工作目录名显示，打开后才从日志投影会话标题。
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 15_000 })
    await sessionRow.click()

    expect(page.url()).toBe(scaffold.baseUrl + '/')
    expect(await page.title()).toBe('Using ONE run_code program: run — Coding')
    expect(await page.locator('vite-error-overlay, #vite-error-overlay').count()).toBe(0)
    const conversation = page.locator('[data-phase="active"]')
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    const header = conversation.locator('header:not([aria-hidden="true"])')
    const utilities = header.locator('[class*="headerUtilities"]')
    const terminal = utilities.getByRole('button', { name: 'Show terminal panel' })
    const files = utilities.getByRole('button', { name: 'Show files sidebar' })
    await terminal.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await header.isVisible()).toBe(true)
    expect(await utilities.isVisible()).toBe(true)
    expect(await files.isVisible()).toBe(true)
    expect(await terminal.getAttribute('aria-pressed')).toBe('false')
    expect(await files.getAttribute('aria-pressed')).toBe('false')

    const frame = page.locator('#dsh-layout-sidebar').locator('..')
    expect(await frame.getAttribute('data-bottom-open')).toBeNull()
    await terminal.click()
    const hideTerminal = utilities.getByRole('button', { name: 'Hide terminal panel' })
    await expect.poll(() => hideTerminal.getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true')
    await expect.poll(() => frame.getAttribute('data-bottom-open')).toBe('true')
    expect(await page.locator('#dsh-layout-workbench-bottom').getAttribute('aria-hidden')).toBeNull()
    expect(await utilities.getByRole('button', { name: 'Hide files sidebar' }).getAttribute('aria-pressed')).toBe('true')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
