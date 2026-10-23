/** Parallel MCP 提供方的行为：匿名/带密钥请求形状、协议错误分层、条数、取消与出站。 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime from 'coding-web'
import * as parallelPlugin from 'coding-web-search-parallel'
import { WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE } from 'coding-web-search-parallel'
import { ParallelSearchProvider, isValidBaseURL, isValidProxyURL, parseMcpResponseText } from '../src/provider.ts'

const RESULTS_PAYLOAD = JSON.stringify({
  results: [
    { url: 'https://example.com/a', title: 'Parallel A', excerpts: ['first excerpt', 'second excerpt'], publish_date: '2025-03-04' },
    { url: 'https://example.com/b', title: 'Parallel B', description: 'description fallback' },
  ],
})

const RESULTS_SOURCES = [
  { url: 'https://example.com/a', title: 'Parallel A', snippet: 'first excerpt', publishedAt: '2025-03-04' },
  { url: 'https://example.com/b', title: 'Parallel B', snippet: 'description fallback' },
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

/** JSON-RPC `tools/call` 请求体里本测试断言得到的字段。 */
interface ToolCallBody {
  readonly jsonrpc: string
  readonly method: string
  readonly params: { readonly name: string; readonly arguments: Record<string, unknown> }
}

/** 解析第 n 次 fetch 调用的 JSON-RPC 请求体。 */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index: number): ToolCallBody {
  return JSON.parse(String(callOf(fetchMock, index)[1].body)) as ToolCallBody
}

const previousApiKey = process.env.PARALLEL_API_KEY
beforeEach(() => { delete process.env.PARALLEL_API_KEY })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (previousApiKey === undefined) delete process.env.PARALLEL_API_KEY
  else process.env.PARALLEL_API_KEY = previousApiKey
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

describe('Parallel MCP response parsing', () => {
  it('parses a direct JSON envelope, SSE events and line-per-frame SSE', () => {
    expect(parseMcpResponseText('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(parseMcpResponseText(': connected\n\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\n'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(parseMcpResponseText([
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}',
    ].join('\n'))).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    expect(parseMcpResponseText('data: {"jsonrpc":"2.0","method":"notifications/message"}'))
      .toEqual({ jsonrpc: '2.0', method: 'notifications/message' })
    expect(parseMcpResponseText('<html>bad gateway</html>')).toBeUndefined()
    expect(parseMcpResponseText('')).toBeUndefined()
  })

  it('maps excerpts and bounds model-visible fields', async () => {
    const payload = JSON.stringify({
      results: [
        { url: 'https://example.com/a', title: 'A', excerpts: ['  ', 'first excerpt'], snippet: 'ignored snippet' },
        { url: 'https://example.com/b', title: 'B', excerpts: [], snippet: 'snippet fallback', publishedAt: '2025-06-07' },
        { url: 'https://example.com/c', title: 'C', excerpts: ['E'.repeat(900)] },
        { url: 'https://example.com/a', title: 'duplicate' },
        { url: 'https://example.com/long', title: 'T'.repeat(400), snippets: ['ignored'] },
        { url: 42, title: 'not a URL' },
        { url: 'not a url' },
        { url: 'https://user:secret@example.com/private' },
        { url: `https://example.com/${'a'.repeat(2_100)}` },
        'not-a-record',
        { title: 'no url' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn(async () => toolResult(payload)))
    const result = await new ParallelSearchProvider().search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/long',
    ])
    expect(result.sources[0]).toEqual({ url: 'https://example.com/a', title: 'A', snippet: 'first excerpt' })
    expect(result.sources[1]).toEqual({
      url: 'https://example.com/b',
      title: 'B',
      snippet: 'snippet fallback',
      publishedAt: '2025-06-07',
    })
    expect(result.sources[2]?.snippet).toHaveLength(500)
    expect(result.sources[3]?.title).toHaveLength(200)
    expect(result.sources[3]?.snippet).toBeUndefined()
  })
})

describe('Parallel endpoint and proxy validation', () => {
  it('accepts only HTTPS endpoints without credentials, query, or fragment', () => {
    expect(isValidBaseURL('https://search.parallel.ai/mcp')).toBe(true)
    for (const raw of [
      'http://search.parallel.ai/mcp',
      'https://user:pw@search.parallel.ai/mcp',
      'https://search.parallel.ai/mcp?key=1',
      'https://search.parallel.ai/mcp#top',
      ' https://search.parallel.ai/mcp',
      'not a url',
      'https:\\\\search.parallel.ai\\mcp',
      `https://search.parallel.ai/${'a'.repeat(2_100)}`,
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

describe('Parallel provider', () => {
  it('searches anonymously with the reference JSON-RPC web_search shape', async () => {
    const fetchMock = vi.fn(async () => toolResult(RESULTS_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new ParallelSearchProvider()
    const result = await provider.search({ query: 'cordis plugin' })
    expect(result).toEqual({ sources: RESULTS_SOURCES, truncated: false })
    const [url, init] = callOf(fetchMock, 0)
    expect(url).toBe('https://search.parallel.ai/mcp')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers.accept).toBe('application/json, text/event-stream')
    const body = bodyOf(fetchMock, 0)
    expect(body.jsonrpc).toBe('2.0')
    expect(body.method).toBe('tools/call')
    expect(body.params.name).toBe('web_search')
    expect(body.params.arguments.objective).toBe('cordis plugin')
    expect(body.params.arguments.search_queries).toEqual(['cordis plugin'])
    expect(body.params.arguments.session_id).toMatch(/^[0-9a-f]{32}$/)
    // 同一实例复用同一个匿名会话标识。
    await provider.search({ query: 'again' })
    expect(bodyOf(fetchMock, 1).params.arguments.session_id).toBe(body.params.arguments.session_id)
  })

  it('sends a configured API key as a Bearer token', async () => {
    const fetchMock = vi.fn(async () => toolResult(RESULTS_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await new ParallelSearchProvider({ resolveApiKey: () => 'pk-test' }).search({ query: 'q' })
    expect((callOf(fetchMock, 0)[1].headers as Record<string, string>).authorization).toBe('Bearer pk-test')
  })

  it('maps JSON results[] from the tool text and honors maxResults', async () => {
    const many = JSON.stringify({
      results: Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${String(index)}`, title: `T${String(index)}` })),
    })
    vi.stubGlobal('fetch', vi.fn(async () => toolResult(many)))
    const provider = new ParallelSearchProvider()
    expect((await provider.search({ query: 'q' })).sources).toHaveLength(10)
    expect((await provider.search({ query: 'q', maxResults: 2 })).sources).toHaveLength(2)
    expect((await provider.search({ query: 'q', maxResults: 50 })).sources).toHaveLength(20)
    expect((await provider.search({ query: 'q', maxResults: 0 })).sources).toHaveLength(1)
  })

  it('reports protocol failures readably instead of returning partial results', async () => {
    const provider = new ParallelSearchProvider()
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow('Parallel MCP error -32600: Invalid Request')
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, error: {} })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Parallel MCP error \?: \{\}/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP result missing or malformed/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'rate limited' }] },
    })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP tool error: rate limited/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { headers: { 'content-type': 'text/html' } })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/MCP response is not valid JSON or SSE/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'upstream error' }] } })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/no parsable search results/)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ jsonrpc: '2.0', id: 1, result: {} })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/no parsable search results/)
  })

  it('reports HTTP status, empty bodies, oversized bodies and invalid UTF-8', async () => {
    const provider = new ParallelSearchProvider()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/HTTP 403\) - check the Parallel API key/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Parallel MCP error \(HTTP 429\)$/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/empty response body/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001))))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/exceeds the size limit/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff, 0xfe]))))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/Parallel search request failed/)
  })

  it('rejects unusable queries and endpoints before any request', async () => {
    const fetchMock = vi.fn(async () => toolResult(RESULTS_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new ParallelSearchProvider().search({ query: '   ' })).rejects.toThrow(/1–2000 characters/)
    await expect(new ParallelSearchProvider().search({ query: 'q'.repeat(2_001) })).rejects.toThrow(/1–2000 characters/)
    await expect(new ParallelSearchProvider({ resolveBaseURL: () => 'http://insecure.test/mcp' }).search({ query: 'q' }))
      .rejects.toThrow(/baseURL must be an HTTPS URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(new ParallelSearchProvider().available()).toBe(true)
    expect(new ParallelSearchProvider({ resolveBaseURL: () => 'ftp://insecure.test' }).available()).toBe(false)
  })

  it('maps caller cancellation and the request timeout to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(new ParallelSearchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))

    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    const pending = new ParallelSearchProvider().search({ query: 'q' })
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
      const direct = vi.fn(async () => toolResult(RESULTS_PAYLOAD))
      vi.stubGlobal('fetch', direct)
      await new ParallelSearchProvider().search({ query: 'direct' })
      expect(direct).toHaveBeenCalledTimes(1)
      expect(targets).toEqual([])

      vi.stubGlobal('fetch', vi.fn(async () => toolResult(RESULTS_PAYLOAD)))
      const proxied = new ParallelSearchProvider({
        resolveBaseURL: () => 'https://parallel.entry.test/mcp',
        resolveProxyURL: () => `http://127.0.0.1:${String(port)}`,
      })
      await expect(proxied.search({ query: 'proxied' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      expect(targets).toEqual(['parallel.entry.test:443'])
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
})

describe('Parallel plugin registration', () => {
  it('registers live settings, reads keys from settings only, and unloads cleanly', async () => {
    process.env.PARALLEL_API_KEY = 'env-key'
    const fetchMock = vi.fn(async () => toolResult(RESULTS_PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
      await (await ctx.plugin(MemorySettings)).await()
      const fiber = await ctx.plugin(parallelPlugin)
      await fiber.await()
      const first = await ctx.web.search({ query: 'cordis plugin' })
      expect(first.sources[0]?.url).toBe('https://example.com/a')
      // 环境变量不再作为密钥来源：未配置密钥时按匿名额度请求。
      expect((callOf(fetchMock, 0)[1].headers as Record<string, string>).authorization).toBeUndefined()

      await ctx.settings.update(WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE, {
        baseURL: 'https://parallel.gateway.test/mcp',
        apiKey: 'stored-key',
      })
      await ctx.web.search({ query: 'cordis plugin' })
      expect(callOf(fetchMock, 1)[0]).toBe('https://parallel.gateway.test/mcp')
      expect((callOf(fetchMock, 1)[1].headers as Record<string, string>).authorization).toBe('Bearer stored-key')

      await expect(ctx.settings.update(WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE, { baseURL: 'http://insecure.test/mcp' }))
        .rejects.toThrow(/web-search-parallel.baseURL/)
      await expect(ctx.settings.update(WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE, { outbound: { mode: 'custom' } }))
        .rejects.toThrow(/web-search-parallel.outbound/)

      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_PARALLEL_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'a' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
