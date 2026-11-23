// Shared plumbing for the web smoke tests (dist location, free port, failure shots).
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'

/** The built page under test; `pnpm run test:web` rebuilds it before running. */
export const DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** 无 Host 语言偏好的中文测试仍固定浏览器语言，以免混入浏览器环境变化。 */
export const ZH_BROWSER_LOCALE = 'zh-CN'

/**
 * 用 en-US 浏览器打开英文测试页面。语言由测试 Host 的显式 `locale.preference: en`
 * 决定；浏览器语言本身不能覆盖产品默认的中文。
 * @param browser - 持有页面的 Playwright 浏览器。
 * @param height - 视口高度；宽度固定为测试基线。
 * @returns 创建好的页面。
 */
export async function newEnglishPage(browser: Browser, height = 1000): Promise<Page> {
  return await browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US' })
}

/**
 * 侧栏里的会话行。一个工作区都没有时侧栏默认停在「对话」范围，会话直接平铺成
 * treeitem；出现工作区后回到带分组的工作范围，此时分组标题行同样是 treeitem，
 * 未归组的会话在默认折叠的 Ungrouped 分组下。只打开一条种子会话的场景应取
 * 第一行；需要特定会话时按标题或序号再收窄。
 * @param page - the page under test.
 * @returns 侧栏会话列表的 treeitem 定位器。
 */
export function sidebarTreeItems(page: Page): Locator {
  return page.locator('#dsh-layout-sidebar').getByRole('treeitem')
}

/**
 * 点选侧栏「浏览会话」范围的页签；没有工作区时没有 Work 页签。仅适用于英文页面。
 * @param page - the page under test.
 * @param name - 目标范围页签的 accessible name。
 * @returns 页签定位器。
 */
export function sidebarViewTab(page: Page, name: 'Work' | 'Conversations' | 'Recent'): Locator {
  return page.locator('#dsh-layout-sidebar')
    .getByRole('tablist', { name: 'Browse sessions' })
    .getByRole('tab', { name, exact: true })
}

/**
 * 切到侧栏的「对话」范围并返回其平铺会话行。建立了工作区后侧栏回到工作范围，只列
 * 归属工作区的会话；种子会话等不属于任何工作区的会话只在「对话」里。没有工作区时
 * 该范围本就是默认，重复点选不改变状态。仅适用于英文页面。
 * @param page - the page under test.
 * @returns 「对话」范围内的会话行定位器（至少一行可见后返回）。
 */
export async function openSidebarConversations(page: Page): Promise<Locator> {
  await sidebarViewTab(page, 'Conversations').click()
  const rows = sidebarTreeItems(page)
  await rows.first().waitFor({ timeout: 15_000 })
  return rows
}

/**
 * 展开对话页头的会话概览卡并返回该区域。概览在对话列窄于 1388px 时默认收起（测试
 * 基线 1680px 视口正落在这一档），且切换会话或重新加载后回到默认；要读取协作行、
 * 后台任务或运行统计的场景先经页头开关展开，已展开时不做任何事。
 * @param page - the page under test.
 * @returns 「Session overview」区域的定位器。
 */
export async function openSessionOverview(page: Page): Promise<Locator> {
  const region = page.getByRole('region', { name: 'Session overview' })
  if (!(await region.isVisible())) {
    await page.getByRole('button', { name: 'Expand session overview' }).first().click()
    await region.waitFor({ state: 'visible' })
  }
  return region
}

/** Fail loud on a stale checkout instead of testing yesterday's bundle. */
export function requireDist(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error('web app dist not built — run `pnpm run build` from the repository root (`pnpm run test:web` does this first)')
  }
}

/** OS-assigned free port, released before use (the spawned `dsh web` needs a concrete --port). */
export function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

/**
 * 经 Hero 工作区菜单的“打开文件夹”入口走完已组合的目录对话框，直到真实
 * 编辑器解锁。新环境没有 Workspace，启动选择也没有目标；所有要向编辑器输入
 * 的场景都先经此流程建立一个本地 Workspace。选择器会先呈现所有开始路径，
 * 测试显式选取本地文件夹入口，而不是依赖旧的自动跳转。目录通过路径编辑器
 * 暂存并接纳，重复调用仍是幂等的；对话框内新建文件夹的另一半路径由
 * workspace-management.e2e.ts 覆盖。默认名称 `workspace` 使会话页头 cwd
 * 保持为 <root>/workspace，供多个场景断言物化结果。
 * @param page - the page under test.
 * @param root - host directory the workspace folder is staged in (the scaffold's `workspaceCwd`).
 * @param name - folder name staged and adopted as the workspace.
 */
export async function connectFreshWorkspace(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  await page.getByRole('menuitem', { name: 'Open folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  // 接纳完成后空白会话的真实编辑器替换锁定占位并启用。
  await page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    .waitFor({ timeout: 15_000 })
}

/**
 * 在中文页面中执行 {@link connectFreshWorkspace}，使用本地化后的选择器文案。
 * @param page - the browser page under test.
 * @param root - workspace parent directory.
 * @param name - directory created under `root` and connected.
 */
export async function connectFreshWorkspaceZh(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: '选择工作区' }).click()
  await page.getByRole('menuitem', { name: '打开文件夹' }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    .waitFor({ timeout: 15_000 })
}

/** Failure evidence goes to the gitignored .artifacts/ (repo convention). */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  } catch {
    // Best-effort evidence: a dead page/browser at failure time must not mask the real assertion error.
  }
}

/**
 * The conversation engine's Context key format, restated here rather than
 * imported: these specs live in the Host compiler aggregate, which must not
 * reach the Client plane. The engine's own copy is
 * `conversationContextKey` in dsh-client-runtime; a drift between them makes
 * the key miss its rendered node, so the assertion fails loudly.
 * @param kind - Definition kind.
 * @param id - Definition-local business identity.
 * @returns the engine-owned Context key.
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}
