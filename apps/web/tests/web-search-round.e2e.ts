// 默认搜索组合的浏览器端到端场景：模型流使用回放，真实 DuckDuckGo
// 提供方的固定 HTML 请求由本地 fixture 接管，不访问搜索公网。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { WEB_SEARCH_MAX_RESULTS } from '@deepseek-ai/dsh-tool-web'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/web-search-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/web-search-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/web-search-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const QUERIES = ['DeepSeek Harness snapshot search', 'DeepSeek Harness multi-query search'] as const
const PROMPT = `Use web_search once with queries ${JSON.stringify(QUERIES)}. Then reply exactly SEARCH_DONE and stop.`

/**
 * 每个查询提供六条真实解析器可读取的来源；合并后超过默认上限，
 * 保留下来的八条也足以让卡片来源列表出现滚动。
 */
const PROVIDER_RESULT_COUNT = 6

function resultUrl(queryIndex: number, ordinal: number): string {
  return `https://docs.example.test/search/${queryIndex + 1}/${ordinal}`
}

function resultTitle(queryIndex: number, ordinal: number): string {
  return `Snapshot Search ${queryIndex + 1} Result ${ordinal}`
}

function resultSnippet(queryIndex: number, ordinal: number): string {
  return `Snapshot search ${queryIndex + 1} excerpt ${ordinal}: the harness replays this source list from a local HTML fixture.`
}

const RESULT_ORDINALS = Array.from({ length: PROVIDER_RESULT_COUNT }, (_value, index) => index + 1)

const KEPT_SOURCES = RESULT_ORDINALS.flatMap(ordinal => QUERIES.map((_query, queryIndex) => ({
  url: resultUrl(queryIndex, ordinal),
  title: resultTitle(queryIndex, ordinal),
  snippet: resultSnippet(queryIndex, ordinal),
}))).slice(0, WEB_SEARCH_MAX_RESULTS)

const DROPPED_SOURCE_URLS = RESULT_ORDINALS.flatMap(ordinal => QUERIES.map(
  (_query, queryIndex) => resultUrl(queryIndex, ordinal),
)).slice(WEB_SEARCH_MAX_RESULTS)

interface CapturedSearchRequest {
  url: string
  init: RequestInit | undefined
}

/** 生成真实解析器读取的 HTML，并通过 uddg 验证原始来源 URL 的还原。 */
function searchHtml(queryIndex: number): string {
  const rows = RESULT_ORDINALS.map(ordinal => `
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(resultUrl(queryIndex, ordinal))}">${resultTitle(queryIndex, ordinal)}</a>
      <div class="result__snippet">${resultSnippet(queryIndex, ordinal)}</div>
    </div>`)
  return `<!doctype html><html><body>${rows.join('')}</body></html>`
}

describe('web e2e: shipped default web search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let originalFetch: typeof fetch
  let settledSessionId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const searchRequests: CapturedSearchRequest[] = []
  const unexpectedHostRequests: string[] = []
  const unexpectedBrowserRequests: string[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://html.duckduckgo.com' && url.pathname === '/html/') {
        searchRequests.push({ url: url.href, init })
        const queryIndex = QUERIES.findIndex(query => query === url.searchParams.get('q'))
        if (queryIndex < 0) throw new Error(`unexpected DuckDuckGo fixture query: ${url.href}`)
        return Promise.resolve(new Response(searchHtml(queryIndex), {
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }))
      }
      if (MODE === 'record' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        return originalFetch(input, init)
      }
      unexpectedHostRequests.push(url.href)
      throw new Error(`unexpected external Host request: ${url.href}`)
    }
    scaffold = await launchWebScaffold({
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
        await route.continue()
        return
      }
      unexpectedBrowserRequests.push(url.href)
      await route.abort()
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      if (originalFetch !== undefined) globalThis.fetch = originalFetch
    }
  })

  it('drives the recorded search to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-drive'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    settledSessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, settledSessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('uses default DuckDuckGo and persists the capped structured result', () => {
    expect(searchRequests).toHaveLength(QUERIES.length)
    for (const query of QUERIES) {
      const request = searchRequests.find(candidate => new URL(candidate.url).searchParams.get('q') === query)
      if (request === undefined) throw new Error(`missing provider request for query: ${query}`)
      expect(request.url).toBe(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`)
      expect(request.init).toMatchObject({ redirect: 'error', headers: { accept: 'text/html' } })
      expect(request.init?.body).toBeUndefined()
      expect(JSON.stringify(request.init)).not.toMatch(/authorization|api.?key/i)
    }
    expect(sessionEvents.filter(event => event.type === 'web/deepseek-search-llm-request')).toEqual([])
    expect(unexpectedHostRequests).toEqual([])
    expect(unexpectedBrowserRequests).toEqual([])

    const searchCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'web_search',
    )
    if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
    const searchResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
    )
    if (searchResult === undefined) throw new Error('web_search produced no durable result')
    const content = searchResult.data.message.content[0]
    expect(content.isError).toBe(false)
    const rendered = content.content.filter(block => block.type === 'text').map(block => block.text).join('')
    // 合并结果先交错排列再截断，每个查询的来源都应进入持久化的模型上下文。
    for (const source of KEPT_SOURCES) {
      expect(rendered).toContain(`[${source.title}](${source.url})`)
    }
    for (const url of DROPPED_SOURCE_URLS) {
      expect(rendered).not.toContain(url)
    }
    expect(rendered).toContain(
      `(Showing the first ${WEB_SEARCH_MAX_RESULTS} sources. Refine the query for more.)`,
    )
    expect(searchResult.data.meta).toMatchObject({
      sources: KEPT_SOURCES,
      truncated: true,
    })
    const history = scaffold.ctx.sessions.get(settledSessionId)?.deriveMessages()
    if (history === undefined) throw new Error('the settled search session was not retained')
    const modelHistory = JSON.stringify(history)
    for (const source of KEPT_SOURCES) expect(modelHistory).toContain(source.url)
    for (const url of DROPPED_SOURCE_URLS) expect(modelHistory).not.toContain(url)
  })

  it.skipIf(MODE === 'record')('matches the settled search card aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-aria'))
    await expect.poll(() => page.getByText('SEARCH_DONE', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await page.locator('[data-tool="web_search"]').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('scrolls the capped source list inside the fixed-height container', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-sources-scroll'))
    const row = page.locator('[data-tool="web_search"] [data-expandable]').first()
    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')

    const card = page.locator('[data-web="search"]')
    const sources = card.locator('ol')
    await sources.waitFor({ timeout: 10_000 })
    // The card draws exactly the sources the model saw after the combined cap.
    expect(await sources.locator('li').count()).toBe(WEB_SEARCH_MAX_RESULTS)
    // The list is complete in the DOM, so the card carries no expand control.
    expect(await card.locator('button').count()).toBe(0)
    expect(await card.getByText('来源列表已截断').isVisible()).toBe(true)

    const geometry = await sources.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        maxHeight: computed.maxHeight,
        overflowY: computed.overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }
    })
    expect(geometry.maxHeight).toBe('320px')
    expect(geometry.overflowY).toBe('auto')
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  })

  it.skipIf(MODE === 'record')('reserves marker room a scroll container cannot clip back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-marker-room'))
    // `overflow-y: auto` clips inline-start overflow with no way to scroll it
    // back, and markers are right-aligned to the content edge, so a marker wider
    // than `padding-left` silently loses its leading digits. `searchMaxResults`
    // is an unbounded positive integer, so measure the widest three-digit marker
    // in the list's own font and require the shipped padding to hold it.
    const marker = await page.locator('[data-web="search"] ol').evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit'
      probe.textContent = '999. '
      element.append(probe)
      const widest = probe.getBoundingClientRect().width
      probe.remove()
      return { widest, paddingLeft: parseFloat(getComputedStyle(element).paddingLeft) }
    })
    expect(marker.paddingLeft).toBeGreaterThanOrEqual(marker.widest)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(unexpectedHostRequests).toEqual([])
    expect(unexpectedBrowserRequests).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
