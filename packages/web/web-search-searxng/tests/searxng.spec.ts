import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime from 'coding-web'
import { ProxyAgent } from 'undici'
import * as searxngPlugin from 'coding-web-search-searxng'
import { SEARXNG_INSTANCES, WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE } from 'coding-web-search-searxng'
import {
  isValidInstanceURL,
  normalizeInstanceBase,
  parseSearxngResults,
  SearxngSearchProvider,
} from '../src/provider.ts'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function jsonResponse(results: readonly unknown[]): Response {
  return new Response(JSON.stringify({ results }), { headers: JSON_HEADERS })
}

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

describe('SearXNG JSON mapping', () => {
  it('maps url/title/content to sources and drops duplicate or unsafe URLs', () => {
    expect(parseSearxngResults(JSON.stringify({
      results: [
        { url: 'https://example.com/a', title: 'Example A', content: 'Snippet A' },
        { url: 'https://example.com/a', title: 'Duplicate' },
        { url: 'javascript:alert(1)', title: 'Unsafe scheme' },
        { url: 'https://user:pass@example.com/b', title: 'Credential URL' },
        { url: 'https://example.com/c' },
        'not-an-object',
      ],
    }))).toEqual({
      sources: [
        { url: 'https://example.com/a', title: 'Example A', snippet: 'Snippet A' },
        { url: 'https://example.com/c' },
      ],
      truncated: false,
    })
  })

  it('bounds the count and model-visible field lengths', () => {
    const results = Array.from({ length: 30 }, (_, index) => ({
      url: `https://example.com/${String(index)}`,
      title: 'T'.repeat(400),
      content: 'S'.repeat(900),
    }))
    const parsed = parseSearxngResults(JSON.stringify({ results }))
    expect(parsed.sources).toHaveLength(20)
    expect(parsed.sources[0]?.title).toHaveLength(200)
    expect(parsed.sources[0]?.snippet).toHaveLength(500)
  })

  it('rejects invalid JSON and unexpected JSON shapes', () => {
    expect(() => parseSearxngResults('<html>not json</html>'))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => parseSearxngResults(JSON.stringify({ suggestions: [] })))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('SearXNG instance addresses', () => {
  it('accepts only credential-free http(s) base URLs and normalizes trailing slashes', () => {
    expect(isValidInstanceURL('https://searx.example')).toBe(true)
    expect(isValidInstanceURL('http://127.0.0.1:8080/searxng/')).toBe(true)
    expect(isValidInstanceURL('ftp://searx.example')).toBe(false)
    expect(isValidInstanceURL('https://user:pass@searx.example')).toBe(false)
    expect(isValidInstanceURL('https://searx.example/?q=1')).toBe(false)
    expect(isValidInstanceURL('https://searx.example/#top')).toBe(false)
    expect(isValidInstanceURL(' https://searx.example')).toBe(false)
    expect(normalizeInstanceBase('https://searx.example/')).toBe('https://searx.example')
    expect(normalizeInstanceBase('https://searx.example/sub/')).toBe('https://searx.example/sub')
    expect(normalizeInstanceBase('searx.example')).toBeUndefined()
  })
})

describe('SearXNG provider', () => {
  it('asks the JSON endpoint of the first instance and honors maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { url: 'https://example.com/1', title: 'One', content: 'First' },
      { url: 'https://example.com/2', title: 'Two', content: 'Second' },
      { url: 'https://example.com/3', title: 'Three', content: 'Third' },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new SearxngSearchProvider(() => ['https://searx.test']).search({ query: 'a & b', maxResults: 2 })
    expect(result).toEqual({
      sources: [
        { url: 'https://example.com/1', title: 'One', snippet: 'First' },
        { url: 'https://example.com/2', title: 'Two', snippet: 'Second' },
      ],
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://searx.test/search?q=a+%26+b&format=json')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).accept).toBe('application/json')
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^Mozilla\/5\.0/)
  })

  it('fails over to the next instance when the first one errors', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      calls.push(String(input))
      if (calls.length === 1) return new Response('nope', { status: 503, headers: JSON_HEADERS })
      return jsonResponse([{ url: 'https://example.com/backup', title: 'Backup' }])
    }))
    const result = await new SearxngSearchProvider(() => ['https://broken.test', 'https://backup.test']).search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://example.com/backup'])
    expect(calls).toEqual(['https://broken.test/search?q=q&format=json', 'https://backup.test/search?q=q&format=json'])
  })

  it('aggregates every failure reason when no instance answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
      if (String(input).startsWith('https://broken.test')) return new Response('nope', { status: 500, headers: JSON_HEADERS })
      throw new TypeError('connection refused')
    }))
    const search = new SearxngSearchProvider(() => ['https://broken.test', 'https://offline.test']).search({ query: 'q' })
    await expect(search).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(search).rejects.toThrow(/^all SearXNG instances failed: .*broken\.test: HTTP 500.*offline\.test: connection refused/)
  })

  it('reports an empty resolved instance list instead of silently succeeding', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SearxngSearchProvider(() => []).search({ query: 'q' }))
      .rejects.toThrow(/no configured instance/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the built-in public instances when the plugin has no custom list', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ url: 'https://example.com/builtin', title: 'Builtin' }]))
    vi.stubGlobal('fetch', fetchMock)
    const withDefaults = new SearxngSearchProvider(() => SEARXNG_INSTANCES)
    await expect(withDefaults.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/builtin' }] })
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe(`${SEARXNG_INSTANCES[0]}/search?q=q&format=json`)
  })

  it('skips an unusable custom instance and names it in the aggregated error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ url: 'https://example.com/ok', title: 'Ok' }]))
    vi.stubGlobal('fetch', fetchMock)
    const search = new SearxngSearchProvider(() => ['ftp://nope.test']).search({ query: 'q' })
    await expect(search).rejects.toThrow(/all SearXNG instances failed: instance 1: unusable instance URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an empty result instead of an error when an instance answers with no results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => String(input).startsWith('https://broken.test')
      ? new Response('nope', { status: 500, headers: JSON_HEADERS })
      : jsonResponse([])))
    await expect(new SearxngSearchProvider(() => ['https://broken.test', 'https://empty.test']).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('rejects oversized and non-JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001), { headers: JSON_HEADERS })))
    await expect(new SearxngSearchProvider(() => ['https://searx.test']).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'text/html' } })))
    await expect(new SearxngSearchProvider(() => ['https://searx.test']).search({ query: 'q' }))
      .rejects.toThrow(/non-JSON response/)
  })

  it('times out a stalled instance after 8 seconds and moves to the next one', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
        if (String(input).startsWith('https://stalled.test')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
          })
        }
        return jsonResponse([{ url: 'https://example.com/next', title: 'Next' }])
      })
      vi.stubGlobal('fetch', fetchMock)
      const pending = new SearxngSearchProvider(() => ['https://stalled.test', 'https://backup.test']).search({ query: 'q' })
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(pending).resolves.toMatchObject({ sources: [{ url: 'https://example.com/next' }] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps caller cancellation to WEB_ABORTED without contacting any instance', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const aborted = new AbortController()
    aborted.abort()
    await expect(new SearxngSearchProvider(() => ['https://searx.test']).search({ query: 'q' }, aborted.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a mid-flight caller cancellation to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    const pending = new SearxngSearchProvider(() => ['https://searx.test', 'https://backup.test']).search({ query: 'q' }, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('SearXNG outbound', () => {
  it('sends the request through a custom proxy and destroys its dispatcher', async () => {
    const hits: string[] = []
    const proxy = createServer().on('connect', (request, socket) => {
      hits.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    const destroy = vi.spyOn(ProxyAgent.prototype, 'destroy')
    try {
      const port = (proxy.address() as AddressInfo).port
      const search = new SearxngSearchProvider(
        () => ['https://searx.test'],
        () => `http://127.0.0.1:${String(port)}`,
      ).search({ query: 'cordis' })
      await expect(search).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      // 请求走代理隧道而不是直连，且失败后 dispatcher 被销毁而不是优雅关闭。
      expect(hits).toEqual(['searx.test:443'])
      expect(destroy).toHaveBeenCalled()
    } finally {
      destroy.mockRestore()
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
})

describe('SearXNG plugin wiring', () => {
  it('registers through the plugin, forwards custom instances and unloads', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ url: 'https://example.com/a', title: 'Example A', content: 'Snippet A' }]))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
      await (await ctx.plugin(MemorySettings)).await()
      const fiber = await ctx.plugin(searxngPlugin)
      await fiber.await()
      await expect(ctx.web.search({ query: 'example' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/a' }] })
      expect(String((fetchMock.mock.calls.at(-1) as unknown as [URL])[0])).toBe(`${SEARXNG_INSTANCES[0]}/search?q=example&format=json`)

      await ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, { instances: ['https://custom.test/'] })
      await ctx.web.search({ query: 'example' })
      expect(String((fetchMock.mock.calls.at(-1) as unknown as [URL])[0])).toBe('https://custom.test/search?q=example&format=json')

      await expect(ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, { instances: ['https://user:secret@custom.test'] })).rejects.toThrow()
      await expect(ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, { instances: ['https://custom.test/?q=1'] })).rejects.toThrow()
      await expect(ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, { outbound: { mode: 'custom', customUrl: 'socks5://127.0.0.1:1080' } })).rejects.toThrow()
      await expect(ctx.settings.update(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, { outbound: { mode: 'custom', customUrl: 'http://user:pass@127.0.0.1:8080' } })).rejects.toThrow()

      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'a' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
