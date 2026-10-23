/** Keenable MCP 提供方的行为：匿名/带密钥请求形状、协议错误分层、条数、取消与出站。 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime from 'coding-web'
import * as keepablePlugin from 'coding-web-search-keenable'
import { WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE } from 'coding-web-search-keenable'
import { KeenableSearchProvider, isValidBaseURL, isValidProxyURL, parseMcpResponseText, textBlockSources } from '../src/provider.ts'

const TEXT_PAYLOAD = [
  'Title: Cordis plugin guide',
  'URL: https://example.com/cordis',
  'Published: 2025-02-03',
  'Snippets:',
  'Cordis plugin architecture',
  'and usage notes',
  '',
  'Title: Keenable result two',
  'URL: https://example.com/two',
  'Acquired: N/A',
  'Snippets:',
  'second snippet',
].join('\n')

const TEXT_SOURCES = [
  {
    url: 'https://example.com/cordis',
    title: 'Cordis plugin guide',
    snippet: 'Cordis plugin architecture and usage notes',
    publishedAt: '2025-02-03',
  },
  { url: 'https://example.com/two', title: 'Keenable result two', snippet: 'second snippet' },
]

/** 一个成功响应：JSON-RPC 信封里装 `CallToolResult` 的单个 text 块。 */
function toolResult(text: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), {
    headers: { 'content-type': 'application/json' },
  })
}

/** 直接返回给定 JSON-RPC 信封的响应。 */
function envelope(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

/** 取第 n 次 fetch 调用的 URL 与 init，省掉每处断言里的类型断言。 */
function callOf(fetchMock: ReturnType<typeof vi.fn>, index: number): [string, Record<string, unknown>] {
  return fetchMock.mock.calls[index] as unknown as [string, Record<string, unknown>]
}

const previousApiKey = process.env.KEENABLE_API_KEY
beforeEach(() => { delete process.env.KEENABLE_API_KEY })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (previousApiKey === undefined) delete process.env.KEENABLE_API_KEY
  else process.env.KEENABLE_API_KEY = previousApiKey
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private doc: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(this.doc) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
    return Promise.resolve()
  }
}

describe('Keenable MCP response parsing', () => {
  it('parses a direct JSON envelope, SSE events and line-per-frame SSE', () => {
    expect(parseMcpResponseText('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(parseMcpResponseText(': connected\n\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    // 每行一个 data: 的实现：通知先行，结果后到。
    expect(parseMcpResponseText([
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}',
    ].join('\n'))).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    // 没有任何 result/error 的帧按最后可解析的回退。
    expect(parseMcpResponseText('data: {"jsonrpc":"2.0","method":"notifications/message"}'))
      .toEqual({ jsonrpc: '2.0', method: 'notifications/message' })
    expect(parseMcpResponseText('<html>bad gateway</html>')).toBeUndefined()
    expect(parseMcpResponseText('')).toBeUndefined()
  })

  it('maps reference text blocks, dropping duplicate and unsafe URLs', () => {
    expect(textBlockSources(TEXT_PAYLOAD)).toEqual(TEXT_SOURCES)
    expect(textBlockSources([
      'Title: duplicate',
      'URL: https://example.com/dup',
      '',
      'Title: again',
      'URL: https://example.com/dup',
      '',
      'Title: unsafe',
      'URL: ftp://example.com/file',
      '',
      'no url block',
    ].join('\n'))).toEqual([{ url: 'https://example.com/dup', title: 'duplicate' }])
  })

  it('prefers a JSON results[] payload and bounds model-visible fields', async () => {
    const payload = JSON.stringify({
      results: [
        { url: 'https://example.com/a', title: 'A', snippet: 'first' },
        { url: 'https://example.com/b', title: 'B', description: 'fallback description', published_at: '2025-05-06' },
        { url: 'https://example.com/a', title: 'duplicate' },
        { url: 'https://example.com/long', title: 'T'.repeat(400), snippet: 'S'.repeat(900) },
        { url: 'https://example.com/blank', title: '  ', snippet: '' },
        { url: 'https://example.com/dated', title: 'Dated', publishedAt: '2025-07-08' },
        { url: 42, title: 'not a URL' },
        { url: 'not a url' },
        { url: 'https://user:secret@example.com/private' },
        { url: `https://example.com/${'a'.repeat(2_100)}` },
        'not-a-record',
        { title: 'no url' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn(async () => toolResult(payload)))
    const result = await new KeenableSearchProvider().search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/long',
      'https://example.com/blank',
      'https://example.com/dated',
    ])
    expect(result.sources[1]).toEqual({
      url: 'https://example.com/b',
      title: 'B',
      snippet: 'fallback description',
      publishedAt: '2025-05-06',
    })
    expect(result.sources[2]?.title).toHaveLength(200)
    expect(result.sources[2]?.snippet).toHaveLength(500)
    expect(result.sources[3]).toEqual({ url: 'https://example.com/blank' })
    expect(result.sources[4]).toEqual({ url: 'https://example.com/dated', title: 'Dated', publishedAt: '2025-07-08' })
  })
})

describe('Keenable endpoint and proxy validation', () => {
  it('accepts only HTTPS endpoints without credentials, query, or fragment', () => {
    expect(isValidBaseURL('https://api.keenable.ai/mcp')).toBe(true)
    for (const raw of [
      'http://api.keenable.ai/mcp',
      'https://user:pw@api.keenable.ai/mcp',
      'https://api.keenable.ai/mcp?key=1',
      'https://api.keenable.ai/mcp#top',
      ' https://api.keenable.ai/mcp',
      'not a url',
      'https:\\\\api.keenable.ai\\mcp',
      `https://api.keenable.ai/${'a'.repeat(2_100)}`,
    ]) {
      expect(isValidBaseURL(raw)).toBe(false)
    }
  })

  it('accepts local HTTP proxies but rejects credentials and query strings', () => {
    expect(isValidProxyURL('http://127.0.0.1:8080')).toBe(true)
    expect(isValidProxyURL('https://proxy.example.com:443')).toBe(true)
    for (const raw of [
      'socks5://127.0.0.1:1080',
      'http://user:pw@127.0.0.1:8080',
      'http://127.0.0.1:8080/?token=x',
      'http://127.0.0.1:8080/#frag',
      ' http://127.0.0.1:8080',
      'ftp://127.0.0.1:8080',
      'http:\\\\127.0.0.1:8080',
      'not a url',
    ]) {
      expect(isValidProxyURL(raw)).toBe(false)
    }
  })
})

describe('Keenable provider', () => {
  it('searches anonymously with the reference JSON-RPC tools/call shape', async () => {
    const fetchMock = vi.fn(async () => toolResult(TEXT_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new KeenableSearchProvider().search({ query: 'cordis plugin' })
    expect(result).toEqual({ sources: TEXT_SOURCES, truncated: false })
    const [url, init] = callOf(fetchMock, 0)
    expect(url).toBe('https://api.keenable.ai/mcp')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers.accept).toBe('application/json, text/event-stream')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search_web_pages', arguments: { query: 'cordis plugin' } },
    })
  })

  it('sends a configured API key as a Bearer token', async () => {
    const fetchMock = vi.fn(async () => toolResult(TEXT_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await new KeenableSearchProvider({ resolveApiKey: () => 'sk-test' }).search({ query: 'q' })
    expect((callOf(fetchMock, 0)[1].headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('maps JSON results[] from the tool text and honors maxResults', async () => {
    const many = JSON.stringify({
      results: Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${String(index)}`, title: `T${String(index)}` })),
    })
    vi.stubGlobal('fetch', vi.fn(async () => toolResult(many)))
    const provider = new KeenableSearchProvider()
    expect((await provider.search({ query: 'q' })).sources).toHaveLength(10)
    expect((await provider.search({ query: 'q', maxResults: 2 })).sources).toHaveLength(2)
    expect((await provider.search({ query: 'q', maxResults: 50 })).sources).toHaveLength(20)
    expect((await provider.search({ query: 'q', maxResults: 0 })).sources).toHaveLength(1)
  })

  it('reports protocol failures readably instead of returning partial results', async () => {
    const provider = new KeenableSearchProvider()
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow('Keenable MCP error -32602: Invalid params')
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, error: {} })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Keenable MCP error \?: \{\}/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP result missing or malformed/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
    })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP tool error: quota exceeded/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { headers: { 'content-type': 'text/html' } })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP response is not valid JSON or SSE/)
  })

  it('reports HTTP status, empty bodies, oversized bodies and invalid UTF-8', async () => {
    const provider = new KeenableSearchProvider()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/HTTP 401\) - check the Keenable API key/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Keenable MCP error \(HTTP 429\)$/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/empty response body/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001))))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/exceeds the size limit/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff, 0xfe]))))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Keenable search request failed/)
  })

  it('returns an empty list when the tool text has no parsable records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: 'No results found.' }] },
    })))
    await expect(new KeenableSearchProvider().search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, result: {} })))
    await expect(new KeenableSearchProvider().search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('rejects unusable queries and endpoints before any request', async () => {
    const fetchMock = vi.fn(async () => toolResult(TEXT_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new KeenableSearchProvider().search({ query: '   ' })).rejects.toThrow(/1–2000 characters/)
    await expect(new KeenableSearchProvider().search({ query: 'q'.repeat(2_001) })).rejects.toThrow(/1–2000 characters/)
    await expect(new KeenableSearchProvider({ resolveBaseURL: () => 'http://insecure.test/mcp' }).search({ query: 'q' }))
      .rejects.toThrow(/baseURL must be an HTTPS URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(new KeenableSearchProvider().available()).toBe(true)
    expect(new KeenableSearchProvider({ resolveBaseURL: () => 'ftp://insecure.test' }).available()).toBe(false)
  })

  it('maps caller cancellation and the request timeout to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(new KeenableSearchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))

    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    const pending = new KeenableSearchProvider().search({ query: 'q' })
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await vi.advanceTimersByTimeAsync(12_000)
    await assertion
  })

  it('routes a custom outbound through a real proxy CONNECT without falling back to direct', async () => {
    const targets: string[] = []
    const proxy = createServer().on('connect', (request, socket) => {
      targets.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (proxy.address() as AddressInfo).port
      const direct = vi.fn(async () => toolResult(TEXT_PAYLOAD))
      vi.stubGlobal('fetch', direct)
      await new KeenableSearchProvider().search({ query: 'direct' })
      expect(direct).toHaveBeenCalledTimes(1)
      expect(targets).toEqual([])

      vi.stubGlobal('fetch', vi.fn(async () => toolResult(TEXT_PAYLOAD)))
      const proxied = new KeenableSearchProvider({
        resolveBaseURL: () => 'https://keenable.entry.test/mcp',
        resolveProxyURL: () => `http://127.0.0.1:${String(port)}`,
      })
      await expect(proxied.search({ query: 'proxied' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      expect(targets).toEqual(['keenable.entry.test:443'])
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
})

describe('Keenable plugin registration', () => {
  it('registers live settings, falls back to the environment and unloads cleanly', async () => {
    process.env.KEENABLE_API_KEY = 'env-key'
    const fetchMock = vi.fn(async () => toolResult(TEXT_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'keenable' })
      await (await ctx.plugin(MemorySettings)).await()
      const fiber = await ctx.plugin(keepablePlugin)
      await fiber.await()
      const first = await ctx.web.search({ query: 'cordis plugin' })
      expect(first.sources[0]?.url).toBe('https://example.com/cordis')
      expect((callOf(fetchMock, 0)[1].headers as Record<string, string>).authorization).toBe('Bearer env-key')

      await ctx.settings.update(WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE, {
        baseURL: 'https://keenable.gateway.test/mcp',
        apiKey: 'stored-key',
      })
      await ctx.web.search({ query: 'cordis plugin' })
      expect(callOf(fetchMock, 1)[0]).toBe('https://keenable.gateway.test/mcp')
      expect((callOf(fetchMock, 1)[1].headers as Record<string, string>).authorization).toBe('Bearer stored-key')

      await expect(ctx.settings.update(WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE, { baseURL: 'http://insecure.test/mcp' }))
        .rejects.toThrow(/web-search-keenable.baseURL/)
      await expect(ctx.settings.update(WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE, { outbound: { mode: 'custom', customUrl: 'socks5://127.0.0.1:1080' } }))
        .rejects.toThrow(/web-search-keenable.outbound/)

      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_KEENABLE_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'a' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
