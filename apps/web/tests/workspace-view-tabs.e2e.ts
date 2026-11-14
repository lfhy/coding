/** 真实 Host 验证侧栏三视图的归属、活动排序、搜索边界、键盘及刷新恢复。 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from 'coding-session'
import { launchWebScaffold, seedBlankSession, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('侧栏工作、对话与最近视图', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const WORK_TITLE = '共同内容 工作会话'
  const LOOSE_TITLE = '共同内容 独立对话'
  const OLDER_TITLE = '较早的独立对话'

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url), 'utf8')
    const timestamps = [...fixture.matchAll(/"time":(\d+)/g)].map(match => Number(match[1]))
    const lastTime = Math.max(...timestamps)
    const workDir = join(scaffold.workspaceCwd, WORK_TITLE)
    const looseDir = join(scaffold.workspaceCwd, LOOSE_TITLE)
    const olderDir = join(scaffold.workspaceCwd, OLDER_TITLE)
    await Promise.all([mkdir(workDir), mkdir(looseDir), mkdir(olderDir)])
    const seed = async (id: string, title: string, cwd: string, age: number) => {
      const offset = Date.now() - age - lastTime
      const raw = fixture.replace('"title":"Use the read tool twice"', `"title":${JSON.stringify(title)}`)
        .replace(/"time":(\d+)/g, (_match, time: string) => `"time":${Number(time) + offset}`)
      return await seedSession({ ...scaffold, workspaceCwd: cwd }, raw, id)
    }
    const workId = await seed('view-work', WORK_TITLE, workDir, 1_000)
    await seed('view-loose', LOOSE_TITLE, looseDir, 2_000)
    await seed('view-older', OLDER_TITLE, olderDir, 3_000)
    const archivedId = await seed('view-archived', '不应显示的归档会话', looseDir, 500)
    await seedBlankSession(scaffold, 'view-blank', looseDir)
    const workspace = await scaffold.ctx.workspaceRegistry.create(workDir, '演示项目')
    await workspace.attachSession(workId)
    await scaffold.ctx.workspaceRegistry.archiveSession(archivedId)
    // 冷会话列表以目录名回退；先经真实恢复入口物化持久标题，再验证浏览范围。
    for (const sessionId of [workId, 'view-loose', 'view-older'] as SessionId[]) {
      const result = await scaffold.ctx.apiProxy.sessions.history({
        rpcId: `view-history-${sessionId}` as never, payload: { sessionId },
      })
      if (!result.result.ok) throw new Error('测试会话历史未能恢复')
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('#dsh-layout-sidebar [role="tablist"]').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('工作保留项目分组，对话仅显示未归属项目的会话，最近跨项目倒序', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-view-tabs-membership'))
    const sidebar = page.locator('#dsh-layout-sidebar')
    const tabs = sidebar.getByRole('tablist')
    const work = tabs.getByRole('tab', { name: 'Work', exact: true })
    const conversations = tabs.getByRole('tab', { name: 'Conversations', exact: true })
    const recent = tabs.getByRole('tab', { name: 'Recent', exact: true })
    expect(await work.getAttribute('aria-selected')).toBe('true')
    await sidebar.getByRole('treeitem').filter({ hasText: '演示项目' }).first().waitFor()
    expect(await sidebar.getByText(LOOSE_TITLE, { exact: true }).count()).toBe(0)
    const project = sidebar.getByRole('treeitem').filter({ hasText: '演示项目' }).first()
    if (await project.getAttribute('aria-expanded') !== 'true') {
      await sidebar.getByText('演示项目', { exact: true }).click()
    }
    await sidebar.getByText(WORK_TITLE, { exact: true }).waitFor()

    await conversations.click()
    await sidebar.getByText(LOOSE_TITLE, { exact: true }).waitFor()
    expect(await sidebar.getByText(WORK_TITLE, { exact: true }).count()).toBe(0)
    expect(await sidebar.getByText('演示项目', { exact: true }).count()).toBe(0)
    expect(await sidebar.getByText('不应显示的归档会话', { exact: true }).count()).toBe(0)
    expect(await sidebar.getByRole('treeitem').count()).toBe(2)

    await recent.click()
    await expect.poll(() => sidebar.getByRole('treeitem').allTextContents()).toMatchObject([
      expect.stringContaining(WORK_TITLE), expect.stringContaining(LOOSE_TITLE), expect.stringContaining(OLDER_TITLE),
    ])
    expect(await sidebar.getByRole('treeitem').first().getAttribute('draggable')).toBe('false')
    expect(await sidebar.getByRole('button', { name: 'View options', exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('内容搜索始终限制在当前范围，并可键盘切换及刷新恢复最近', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-view-tabs-search'))
    const sidebar = page.locator('#dsh-layout-sidebar')
    const tabs = sidebar.getByRole('tablist')
    await tabs.getByRole('tab', { name: 'Conversations', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Search sessions', exact: true }).click()
    const search = sidebar.getByPlaceholder('Search sessions', { exact: false })
    await search.fill('a.txt')
    await expect.poll(() => sidebar.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').count(), {
      timeout: 15_000,
    }).toBe(2)
    expect(await sidebar.getByText(WORK_TITLE, { exact: true }).count()).toBe(0)
    await tabs.getByRole('tab', { name: 'Work', exact: true }).click()
    await expect.poll(() => sidebar.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').count()).toBe(1)
    await sidebar.getByText(WORK_TITLE, { exact: true }).waitFor()
    expect(await sidebar.getByText(LOOSE_TITLE, { exact: true }).count()).toBe(0)
    await sidebar.getByRole('button', { name: 'Clear search', exact: true }).click()

    const work = tabs.getByRole('tab', { name: 'Work', exact: true })
    await work.focus()
    await work.press('End')
    const recent = tabs.getByRole('tab', { name: 'Recent', exact: true })
    expect(await recent.getAttribute('aria-selected')).toBe('true')
    expect(await recent.evaluate(element => document.activeElement === element)).toBe(true)
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => sidebar.getByRole('tab', { name: 'Recent', exact: true }).getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(3)
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    }))
    expect(metrics.width).toBe(metrics.viewportWidth)
    expect(metrics.height).toBe(metrics.viewportHeight)
  })
})
