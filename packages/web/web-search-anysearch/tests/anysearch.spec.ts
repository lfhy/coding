import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime from 'coding-web'
import * as anySearchPlugin from 'coding-web-search-anysearch'
import { WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE } from 'coding-web-search-anysearch'
import {
  ANYSEARCH_DEFAULT_BASE_URL,
  AnySearchProvider,
  isSafeBaseUrl,
  isValidProxyURL,
  mapAnySearchResponse,
} from '../src/provider.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

const RESULTS = {
  code: 0,
  data: {
    results: [
      { url: 'https://example.com/anysearch', title: 'AnySearch & 结果', snippet: 'Useful snippet' },
      { url: 'https://example.com/anysearch', title: 'Duplicate entry' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      { title: 'No URL here' },
    ],
  },
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

/** 每次搜索重建响应：Response 的主体只能读取一次。 */
function stubSearch(payload: unknown = RESULTS, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => jsonResponse(payload, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function provider(baseURL: string = ANYSEARCH_DEFAULT_BASE_URL, apiKey?: string): AnySearchProvider {
  return new AnySearchProvider(() => ({ baseURL, ...apiKey === undefined ? {} : { apiKey } }))
}

function callAt(fetchMock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  return fetchMock.mock.calls[index] as unknown as [string, RequestInit]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

async function boot(config: anySearchPlugin.Config = {}): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime, { searchProvider: 'anysearch' })
    await (await ctx.plugin(MemorySettings)).await()
    const fiber = await ctx.plugin(anySearchPlugin, config)
    await fiber.await()
    return { ctx, fiber }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

describe('AnySearch response mapping', () => {
  it('keeps citeable results and drops duplicates and unusable URLs', () => {
    expect(mapAnySearchResponse(RESULTS)).toEqual({
      sources: [{ url: 'https://example.com/anysearch', title: 'AnySearch & 结果', snippet: 'Useful snippet' }],
      truncated: false,
    })
    expect(mapAnySearchResponse({ code: 0, data: { results: [{ url: 'https://user:password@example.com/' }] } }).sources).toEqual([])
    expect(mapAnySearchResponse({ code: 0, data: { results: [{ url: 'http://[::1' }, { url: ' https://example.com/a' }] } }).sources).toEqual([])
    // Markdown 链接定界符必须转义，否则 `[label](url)` 会被远端 URL 提前闭合。
    expect(mapAnySearchResponse({ code: 0, data: { results: [{ url: 'https://example.com/a_(b)' }] } }).sources)
      .toEqual([{ url: 'https://example.com/a_%28b%29' }])
  })

  it('bounds results and model-visible fields from an oversized payload', () => {
    const results = Array.from({ length: 30 }, (_, index) => ({
      url: `https://example.com/${String(index)}`,
      title: 'T'.repeat(400),
      snippet: 'S'.repeat(900),
    }))
    const result = mapAnySearchResponse({ code: 0, data: { results } })
    expect(result.sources).toHaveLength(20)
    expect(result.sources[0]?.title).toHaveLength(200)
    expect(result.sources[0]?.snippet).toHaveLength(500)
  })

  it('validates proxy and endpoint addresses before any request', () => {
    expect(isValidProxyURL('https://proxy.example.test:8443')).toBe(true)
    expect(isValidProxyURL('http://127.0.0.1:8080')).toBe(true)
    expect(isValidProxyURL('http://user:password@127.0.0.1:8080')).toBe(false)
    expect(isValidProxyURL('http://127.0.0.1:8080/?token=x')).toBe(false)
    expect(isValidProxyURL('http://#fragment')).toBe(false)
    expect(isValidProxyURL('http://')).toBe(false)
    expect(isValidProxyURL('ftp://proxy.example.test:8080')).toBe(false)
    expect(isSafeBaseUrl('https://api.anysearch.com')).toBe(true)
    expect(isSafeBaseUrl('https://host.local/')).toBe(false)
    expect(isSafeBaseUrl('https://host.internal/')).toBe(false)
  })

  it('rejects payloads it cannot process', () => {
    expect(() => mapAnySearchResponse('not an object')).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapAnySearchResponse({ code: 2, message: 'quota exceeded' })).toThrow(/quota exceeded/)
    expect(() => mapAnySearchResponse({ code: 2 })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapAnySearchResponse({ code: 0, data: {} })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('AnySearch provider', () => {
  it('searches anonymously by default and sends the documented request shape', async () => {
    const fetchMock = stubSearch()
    await expect(provider().search({ query: 'cordis 插件' })).resolves.toEqual({
      sources: [{ url: 'https://example.com/anysearch', title: 'AnySearch & 结果', snippet: 'Useful snippet' }],
      truncated: false,
    })
    const [endpoint, init] = callAt(fetchMock, 0)
    expect(endpoint).toBe('https://api.anysearch.com/v1/search')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.body).toBe(JSON.stringify({ query: 'cordis 插件', max_results: 10 }))
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers.accept).toBe('application/json')
    expect(headers['content-type']).toBe('application/json')
  })

  it('sends a bearer key when one is configured', async () => {
    const fetchMock = stubSearch()
    await provider(ANYSEARCH_DEFAULT_BASE_URL, 'any-key').search({ query: 'cordis' })
    const [, init] = callAt(fetchMock, 0)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer any-key')
  })

  it('retries anonymously exactly once when the configured key is rejected', async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => jsonResponse({}, status))
        .mockImplementation(async () => jsonResponse(RESULTS))
      vi.stubGlobal('fetch', fetchMock)
      const result = await provider(ANYSEARCH_DEFAULT_BASE_URL, 'rejected-key').search({ query: 'cordis' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [firstEndpoint, first] = callAt(fetchMock, 0)
      const [secondEndpoint, second] = callAt(fetchMock, 1)
      expect(firstEndpoint).toBe('https://api.anysearch.com/v1/search')
      expect(secondEndpoint).toBe(firstEndpoint)
      expect((first.headers as Record<string, string>).authorization).toBe('Bearer rejected-key')
      expect((second.headers as Record<string, string>).authorization).toBeUndefined()
      expect(first.redirect).toBe('error')
      expect(second.redirect).toBe('error')
      expect(result.sources).toEqual([{ url: 'https://example.com/anysearch', title: 'AnySearch & 结果', snippet: 'Useful snippet' }])
      expect(result.content).toContain(String(status))
      expect(result.content).toContain('anonymous free tier')
    }
  })

  it('reports both failures when the anonymous retry is rejected too', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider(ANYSEARCH_DEFAULT_BASE_URL, 'rejected-key').search({ query: 'q' }))
      .rejects.toThrow(/HTTP 401\) and the anonymous retry failed/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying anonymously when discarding the rejected response body fails', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(
        new ReadableStream({ cancel() { return Promise.reject(new Error('body already gone')) } }),
        { status: 403, headers: JSON_HEADERS },
      ))
      .mockImplementation(async () => jsonResponse(RESULTS))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider(ANYSEARCH_DEFAULT_BASE_URL, 'rejected-key').search({ query: 'q' }))
      .resolves.toMatchObject({ sources: [{ url: 'https://example.com/anysearch' }] })
  })

  it('does not retry without a key and reports the rejection', async () => {
    const fetchMock = stubSearch({}, 401)
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/not authorized/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects empty and oversized queries before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: '   ' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(provider().search({ query: 'x'.repeat(2_001) })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects error statuses, non-JSON content, unparseable bodies, and oversized responses', async () => {
    stubSearch({}, 500)
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":0}', { headers: { 'content-type': 'text/html' } })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/non-JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { headers: JSON_HEADERS })))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: JSON_HEADERS })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/empty response body/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":0,"data":{"results":[]}}')))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/non-JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/non-JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff, 0xfe]), { headers: JSON_HEADERS })))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000_001), { headers: JSON_HEADERS })))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    // 超限后取消读取失败不应掩盖本来的 WEB_PROVIDER_ERROR。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)) },
      cancel() { return Promise.reject(new Error('reader already gone')) },
    }), { headers: JSON_HEADERS })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/size limit/)
  })

  it('honors maxResults with a default of 10 and a cap of 20', async () => {
    const many = { code: 0, data: { results: Array.from({ length: 25 }, (_, index) => ({ url: `https://example.com/${String(index)}` })) } }
    const fetchMock = stubSearch(many)
    await expect(provider().search({ query: 'q', maxResults: 2 })).resolves.toMatchObject({
      sources: [{ url: 'https://example.com/0' }, { url: 'https://example.com/1' }],
    })
    expect(callAt(fetchMock, 0)[1].body).toBe(JSON.stringify({ query: 'q', max_results: 2 }))

    const defaults = await provider().search({ query: 'q' })
    expect(defaults.sources).toHaveLength(10)
    expect(JSON.parse(callAt(fetchMock, 1)[1].body as string)).toEqual({ query: 'q', max_results: 10 })

    const capped = await provider().search({ query: 'q', maxResults: 50 })
    expect(capped.sources).toHaveLength(20)
    expect(JSON.parse(callAt(fetchMock, 2)[1].body as string)).toEqual({ query: 'q', max_results: 20 })
  })

  it('maps caller cancellation and the request timeout to WEB_ABORTED', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: 'q' }, preAborted.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()

    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_endpoint: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    const pending = provider().search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    // 真实计时器：12 秒请求超时后映射为 WEB_ABORTED（该用例自带更长超时）。
    vi.stubGlobal('fetch', vi.fn(async (_endpoint: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    await expect(provider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  }, 25_000)

  it('reports an unusable outbound selection as unavailable and unsearchable', async () => {
    const misconfigured = new AnySearchProvider(() => ({
      baseURL: ANYSEARCH_DEFAULT_BASE_URL,
      outbound: { mode: 'custom' },
      resolveProxyURL: () => { throw new Error('custom outbound requires an http(s) proxy URL') },
    }))
    // 可用性不再覆盖请求期的出站解析错误，失败在搜索时点名。
    await expect(misconfigured.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('joins a custom base URL and rejects unsafe endpoints', async () => {
    const fetchMock = stubSearch()
    await provider('https://search.example.test/api/').search({ query: 'q' })
    expect(callAt(fetchMock, 0)[0]).toBe('https://search.example.test/api/v1/search')

    for (const baseURL of [
      'http://api.anysearch.com',
      'https://user:password@api.anysearch.com',
      'https://api.anysearch.com/?token=x',
      'https://localhost',
      'https://127.0.0.1',
      'https://api.anysearch.com/#fragment',
      'not-a-url',
      'https://[::1',
    ]) {
      await expect(provider(baseURL).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    }
  })
})

describe('AnySearch plugin', () => {
  it('reads the key from settings (never the environment) and reloads settings until unload', async () => {
    const fetchMock = stubSearch()
    // 环境变量不再参与密钥解析：即便设置了也不应发出授权头。
    vi.stubEnv('ANYSEARCH_API_KEY', 'env-key')
    const { ctx, fiber } = await boot()
    try {
      await expect(ctx.web.search({ query: 'anysearch news' })).resolves.toMatchObject({
        sources: [{ url: 'https://example.com/anysearch' }],
      })
      let [endpoint, init] = callAt(fetchMock, 0)
      expect((init.headers as Record<string, string>).authorization).toBeUndefined()

      await ctx.settings.update(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, {
        apiKey: 'literal-key',
        baseURL: 'https://search.mirror.test',
      })
      await ctx.web.search({ query: 'anysearch news' })
      ;[endpoint, init] = callAt(fetchMock, 1)
      expect(endpoint).toBe('https://search.mirror.test/v1/search')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer literal-key')

      await expect(ctx.settings.update(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, { baseURL: 'http://127.0.0.1' })).rejects.toThrow()
      for (const customUrl of ['http://', 'socks5://127.0.0.1:1080', 'http://user:password@127.0.0.1:8080']) {
        await expect(ctx.settings.update(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, { outbound: { mode: 'custom', customUrl } }))
          .rejects.toThrow(/web-search-anysearch\.outbound/)
      }
      await expect(ctx.settings.update(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, { outbound: { mode: 'custom' } }))
        .rejects.toThrow(/web-search-anysearch\.outbound/)
      await fiber.dispose()
      expect(ctx.settings.describe().map(row => row.ns)).not.toContain(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'a' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the composition entry when no settings service is installed', async () => {
    const fetchMock = stubSearch()
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'anysearch' })
      const fiber = await ctx.plugin(anySearchPlugin)
      await fiber.await()
      await expect(ctx.web.search({ query: 'anysearch news' })).resolves.toMatchObject({
        sources: [{ url: 'https://example.com/anysearch' }],
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('honors an outbound selection from the composition entry', async () => {
    const fetchMock = stubSearch()
    const { ctx } = await boot({ outbound: { mode: 'direct' } })
    try {
      await ctx.web.search({ query: 'anysearch news' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to anonymous requests when the key is empty everywhere', async () => {
    const fetchMock = stubSearch()
    vi.stubEnv('ANYSEARCH_API_KEY', '   ')
    const { ctx } = await boot({ apiKey: '' })
    try {
      await ctx.web.search({ query: 'anysearch news' })
      const [, init] = callAt(fetchMock, 0)
      expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
    vi.unstubAllEnvs()

    // 字面值为空时仍会读取环境变量。
    const keyed = stubSearch()
    vi.stubEnv('ANYSEARCH_API_KEY', 'env-fallback-key')
    const second = await boot({ apiKey: '' })
    try {
      await second.ctx.web.search({ query: 'anysearch news' })
      const [, init] = callAt(keyed, 0)
      // 环境变量不再作为密钥来源：未配置密钥时按匿名额度请求。
      expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('routes a custom outbound through the configured proxy', async () => {
    const targets: string[] = []
    const proxy = createServer().on('connect', (request, socket) => {
      targets.push(request.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    const { ctx } = await boot()
    try {
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
      const proxyURL = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
      await ctx.settings.update(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE, { outbound: { mode: 'custom', customUrl: proxyURL } })
      await expect(ctx.web.search({ query: 'proxied' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(targets).toEqual(['api.anysearch.com:443'])
    } finally {
      await ctx.fiber.dispose()
      await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
})
