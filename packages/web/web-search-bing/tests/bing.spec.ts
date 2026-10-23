import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime from 'coding-web'
import * as bingPlugin from 'coding-web-search-bing'
import { WEB_SEARCH_BING_SETTINGS_NAMESPACE } from 'coding-web-search-bing'
import { BingSearchProvider, looksRelevant, parseBingResults } from '../src/provider.ts'

// a1 + base64url("https://example.com/bing?q=1")：Bing 的 ck/a 跳转链接形状。
const CK_A_HREF = 'https://www.bing.com/ck/a?!&&p=0&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9iaW5nP3E9MQ==&ntb=1'

const HTML = `<!doctype html><html><body><ol id="b_results">
  <li class="b_algo"><h2><a href="${CK_A_HREF}">Example &amp; 标题</a></h2><div class="b_caption"><p class="b_lineclamp4">Useful <b>snippet</b> &#39;quoted&#39;</p></div></li>
  <li class="b_algo"><h2><a href="${CK_A_HREF}">Duplicate entry</a></h2></li>
  <li class="b_algo"><h2><a href="javascript:alert(1)">Unsafe</a></h2></li>
  <li class="b_algo"><div class="b_caption">no anchor here</div></li>
</ol></body></html>`

afterEach(() => vi.unstubAllGlobals())

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private doc: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(this.doc) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
    return Promise.resolve()
  }
}

describe('Bing SERP mapping', () => {
  it('extracts citation target, title and snippet with entity decoding and dedupe', () => {
    expect(parseBingResults(HTML)).toEqual({
      sources: [{ url: 'https://example.com/bing?q=1', title: 'Example & 标题', snippet: 'Useful snippet \'quoted\'' }],
      truncated: false,
    })
  })

  it('returns an empty list for a page without b_algo blocks', () => {
    expect(parseBingResults('<html><body>No exact results.</body></html>').sources).toEqual([])
  })

  it('bounds results and model-visible fields from unusually large HTML', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      `<li class="b_algo"><h2><a href="https://example.com/${String(index)}">${'T'.repeat(400)}</a></h2><p>${'S'.repeat(900)}</p></li>`)
    const result = parseBingResults(rows.join(''))
    expect(result.sources).toHaveLength(20)
    expect(result.sources[0]?.title).toHaveLength(200)
    expect(result.sources[0]?.snippet).toHaveLength(500)
  })
})

describe('Bing relevance guard', () => {
  it('keeps pages whose results overlap the query tokens', () => {
    expect(looksRelevant('cordis plugin', [{ url: 'https://github.com/cordiverse/cordis' }])).toBe(true)
    expect(looksRelevant('深度学习 入门', [{ url: 'https://example.com/ai', title: '深度学习教程' }])).toBe(true)
  })

  it('rejects cached SERPs that share no token with the query', () => {
    expect(looksRelevant('rust async runtime', [
      { url: 'https://fund.example.ch/', title: 'Fonds de placement', snippet: 'Sicherheit und Ertrag' },
    ])).toBe(false)
  })

  it('does not block symbol-only queries', () => {
    expect(looksRelevant('++', [{ url: 'https://example.com/' }])).toBe(true)
  })
})

describe('Bing provider', () => {
  it('sends only q by default and forwards market as mkt with a matching Accept-Language', async () => {
    const fetchMock = vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'text/html; charset=UTF-8' } }))
    vi.stubGlobal('fetch', fetchMock)
    const direct = new BingSearchProvider()
    await expect(direct.search({ query: 'a & b', maxResults: 1 })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/bing?q=1' }] })
    let [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://www.bing.com/search?q=a+%26+b')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>)['accept-language']).toBe('zh-CN,en;q=0.8')
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^Mozilla\/5\.0/)

    const localized = new BingSearchProvider(() => 'zh-CN')
    await localized.search({ query: 'a' })
    ;[url, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://www.bing.com/search?q=a&mkt=zh-CN')
    expect((init.headers as Record<string, string>)['accept-language']).toBe('zh-CN,zh;q=0.9,en;q=0.8')
  })

  it('returns empty instead of unrelated cached results and honors maxResults', async () => {
    const cached = `<ol>${Array.from({ length: 4 }, (_, i) => `<li class="b_algo"><h2><a href="https://news.example.org/${String(i)}">Unrelated cached headline ${String(i)}</a></h2><p>Contenu sans rapport</p></li>`).join('')}</ol>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(cached, { headers: { 'content-type': 'text/html' } })))
    const provider = new BingSearchProvider()
    await expect(provider.search({ query: 'cordis plugin architecture' })).resolves.toEqual({ sources: [], truncated: false })

    const relevant = `<ol>${Array.from({ length: 4 }, (_, i) => `<li class="b_algo"><h2><a href="https://github.com/${String(i)}">cordis plugin guide ${String(i)}</a></h2><p>plugin usage</p></li>`).join('')}</ol>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(relevant, { headers: { 'content-type': 'text/html' } })))
    const result = await provider.search({ query: 'cordis plugin', maxResults: 2 })
    expect(result.sources.map(source => source.url)).toEqual(['https://github.com/0', 'https://github.com/1'])
  })

  it('rejects oversized responses and non-HTML content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001), { headers: { 'content-type': 'text/html' } })))
    await expect(new BingSearchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
    await expect(new BingSearchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps caller cancellation to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(new BingSearchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('applies a request timeout as an abort', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
        })))
      const pending = new BingSearchProvider().search({ query: 'q' })
      const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
      await vi.advanceTimersByTimeAsync(12_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers through the plugin with settings validation and unload', async () => {
    const fetchMock = vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'bing' })
      await (await ctx.plugin(MemorySettings)).await()
      const fiber = await ctx.plugin(bingPlugin)
      await fiber.await()
      await expect(ctx.web.search({ query: 'example bing' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/bing?q=1' }] })

      await ctx.settings.update(WEB_SEARCH_BING_SETTINGS_NAMESPACE, { market: 'zh-CN' })
      await expect(ctx.web.search({ query: 'example bing' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/bing?q=1' }] })
      expect(String((fetchMock.mock.calls.at(-1) as unknown as [URL])[0])).toBe('https://www.bing.com/search?q=example+bing&mkt=zh-CN')

      await expect(ctx.settings.update(WEB_SEARCH_BING_SETTINGS_NAMESPACE, { market: 'not a market!' })).rejects.toThrow()
      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_BING_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'a' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
