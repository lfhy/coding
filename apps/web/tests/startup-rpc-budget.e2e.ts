// Cold-boot RPC budget. The describe mirror (packages/client/ui-settings) is
// the one `settings.describe` reader in the browser, so startup describe
// traffic stays bounded no matter how many client plugins own a preference.
// A regression here means a consumer bypassed the mirror — grep for
// `settings.describe(` outside ui-settings' client sources.
//
// Zero model calls: the lane only boots chrome, so no replay fixture mounts.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

/**
 * 镜像绑定时的预读与首次连接重置共用最多两次读取的预算：请求发出前的刷新
 * 可并入首次读取；请求在途或已完成后的重置需要补读，防止漏掉订阅前的提交。
 */
const DESCRIBE_BUDGET = 2

let scaffold: WebScaffold
let browser: Browser
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  browser = await chromium.launch()
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await scaffold?.close()
})

describe('startup RPC budget', () => {
  it('keeps cold-boot settings.describe within the mirror budget', async () => {
    page = await newEnglishPage(browser)
    watchConsole(page)
    const calls: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname.slice('/api/'.length))
    })
    await page.goto(scaffold.baseUrl)
    // 工作区选择器可交互后仍等待首次连接重置，预算必须覆盖它触发的读取。
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: 30_000 })
    await page.waitForTimeout(3000)
    const describeCount = calls.filter(method => method === 'settings.describe').length
    const diagnostics = `startup /api calls:\n${calls.join('\n')}`
    expect(describeCount, diagnostics).toBeGreaterThanOrEqual(1)
    expect(describeCount, diagnostics).toBeLessThanOrEqual(DESCRIBE_BUDGET)
  })
})
