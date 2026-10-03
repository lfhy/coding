/** 真实 Web 装配经 Host Git RPC 展示工作树，并在无上游时反馈操作错误。 */
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

  it('hides non-repositories and shows actual file, line, and no-upstream feedback', async () => {
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
    await writeFile(join(cwd, 'edited.txt'), 'new\nplus\n')
    await rm(join(cwd, 'removed.txt'))
    await writeFile(join(cwd, 'added.txt'), 'one\ntwo\n')

    // 切换至另一份冷会话，令真实组件对同一工作目录重新查询 Git。
    const repoStatus = page.waitForResponse(response => response.url().endsWith('/api/workspace.gitStatus'))
    await sidebar.getByRole('treeitem').nth(1).click()
    const repoResult = (await (await repoStatus).json() as {
      result: { ok: boolean; value: { branch: string; additions: number; deletions: number; files: { path: string }[] } }
    }).result
    expect(repoResult).toMatchObject({ ok: true, value: { branch: 'main', additions: 4, deletions: 2 } })
    expect(repoResult.value.files.map(file => file.path).sort())
      .toEqual(['added.txt', 'edited.txt', 'removed.txt'])
    await expect.poll(() => gitArea.count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => gitArea.textContent(), { timeout: 15_000 })
      .toContain('3 files · +4 / −2 lines')
    expect(await gitArea.getByText('main', { exact: true }).count()).toBe(1)

    for (const action of ['Push', 'Pull'] as const) {
      const response = page.waitForResponse(candidate => candidate.url().endsWith(`/api/workspace.git${action}`))
      await gitArea.getByRole('button', { name: action, exact: true }).click()
      const result = (await (await response).json() as {
        result: { ok: boolean; error: { code: string; message: string; details: { reason: string } } }
      }).result
      expect(result).toMatchObject({ ok: false, error: { code: 'git-unavailable', details: { reason: 'GIT_REMOTE_UNAVAILABLE' } } })
      await expect.poll(() => gitArea.getByRole('alert').textContent(), { timeout: 10_000 }).toBe(result.error.message)
      expect(await gitArea.getByRole('status').count()).toBe(0)
    }
    expect(await localGit(cwd, 'status', '--porcelain')).toContain('edited.txt')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
