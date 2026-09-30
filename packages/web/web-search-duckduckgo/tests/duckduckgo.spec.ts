import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as duckduckgoPlugin from '@deepseek-ai/dsh-web-search-duckduckgo'
import { DuckDuckGoSearchProvider, parseDuckDuckGoResults } from '../src/provider.ts'

const HTML = `<!doctype html><html><body>
  <div class="result results_links">
    <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost%3Fa%3D1">Example &amp; title</a></h2>
    <a class="result__snippet" href="https://example.com/post?a=1">Useful <b>snippet</b></a>
  </div>
  <div class="result"><a class="result__a" href="https://example.com/post?a=1">Duplicate</a></div>
  <div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
</body></html>`

afterEach(() => vi.unstubAllGlobals())

describe('DuckDuckGo HTML mapping', () => {
  it('extracts citation target, title and snippet without redirect or script URLs', () => {
    expect(parseDuckDuckGoResults(HTML)).toEqual({
      sources: [{ url: 'https://example.com/post?a=1', title: 'Example & title', snippet: 'Useful snippet' }],
      truncated: false,
    })
  })

  it('rejects challenge or unrelated HTML instead of reporting a successful empty search', () => {
    expect(() => parseDuckDuckGoResults('<html><body>captcha challenge</body></html>'))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('permits an explicit no-results page', () => {
    expect(parseDuckDuckGoResults('<html><body>No results found.</body></html>').sources).toEqual([])
  })

  it('bounds results and model-visible fields from unusually large HTML', () => {
    const rows = Array.from({ length: 30 }, (_, index) => `<div class="result"><a class="result__a" href="https://example.com/${String(index)}">${'T'.repeat(400)}</a><div class="result__snippet">${'S'.repeat(900)}</div></div>`)
    const result = parseDuckDuckGoResults(rows.join(''))
    expect(result.sources).toHaveLength(20)
    expect(result.sources[0]?.title).toHaveLength(200)
    expect(result.sources[0]?.snippet).toHaveLength(500)
  })
})

describe('DuckDuckGo provider', () => {
  it('sends only the query to the fixed HTTPS origin and rejects redirects', async () => {
    const fetchMock = vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'text/html; charset=UTF-8' } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'duckduckgo' })
    const fiber = await ctx.plugin(duckduckgoPlugin)
    await expect(ctx.web.search({ query: 'a & b', maxResults: 1 })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/post?a=1' }] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://html.duckduckgo.com/html/?q=a+%26+b')
    expect(init).toMatchObject({ redirect: 'error' })
    expect(JSON.stringify(init)).not.toMatch(/authorization|api.?key/i)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'a' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    await ctx.fiber.dispose()
  })

  it('rejects oversized responses and non-HTML content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001), { headers: { 'content-type': 'text/html' } })))
    await expect(new DuckDuckGoSearchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
    await expect(new DuckDuckGoSearchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('never visits a redirect target', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      throw new TypeError('redirect blocked')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new DuckDuckGoSearchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(new DuckDuckGoSearchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})
