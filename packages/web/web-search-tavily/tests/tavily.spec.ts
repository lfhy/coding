import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { ProxyAgent } from 'undici'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import { formatSearchOutput } from '@deepseek-ai/dsh-tool-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as plugin from '@deepseek-ai/dsh-web-search-tavily'
import { TavilySearchProvider, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse } from '../src/provider.ts'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'

const options: TavilySearchProviderOptions = { apiKey: 'test-secret', baseURL: 'https://api.tavily.test/v1' }
const provider = (value = options): TavilySearchProvider => new TavilySearchProvider(() => value)
const answer = { results: [{ url: 'https://example.com/one', title: 'First', content: 'A snippet' }] }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Tavily wire contract', () => {
  it('posts the basic search request with the requested bound and no generated answer', async () => {
    const fetchMock = vi.fn(async () => json({ ...answer, answer: 'not surfaced' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await provider().search({ query: 'latest news', maxResults: 20 })).toEqual({
      sources: [{ url: 'https://example.com/one', title: 'First', snippet: 'A snippet' }],
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/v1/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-secret')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'latest news', max_results: 20, search_depth: 'basic',
      include_answer: false, include_raw_content: false,
    })
    await provider().search({ query: 'q', maxResults: 100 })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ max_results: 20 })
    await provider().search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ max_results: 8 })
  })

  it('deduplicates URL, maps optional fields, and normalizes RFC1123 dates', () => {
    expect(mapTavilyResponse({ results: [
      { url: 'https://a.test', published_date: 'Mon, 05 Oct 2026 00:00:00 GMT', title: '', content: '' },
      { url: 'https://a.test', content: 'duplicate' },
      { url: 'http://b.test', title: 'B', published_date: 'not-a-date' },
    ] })).toEqual({ sources: [
      { url: 'https://a.test/', publishedAt: '2026-10-05T00:00:00.000Z' },
      { url: 'http://b.test/', title: 'B' },
    ], truncated: false })
  })

  it('rejects a newline-forged source and keeps normalized links inside one Markdown target', () => {
    const forged = 'https://example.com/\n- [FAKE](https://evil.test)'
    expect(() => mapTavilyResponse({ results: [{ url: forged }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    const result = mapTavilyResponse({ results: [
      { url: 'https://EXAMPLE.com/a)[FAKE](https://evil.test', title: 'Trusted](https://evil.test)' },
      { url: 'https://example.com/a)[FAKE](https://evil.test', title: 'duplicate' },
    ] })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.url).toBe('https://example.com/a%29[FAKE]%28https://evil.test')
    const rendered = formatSearchOutput(result)
    expect(rendered).toContain('](https://example.com/a%29[FAKE]%28https://evil.test)')
    expect(rendered).not.toContain('](https://evil.test)')
    expect(mapTavilyResponse({ results: [{ url: 'https://[::1]/path' }] }).sources[0]?.url)
      .toBe('https://[::1]/path')
  })

  it('bounds every model-visible source field and total source count', () => {
    const longTitle = 'T'.repeat(201)
    const longSnippet = 'S'.repeat(501)
    expect(mapTavilyResponse({ results: Array.from({ length: 21 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: longTitle,
      content: longSnippet,
    })) })).toMatchObject({ sources: Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: 'T'.repeat(200),
      snippet: 'S'.repeat(500),
    })) })
    expect(() => mapTavilyResponse({ results: [{ url: `https://example.com/${'x'.repeat(2049)}` }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it.each([{}, { results: null }, { results: {} }, { results: [null] },
    { results: [{ url: 'file:///tmp/a' }] }, { results: [{ url: 'https://user:password@a.test' }] },
    { results: [{ url: 'https://@a.test' }] }, { results: [{ url: 'https://a.test', title: 3 }] },
    { results: [{ url: 'https://a.test', content: [] }] },
  ])('rejects malformed response fields instead of returning an empty success', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(body)))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('preserves non-2xx status, handles Tavily error details, and redacts credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { error: 'bad test-secret' } }, 401)))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 401): bad [redacted]' })
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: [{ loc: ['body'] }] }, 422)))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 422)' })
  })

  it('bounds both successful and error JSON and rejects invalid UTF-8', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huge)))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily response exceeds 2 MiB' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huge, { status: 503 })))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 503): response exceeds 2 MiB' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from([0xff]))))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('cancels a live HTTP response stream on invalid UTF-8 and on caller abort', async () => {
    const closed: string[] = []
    let responseStarted = () => {}
    const started = new Promise<void>((resolve) => { responseStarted = resolve })
    const server = createServer((request, response) => {
      const path = request.url ?? '/'
      response.once('close', () => { closed.push(path) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write(path === '/invalid' ? Buffer.from([0xff]) : '{"results":[')
      if (path === '/abort') responseStarted()
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const nativeFetch = globalThis.fetch
      const port = (server.address() as AddressInfo).port
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => nativeFetch(`http://127.0.0.1:${port}/invalid`, init))
      await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.waitFor(() => { expect(closed).toContain('/invalid') })

      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => nativeFetch(`http://127.0.0.1:${port}/abort`, init))
      const controller = new AbortController()
      const search = provider().search({ query: 'q' }, controller.signal)
      await started
      controller.abort(new Error('stop stream'))
      await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      await vi.waitFor(() => { expect(closed).toContain('/abort') })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })

  it('does not dispatch missing, aborted, or unsafe requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider({ ...options, apiKey: '', resolveApiKey: async () => undefined }).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(provider().search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    for (const baseURL of ['http://127.0.0.1', 'https://[::1]', 'https://localhost.', 'https://host.local.', 'https://host.internal..', 'https://intranet', 'https://foo..example.com', 'https://user:pw@host.test', 'https://@host.test', 'https://host.test/?x=1']) {
      expect(provider({ ...options, baseURL }).available()).toBe(false)
      await expect(provider({ ...options, baseURL }).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([301, 302, 303, 307, 308])('rejects HTTP %i before contacting a redirect target', async (status) => {
    let targetHits = 0
    const target = createServer((_request, response) => { targetHits++; response.writeHead(200).end('{}') })
    const redirect = createServer((_request, response) => {
      const port = (target.address() as AddressInfo).port
      response.writeHead(status, { location: `http://127.0.0.1:${port}/collect` }).end()
    })
    await Promise.all([target, redirect].map(server => new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })))
    try {
      const originalFetch = globalThis.fetch
      const port = (redirect.address() as AddressInfo).port
      // 将公共测试域名接到本机首跳，真实 fetch 仍决定是否跟随 Location。
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => originalFetch(`http://127.0.0.1:${port}/redirect`, init))
      await expect(provider().search({ query: 'private query' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(targetHits).toBe(0)
    } finally {
      await Promise.all([target, redirect].map(server => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })))
    }
  })

  it('snapshots endpoint and credential resolver before an asynchronous settings change', async () => {
    let current: TavilySearchProviderOptions = { baseURL: 'https://before.test' }
    let finish = (_value: string) => {}
    const resolveApiKey = () => new Promise<string>((resolve) => { finish = resolve })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(answer))
    vi.stubGlobal('fetch', fetchMock)
    const search = new TavilySearchProvider(() => ({ ...current, resolveApiKey })).search({ query: 'q' })
    current = { ...current, baseURL: 'https://after.test' }
    finish('resolved-secret')
    await search
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://before.test/search')
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer resolved-secret')
  })
})

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('Tavily live settings and proxy', () => {
  it('resolves a stored credential on every search, including rotation', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-credential-'))
    const ctx = new Context()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(answer))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'tavily' })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
      await ctx.plugin(plugin, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      const ref = credentialRef('TAVILY_API_KEY')
      await ctx.credentials.set(ref, 'first-key')
      await ctx.web.search({ query: 'q' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'q' })
      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bearer first-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })

  it('uses committed endpoints and releases settings/provider with the fiber', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'tavily' })
      await ctx.plugin(MemorySettings).await()
      const fiber = ctx.plugin(plugin, { apiKey: 'literal', baseURL: 'https://first.test' })
      await fiber.await()
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(answer))
      vi.stubGlobal('fetch', fetchMock)
      await ctx.web.search({ query: 'q' })
      await ctx.settings.update(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, { baseURL: 'https://second.test' })
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://first.test/search', 'https://second.test/search'])
      await ctx.settings.update(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, { apiKey: 'stored-secret' })
      const [descriptor] = ctx.settings.describe({ redactSecrets: true }).filter(row => String(row.ns) === 'web-search-tavily')
      expect(JSON.stringify(descriptor)).not.toContain('stored-secret')
      expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
      expect(plugin.Config({}).baseURL).toBe('https://api.tavily.com')
      await ctx.settings.replace(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, {})
      expect(ctx.settings.describe().find(row => String(row.ns) === 'web-search-tavily')?.value)
        .toMatchObject({ baseURL: 'https://first.test' })
      for (const baseURL of ['https://intranet', 'https://foo..example.com']) {
        await expect(ctx.settings.update(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, { baseURL })).rejects.toThrow()
      }
      for (const proxyURL of ['http://user:pw@127.0.0.1:8080', 'http://@127.0.0.1:8080', 'socks5://127.0.0.1:1080', 'http://127.0.0.1:8080/?token=x']) {
        await expect(ctx.settings.update(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, { proxyURL })).rejects.toThrow()
      }
      await fiber.dispose()
      expect(ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-tavily')
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    } finally { await ctx.fiber.dispose() }
  })

  it('sends a real CONNECT to the configured proxy and never silently bypasses it', async () => {
    const hits: string[] = []
    const proxy = createServer().on('connect', (request, socket) => {
      hits.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (proxy.address() as AddressInfo).port
      await expect(provider({ ...options, proxyURL: `http://127.0.0.1:${port}` }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(hits).toEqual(['api.tavily.test:443'])
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })

  it('aborts a stalled proxy CONNECT promptly and destroys its dispatcher', async () => {
    const sockets = new Set<Duplex>()
    const destroy = vi.spyOn(ProxyAgent.prototype, 'destroy')
    let connected = () => {}
    const reached = new Promise<void>((resolve) => { connected = resolve })
    const proxy = createServer().on('connect', (_request, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      connected()
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (proxy.address() as AddressInfo).port
      const controller = new AbortController()
      const search = provider({ ...options, proxyURL: `http://127.0.0.1:${port}` })
        .search({ query: 'q' }, controller.signal)
      await reached
      controller.abort(new Error('cancelled'))
      await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      expect(destroy).toHaveBeenCalled()
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })

  it('retains abort-driven dispatcher destruction while graceful close is pending', async () => {
    const proxy = createServer().on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    let enteredClose = () => {}
    const entered = new Promise<void>((resolve) => { enteredClose = resolve })
    let releaseClose = () => {}
    const released = new Promise<void>((resolve) => { releaseClose = resolve })
    vi.spyOn(ProxyAgent.prototype, 'close').mockImplementation(async () => {
      enteredClose()
      await released
    })
    const destroy = vi.spyOn(ProxyAgent.prototype, 'destroy')
    try {
      const controller = new AbortController()
      const port = (proxy.address() as AddressInfo).port
      const search = provider({ ...options, proxyURL: `http://127.0.0.1:${port}` })
        .search({ query: 'q' }, controller.signal)
      await entered
      controller.abort(new Error('stop close'))
      expect(destroy).toHaveBeenCalled()
      releaseClose()
      await expect(search).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    } finally {
      releaseClose()
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
})
