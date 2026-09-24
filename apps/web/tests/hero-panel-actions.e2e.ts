/** 无会话 Hero 的双面板入口经真实 Web 装配创建空白会话并保持面板独立。 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SIDEBAR = '#dsh-layout-sidebar'
const WORKBENCH = '#dsh-layout-workbench'
const BOTTOM = '#dsh-layout-workbench-bottom'

describe('web e2e: no-session Hero panel actions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator(SIDEBAR).waitFor({ timeout: 30_000 })
    await page.getByTestId('hero-greeting').waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens only the requested panel while retaining the left navigation', async () => {
    const sidebar = page.locator(SIDEBAR)
    const frame = sidebar.locator('..')
    const hero = page.locator('[data-phase="hero"]')
    const workbench = page.locator(WORKBENCH)
    const bottom = page.locator(BOTTOM)
    const bottomButton = hero.getByRole('button', { name: 'Show terminal panel' })
    const filesButton = hero.getByRole('button', { name: 'Show files sidebar' })

    // 初始态无会话也显示两个 Hero 按钮；关闭的面板仍挂载，但不在可访问树中。
    expect(scaffold.ctx.sessions.list()).toEqual([])
    expect(await hero.count()).toBe(1)
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBeNull()
    expect(await frame.getAttribute('data-workbench-shown')).toBeNull()
    expect(await frame.getAttribute('data-bottom-open')).toBeNull()
    expect(await bottomButton.getAttribute('aria-pressed')).toBe('false')
    expect(await filesButton.getAttribute('aria-pressed')).toBe('false')
    expect(await workbench.getAttribute('aria-hidden')).toBe('true')
    expect(await bottom.getAttribute('aria-hidden')).toBe('true')
    const sidebarBox = await sidebar.boundingBox()
    expect(sidebarBox).not.toBeNull()

    await bottomButton.click()
    await expect.poll(() => frame.getAttribute('data-bottom-open'), { timeout: 15_000 }).toBe('true')
    expect(scaffold.ctx.sessions.list()).toHaveLength(1)
    expect(await frame.getAttribute('data-workbench-shown')).toBeNull()
    expect(await workbench.getAttribute('aria-hidden')).toBe('true')
    expect(await workbench.getAttribute('inert')).toBe('')
    expect(await bottom.getAttribute('aria-hidden')).toBeNull()
    expect(await bottom.getAttribute('inert')).toBeNull()
    const hideBottom = hero.getByRole('button', { name: 'Hide terminal panel' })
    await expect.poll(() => hideBottom.getAttribute('aria-pressed')).toBe('true')
    expect(await filesButton.getAttribute('aria-pressed')).toBe('false')
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBeNull()
    expect((await sidebar.boundingBox())?.width).toBe(sidebarBox!.width)

    // Hero 仍在空白会话中，原按钮可收起底栏；切到文件时不连带重开底栏。
    await hideBottom.click()
    await expect.poll(() => frame.getAttribute('data-bottom-open')).toBeNull()
    expect(await bottom.getAttribute('aria-hidden')).toBe('true')
    expect(await bottom.getAttribute('inert')).toBe('')
    await filesButton.click()
    await expect.poll(() => frame.getAttribute('data-workbench-shown'), { timeout: 15_000 }).toBe('true')
    expect(await frame.getAttribute('data-bottom-open')).toBeNull()
    expect(await workbench.getAttribute('aria-hidden')).toBeNull()
    expect(await workbench.getAttribute('inert')).toBeNull()
    expect(await bottom.getAttribute('aria-hidden')).toBe('true')
    expect(await bottom.getAttribute('inert')).toBe('')
    expect(await page.getByRole('region', { name: 'File workbench' }).count()).toBe(1)
    expect(await page.getByRole('complementary', { name: 'Workspace files' }).count()).toBe(1)
    expect(await hero.getByRole('button', { name: 'Hide files sidebar' }).getAttribute('aria-pressed')).toBe('true')
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBeNull()
    expect((await sidebar.boundingBox())?.width).toBe(sidebarBox!.width)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
