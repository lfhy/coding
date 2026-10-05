/** 真实 Web 装配经 Host Git RPC 展示工作树与独立浮层，并在没有远端时反馈操作错误。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const git = promisify(execFile)
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))

/** 固定仓库身份与 Git 配置来源，避免读取开发者配置或触发远端 helper。 */
async function localGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await git('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return stdout.trim()
}

describe('web e2e: assembled Git overview', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    const seed = await readFile(SEED, 'utf8')
    await seedSession(scaffold, seed, 'git-overview-first')
    await seedSession(scaffold, seed, 'git-overview-second')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('hides non-repositories and keeps Git details in anchored overlays without changing the overview layout', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-git-overview'))
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    const group = sidebar.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3)
    const nonRepoStatus = page.waitForResponse(response => response.url().endsWith('/api/workspace.gitStatus'))
    await sidebar.getByRole('treeitem').last().click()
    const overview = page.locator('#dsh-conversation-overview')
    await overview.waitFor({ timeout: 15_000 })
    const gitArea = page.locator('[data-overview-git]')
    // 非仓库 RPC 返回 null，组件不占概览空间。
    expect((await (await nonRepoStatus).json() as { result: { ok: boolean; value: unknown } }).result)
      .toEqual({ ok: true, value: null })
    expect(await gitArea.count()).toBe(0)

    const cwd = scaffold.workspaceCwd
    await localGit(cwd, 'init', '-b', 'main')
    await writeFile(join(cwd, '.gitignore'), '*\n!/.gitignore\n!/edited.txt\n!/removed.txt\n!/added.txt\n')
    await writeFile(join(cwd, 'edited.txt'), 'old\n')
    await writeFile(join(cwd, 'removed.txt'), 'remove\n')
    await localGit(cwd, 'add', '.gitignore', 'edited.txt', 'removed.txt')
    await localGit(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Seed')
    // 本地 tracking 分支产生可见的 ahead 数；没有远端，推拉仍应拒绝且不修改工作树。
    await localGit(cwd, 'branch', 'tracking')
    await localGit(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Ahead')
    await localGit(cwd, 'branch', '--set-upstream-to=tracking', 'main')
    await writeFile(join(cwd, 'edited.txt'), 'new\nplus\n')
    await rm(join(cwd, 'removed.txt'))
    await writeFile(join(cwd, 'added.txt'), 'one\ntwo\n')

    // 切换至另一份冷会话，令真实组件对同一工作目录重新查询 Git。
    const repoStatus = page.waitForResponse(response => response.url().endsWith('/api/workspace.gitStatus'))
    await sidebar.getByRole('treeitem').nth(1).click()
    const repoResult = (await (await repoStatus).json() as {
      result: { ok: boolean; value: { branch: string; additions: number; deletions: number; files: { path: string }[] } }
    }).result
    expect(repoResult).toMatchObject({ ok: true, value: { branch: 'main', ahead: 1, behind: 0, additions: 4, deletions: 2 } })
    expect(repoResult.value.files.map(file => file.path).sort())
      .toEqual(['added.txt', 'edited.txt', 'removed.txt'])
    await expect.poll(() => gitArea.count(), { timeout: 15_000 }).toBe(1)
    const gitRow = gitArea.getByRole('button', { name: /Git changes/ })
    await expect.poll(() => gitRow.textContent(), { timeout: 15_000 }).toContain('main')
    expect(await gitArea.getByRole('button', { name: 'Push' }).count()).toBe(0)

    const subagents = overview.getByRole('button', { name: /Subagents/ })
    const jobs = overview.getByRole('button', { name: /Background tasks/ })
    const [subagentsBox, jobsBox, gitBox, cardBefore] = await Promise.all([
      subagents.boundingBox(), jobs.boundingBox(), gitRow.boundingBox(), overview.boundingBox(),
    ])
    expect(subagentsBox && jobsBox && gitBox && cardBefore).toBeTruthy()
    if (!subagentsBox || !jobsBox || !gitBox || !cardBefore) throw new Error('Git overview rows are not visible')
    expect(gitBox.y - jobsBox.y).toBeCloseTo(jobsBox.y - subagentsBox.y, 0)

    await gitRow.click()
    const popupId = await gitRow.getAttribute('aria-controls')
    if (!popupId) throw new Error('Git row has no popup target')
    const popup = page.locator(`[id="${popupId}"]`)
    await popup.waitFor({ state: 'visible' })
    expect(await popup.evaluate(element => element.parentElement === document.body)).toBe(true)
    expect(await gitRow.getAttribute('aria-expanded')).toBe('true')
    const branchButton = popup.getByRole('button', { name: /Switch branch/ })
    await branchButton.waitFor()
    expect(await branchButton.textContent()).toContain('main')
    const changes = popup.getByText('Changes', { exact: true })
    const sync = popup.getByText('Sync status', { exact: true })
    expect(await changes.evaluate(element => !!element.parentElement?.querySelector('svg'))).toBe(true)
    expect(await sync.evaluate(element => !!element.parentElement?.querySelector('svg'))).toBe(true)
    await expect.poll(() => popup.textContent()).toContain('3 files')
    await popup.getByText('+4', { exact: true }).waitFor()
    await popup.getByText('−2', { exact: true }).waitFor()
    await popup.getByText('1 ahead · 0 behind', { exact: true }).waitFor()

    const push = popup.getByRole('button', { name: 'Push', exact: true })
    const pull = popup.getByRole('button', { name: 'Pull', exact: true })
    const [popupBefore, pushBox, pullBox, cardOpen] = await Promise.all([
      popup.boundingBox(), push.boundingBox(), pull.boundingBox(), overview.boundingBox(),
    ])
    expect(popupBefore && pushBox && pullBox && cardOpen).toBeTruthy()
    if (!popupBefore || !pushBox || !pullBox || !cardOpen) throw new Error('Git popup controls are not visible')
    expect(Math.abs(cardOpen.height - cardBefore.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(pushBox.width - pullBox.width)).toBeLessThanOrEqual(1)
    expect(pullBox.x).toBeGreaterThan(pushBox.x + pushBox.width)
    expect(pushBox.x).toBeGreaterThanOrEqual(popupBefore.x)
    expect(pullBox.x + pullBox.width).toBeLessThanOrEqual(popupBefore.x + popupBefore.width)
    expect(await push.locator('svg').count()).toBe(1)
    expect(await pull.locator('svg').count()).toBe(1)

    await branchButton.click()
    const branchMenu = page.getByRole('group', { name: 'Local branches' })
    await branchMenu.waitFor({ state: 'visible' })
    expect(await branchMenu.evaluate(element => element.parentElement === document.querySelector('[role="region"][aria-label="Git changes"]'))).toBe(true)
    await branchMenu.getByRole('button', { name: 'tracking' }).waitFor()
    const [menuBox, branchBox, popupWithMenu, cardWithMenu] = await Promise.all([
      branchMenu.boundingBox(), branchButton.boundingBox(), popup.boundingBox(), overview.boundingBox(),
    ])
    expect(menuBox && branchBox && popupWithMenu && cardWithMenu).toBeTruthy()
    if (!menuBox || !branchBox || !popupWithMenu || !cardWithMenu) throw new Error('Branch menu is not visible')
    expect(Math.abs(menuBox.width - branchBox.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(popupWithMenu.height - popupBefore.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(cardWithMenu.height - cardBefore.height)).toBeLessThanOrEqual(1)
    expect(menuBox.x).toBeGreaterThanOrEqual(12)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width - 11)
    await branchButton.focus()
    await page.keyboard.press('Tab')
    expect(await branchMenu.getByRole('button', { name: 'main' }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await branchButton.evaluate(element => element === document.activeElement)).toBe(true)
    await branchButton.click()
    await branchMenu.waitFor({ state: 'hidden' })

    for (const action of ['Push', 'Pull'] as const) {
      const response = page.waitForResponse(candidate => candidate.url().endsWith(`/api/workspace.git${action}`))
      await popup.getByRole('button', { name: action, exact: true }).click()
      const result = (await (await response).json() as {
        result: { ok: boolean; error: { code: string; message: string; details: { reason: string } } }
      }).result
      expect(result).toMatchObject({ ok: false, error: { code: 'git-unavailable', details: { reason: 'GIT_REMOTE_UNAVAILABLE' } } })
      await expect.poll(() => popup.getByRole('alert').textContent(), { timeout: 10_000 }).toBe(result.error.message)
      expect(await popup.getByRole('status').count()).toBe(0)
    }
    expect(await localGit(cwd, 'status', '--porcelain')).toContain('edited.txt')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
