import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as duckduckgoPlugin from '@deepseek-ai/dsh-web-search-duckduckgo'
import { WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-duckduckgo'
import { DuckDuckGoSearchProvider, isValidProxyURL, parseDuckDuckGoResults } from '../src/provider.ts'

const HTML = `<!doctype html><html><body>
  <div class="result results_links">
    <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost%3Fa%3D1">Example &amp; title</a></h2>
    <a class="result__snippet" href="https://example.com/post?a=1">Useful <b>snippet</b></a>
  </div>
  <div class="result"><a class="result__a" href="https://example.com/post?a=1">Duplicate</a></div>
  <div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
</body></html>`

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
  it('validates HTTP(S) proxy addresses including local and IP hosts without saving URL credentials', () => {
    for (const url of ['http://localhost:8080', 'https://127.0.0.1:443', 'http://[::1]:7890']) {
      expect(isValidProxyURL(url), url).toBe(true)
    }
    for (const url of ['socks5://localhost:1080', 'http://user:password@localhost:8080', 'http://@localhost:8080', 'http://localhost:8080?', 'http://localhost:8080#', 'not-a-url']) {
      expect(isValidProxyURL(url), url).toBe(false)
    }
  })

  it('rejects an invalid composition proxy at request time before network dispatch', async () => {
    const directFetch = vi.fn()
    vi.stubGlobal('fetch', directFetch)
    await expect(new DuckDuckGoSearchProvider(() => 'http://user:pass@localhost:8080').search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('uses the current settings on the next search and sends a real CONNECT through the configured proxy', async () => {
    const targets: string[] = []
    const proxy = createServer()
    proxy.on('connect', (request, socket) => {
      targets.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyURL = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
    const directFetch = vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', directFetch)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'duckduckgo' })
      await (await ctx.plugin(MemorySettings)).await()
      await (await ctx.plugin(duckduckgoPlugin)).await()
      expect(await ctx.web.search({ query: 'first' })).toMatchObject({ sources: [{ url: 'https://example.com/post?a=1' }] })

      await ctx.settings.update(WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, { proxyURL })
      await expect(ctx.web.search({ query: 'second' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      expect(targets).toEqual(['html.duckduckgo.com:443'])
      expect(directFetch).toHaveBeenCalledTimes(1)

      await ctx.settings.replace(WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, {})
      await expect(ctx.web.search({ query: 'third' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/post?a=1' }] })
      expect(directFetch).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
      await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
    }
  })

  it('rejects invalid settings before persistence and releases its namespace on unload', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'duckduckgo' })
      await (await ctx.plugin(MemorySettings)).await()
      const fiber = await ctx.plugin(duckduckgoPlugin)
      await fiber.await()
      for (const proxyURL of ['http://user:password@localhost:8080', 'http://localhost:8080?key=secret', 'https://localhost#fragment', 'socks5://localhost:1080']) {
        await expect(ctx.settings.update(WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, { proxyURL })).rejects.toThrow()
      }
      expect(ctx.settings.describe().find(row => row.ns === WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE)?.user).toBeUndefined()
      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aborts an in-flight CONNECT and frees its socket', async () => {
    const sockets = new Set<Duplex>()
    let started!: () => void
    const connected = new Promise<void>((resolve) => { started = resolve })
    const proxy = createServer()
    proxy.on('connect', (_request, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('end', () => socket.end())
      socket.resume()
      started()
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyURL = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
    const controller = new AbortController()
    try {
      const search = new DuckDuckGoSearchProvider(() => proxyURL).search({ query: 'cancel' }, controller.signal)
      await connected
      controller.abort()
      await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
      await vi.waitFor(() => { expect(sockets.size).toBe(0) })
    } finally {
      controller.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
    }
  })

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
