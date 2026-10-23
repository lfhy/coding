import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from 'coding-web'
import {
  PerplexitySearchProvider,
  PERPLEXITY_PROVIDER_ID,
} from 'coding-web-search-perplexity'
import * as perplexityPlugin from 'coding-web-search-perplexity'
import { mapPerplexityResponse } from '../src/provider.ts'

const options = { resolveApiKey: async () => 'pplx-key', baseURL: 'https://api.perplexity.test', model: 'sonar', maxTokens: 1024 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Perplexity response mapping', () => {
  it('maps the answer and prefers structured search_results', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'the answer' } }],
      search_results: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', date: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      citations: ['https://ignored.test'],
    })
    expect(result).toEqual({
      content: 'the answer',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', publishedAt: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('falls back to URL-only citations when search_results is absent', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'answer' } }],
      citations: ['https://a.test', 'https://b.test'],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }, { url: 'https://b.test' }])
  })

  it('omits content when the answer is empty or missing', () => {
    expect(mapPerplexityResponse({ citations: [] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: '' } }] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: null } }] }).content).toBeUndefined()
  })

  it('omits null/empty optional source fields', () => {
    const result = mapPerplexityResponse({
      search_results: [{ url: 'https://a.test', title: null, snippet: '', date: null }],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('yields no sources when neither search_results nor citations are present', () => {
    expect(mapPerplexityResponse({ choices: [{ message: { content: 'a' } }] }).sources).toEqual([])
  })
})

describe('PerplexitySearchProvider availability', () => {
  it('reports a missing key when searching', async () => {
    // 可用性不再依赖已解析出的密钥；密钥在请求期解析，缺失时搜索报不可用。
    const provider = new PerplexitySearchProvider({ ...options, resolveApiKey: async () => undefined })
    expect(provider.available()).toBe(true)
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })

  it('is available with a key', () => {
    expect(new PerplexitySearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new PerplexitySearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxTokens is not a positive integer', () => {
    expect(new PerplexitySearchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(new PerplexitySearchProvider({ ...options, maxTokens: 1.5 }).available()).toBe(false)
  })
})

describe('PerplexitySearchProvider request mapping', () => {
  it('sends a chat-completions request with the query, model and max_tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new PerplexitySearchProvider(options).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.test/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer pplx-key')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'sonar', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] })
  })

  it('sends search_recency_filter when configured, and omits it otherwise', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new PerplexitySearchProvider({ ...options, searchRecency: 'week' }).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ search_recency_filter: 'week' })

    await new PerplexitySearchProvider(options).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('search_recency_filter')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new PerplexitySearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('PerplexitySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'bad request' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_results: null }, { status: 200 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 503)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 500)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new PerplexitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-perplexity plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'a', sources: [] })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('resolves the outbound through the proxy pool contract', async () => {
    const targets: string[] = []
    const proxy = (await import('node:http')).createServer()
    proxy.on('connect', (request, socket) => {
      targets.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyURL = `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      const disposePool = ctx.provide('proxyPool', { proxyURL: () => proxyURL })
      // 未配置出站时直连：请求不经过任何代理。
      const direct = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
      vi.stubGlobal('fetch', direct)
      const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', baseURL: 'https://api.pplx.test' })
      await ctx.web.search({ query: 'direct' })
      expect(direct).toHaveBeenCalledTimes(1)
      expect(targets).toEqual([])
      await fiber.dispose()
      // mode: pool 时取池地址；custom 时用自己的地址且不受池影响。
      for (const outbound of [{ mode: 'pool' as const }, { mode: 'custom' as const, customUrl: proxyURL }]) {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [], citations: [] })))
        const proxiedFiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', baseURL: 'https://api.pplx.test', outbound })
        await expect(ctx.web.search({ query: 'proxied' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
        expect(targets).toEqual(['api.pplx.test:443'])
        targets.length = 0
        await proxiedFiber.dispose()
      }
      disposePool()
      await ctx.fiber.dispose()
    } finally {
      await new Promise<void>(resolve => proxy.close(() => { resolve() }))
    }
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in perplexityPlugin).toBe(false)
  })

  it('threads maxTokens and searchRecency config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', maxTokens: 256, searchRecency: 'month' })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_tokens: 256, search_recency_filter: 'month' })
    await fiber.dispose()
  })

  it('uses the documented defaults when config omits base URL and model', async () => {
    // 环境变量不再参与密钥解析；默认基址与默认模型仍按部署常量生效。
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new PerplexitySearchProvider({ ...options, resolveApiKey: async () => 'pplx-key' })
    await provider.search({ query: 'q' })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.perplexity.test/chat/completions')
  })

  it('rejects a search when no key is configured anywhere', async () => {
    // 密钥只来自配置与凭据服务；都没有时搜索明确失败，而不是静默降级。
    const provider = new PerplexitySearchProvider({ ...options, resolveApiKey: async () => undefined })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })
})
