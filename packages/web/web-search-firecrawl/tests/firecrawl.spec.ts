import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import WebRuntime, { WebError } from 'coding-web'
import * as firecrawlPlugin from '../src/index.ts'
import { FirecrawlSearchProvider, WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE } from '../src/index.ts'
import {
  FIRECRAWL_KEYLESS_COOLDOWN_MS,
  isFirecrawlKeylessRefusal,
  isSafeBaseUrl,
  isValidProxyURL,
  mapFirecrawlResponse,
} from '../src/provider.ts'

const API_KEY = 'test-secret'
const PAYLOAD = { success: true, data: { web: [{ url: 'https://example.com/one', title: 'First', description: 'A snippet' }] } }
const VPN_REFUSAL_DETAIL = 'Requests without an API key are not allowed from VPN or proxy egress'
const VPN_REFUSAL = JSON.stringify({ error: VPN_REFUSAL_DETAIL })
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 取出 rejected 的 WebError，便于断言具体诊断文案。 */
async function failureOf(request: Promise<unknown>): Promise<WebError> {
  const error = await request.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(WebError)
  return error as WebError
}

/** 按脚手架形状构造提供方：密钥、基址与出站都用闭包，便于单测里换值。 */
function provider(options: { apiKey?: string; baseURL?: string; proxyURL?: string } = {}): FirecrawlSearchProvider {
  return new FirecrawlSearchProvider(
    () => options.apiKey,
    () => options.baseURL ?? 'https://api.firecrawl.test',
    () => options.proxyURL,
  )
}

interface ProxyHandle {
  readonly port: number
  readonly targets: string[]
  close(): Promise<void>
}

/** 记录 CONNECT 目标后以 407 拒绝的代理：证明请求确实走代理且不会静默绕过。 */
async function refusingProxy(): Promise<ProxyHandle> {
  const targets: string[] = []
  const server: Server = createServer().on('connect', (request: IncomingMessage, socket: Socket) => {
    targets.push(request.url ?? '')
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    targets,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

/** 真正的转发代理：明文目标走绝对 URI 转发，CONNECT 目标走隧道；用于让带代理的请求仍能收到本机源站响应。 */
async function forwardingProxy(): Promise<ProxyHandle> {
  const targets: string[] = []
  const sockets = new Set<Duplex>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    targets.push(request.url ?? '')
    const upstream = httpRequest(request.url ?? '', { method: request.method, headers: request.headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => { response.destroy() })
    request.pipe(upstream)
  }).on('connect', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    targets.push(request.url ?? '')
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const [host, port] = (request.url ?? '').split(':')
    const target = connect({ host, port: Number(port) }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.byteLength > 0) target.write(head)
      target.pipe(socket)
      socket.pipe(target)
    })
    target.on('error', () => { socket.destroy() })
    socket.on('error', () => { target.destroy() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    targets,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

interface OriginHandle {
  readonly origin: string
  hits(): number
  reply(status: number, body: string): void
  close(): Promise<void>
}

/** 可切换响应的本机源站：用于观察请求是否真的发出。 */
async function originServer(): Promise<OriginHandle> {
  let status = 200
  let body = JSON.stringify(PAYLOAD)
  let hits = 0
  const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    hits += 1
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    hits: () => hits,
    reply: (nextStatus, nextBody) => {
      status = nextStatus
      body = nextBody
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

describe('Firecrawl response mapping', () => {
  it('maps data.web entries and deduplicates by URL', () => {
    expect(mapFirecrawlResponse({ success: true, data: { web: [
      { url: 'https://example.com/one', title: '  First\n title ', description: 'A  snippet' },
      { url: 'https://example.com/one', title: 'Duplicate', description: 'dup' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      { url: 'https://exam ple.com/one' },
      { url: 'https://' },
      { title: 'No URL' },
      { url: 'http://example.com/two' },
    ] } })).toEqual({
      sources: [
        { url: 'https://example.com/one', title: 'First title', snippet: 'A snippet' },
        { url: 'http://example.com/two' },
      ],
      truncated: false,
    })
  })

  it('accepts the data array shape and bounds fields from oversized results', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      url: `https://example.com/${String(index)}`,
      title: `[T]${'T'.repeat(400)}`,
      description: 'S'.repeat(900),
    }))
    const result = mapFirecrawlResponse({ data: rows })
    expect(result.sources).toHaveLength(20)
    // 标题先去空白再截到 200 字符，随后剥掉会破坏 Markdown 链接语法的方括号。
    expect(result.sources[0]?.title?.length).toBeLessThanOrEqual(200)
    expect(result.sources[0]?.title).not.toContain('[')
    expect(result.sources[0]?.snippet).toHaveLength(500)
  })

  it('fails when the payload carries no result array', () => {
    expect(() => mapFirecrawlResponse({ success: true, data: {} })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapFirecrawlResponse('nope')).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('recognizes only 403 bodies that name the keyless egress restriction', () => {
    expect(isFirecrawlKeylessRefusal(403, VPN_REFUSAL)).toBe(true)
    expect(isFirecrawlKeylessRefusal(403, 'Without an API key, this request is refused')).toBe(true)
    expect(isFirecrawlKeylessRefusal(403, 'rate limited')).toBe(false)
    expect(isFirecrawlKeylessRefusal(401, VPN_REFUSAL)).toBe(false)
  })
})

describe('Firecrawl provider', () => {
  it('posts the search body and forwards the API key as a Bearer credential', async () => {
    const fetchMock = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider({ apiKey: API_KEY }).search({ query: 'latest news', maxResults: 5 })).resolves.toEqual({
      sources: [{ url: 'https://example.com/one', title: 'First', snippet: 'A snippet' }],
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.firecrawl.test/v2/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(headers.accept).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'latest news', limit: 5 })

    const defaultBase = new FirecrawlSearchProvider(() => API_KEY)
    vi.stubGlobal('fetch', fetchMock)
    await defaultBase.search({ query: 'q' })
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe('https://api.firecrawl.dev/v2/search')
  })

  it('sends keyless requests without an authorization header', async () => {
    const fetchMock = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers as Record<string, string>).not.toHaveProperty('authorization')
  })

  it('caps the requested limit at 20, defaults it to 10, and honors the returned budget', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ url: `https://example.com/${String(index)}`, title: `T${String(index)}` }))
    const fetchMock = vi.fn(async () => json({ data: { web: rows } }))
    vi.stubGlobal('fetch', fetchMock)
    const bounded = await provider().search({ query: 'q', maxResults: 100 })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ query: 'q', limit: 20 })
    expect(bounded.sources).toHaveLength(20)
    const narrowed = await provider().search({ query: 'q', maxResults: 3 })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ query: 'q', limit: 3 })
    expect(narrowed.sources).toHaveLength(3)
    await provider().search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string)).toEqual({ query: 'q', limit: 10 })
  })

  it('reports ordinary HTTP failures and non-JSON bodies as WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'internal failure' }, 500)))
    // 服务端在错误体里回显密钥时，诊断必须先抹掉本次请求携带的 key。
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: `request with ${API_KEY} rejected` }, 500)))
    const echoed = await failureOf(provider({ apiKey: API_KEY }).search({ query: 'q' }))
    expect(echoed.message).toContain('[redacted]')
    expect(echoed.message).not.toContain(API_KEY)
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'internal failure' }, 500)))
    const failure = await failureOf(provider({ apiKey: API_KEY }).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('HTTP 500')
    expect(failure.message).toContain('internal failure')
    // 超限响应读取中断后释放连接；底层 cancel 抛错不改变 size limit 诊断。
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
      cancel() { throw new Error('cancel rejected') },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(oversized, { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/size limit/)
    // 无正文的错误响应只保留状态码；null 主体单独给出诊断。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, headers: { 'content-type': 'application/json' } })))
    await expect(failureOf(provider().search({ query: 'q' }))).resolves.toMatchObject({ message: 'Firecrawl search failed (HTTP 502)' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/empty response body/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    // 缺少 content-type 的 2xx 响应同样按非 JSON 失败（字节体不会自动带 content-type）。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(JSON.stringify(PAYLOAD)), { status: 200 })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/non-JSON/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(provider().search({ query: 'q' })).rejects.toThrow(/size limit/)
  })

  it('distinguishes key rejections and rate limits from generic provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)))
    await expect(failureOf(provider({ apiKey: API_KEY }).search({ query: 'q' }))).resolves.toMatchObject({
      message: 'Firecrawl rejected the API key (HTTP 401)',
    })
    await expect(failureOf(provider().search({ query: 'q' }))).resolves.toMatchObject({
      message: 'Firecrawl refused the keyless request (HTTP 401); configure an API key',
    })
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'quota' }, 429)))
    await expect(failureOf(provider({ apiKey: API_KEY }).search({ query: 'q' }))).resolves.toMatchObject({
      message: 'Firecrawl rate limit exceeded (HTTP 429)',
    })
    await expect(failureOf(provider().search({ query: 'q' }))).resolves.toMatchObject({
      message: 'Firecrawl keyless rate limit exceeded (HTTP 429); configure an API key for a higher quota',
    })
  })

  it('rejects an empty or oversized query and an unsafe endpoint before sending', async () => {
    const fetchMock = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: '   ' })).rejects.toThrow(/1–2000 characters/)
    await expect(provider().search({ query: 'q'.repeat(2_001) })).rejects.toThrow(/1–2000 characters/)
    await expect(provider({ baseURL: 'https://user:pw@api.firecrawl.test' }).search({ query: 'q' })).rejects.toThrow(/base URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    // 默认构造即直连官方端点（无 key、无代理）；坏基址只让 available() 变为 false，不访问网络。
    expect(new FirecrawlSearchProvider().available()).toBe(true)
    expect(new FirecrawlSearchProvider(() => undefined, () => 'not a url').available()).toBe(false)
    await expect(new FirecrawlSearchProvider().search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.firecrawl.dev/v2/search')
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).not.toHaveProperty('authorization')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validates endpoint bases and proxy addresses', () => {
    expect(isSafeBaseUrl('https://api.firecrawl.dev')).toBe(true)
    expect(isSafeBaseUrl('http://127.0.0.1:3002')).toBe(true)
    for (const raw of ['api.firecrawl.dev', 'ftp://api.firecrawl.test', 'https://user:pw@api.firecrawl.test', 'https://api.firecrawl.test/?token=1', ' https://api.firecrawl.test']) {
      expect(isSafeBaseUrl(raw)).toBe(false)
    }
    expect(isValidProxyURL('http://127.0.0.1:8080')).toBe(true)
    for (const raw of ['socks5://127.0.0.1:1080', 'not a url', 'http://user:pw@127.0.0.1:8080', 'http://127.0.0.1:8080/?token=1']) {
      expect(isValidProxyURL(raw)).toBe(false)
    }
  })

  it('maps caller cancellation and the request timeout to WEB_ABORTED', { timeout: 25_000 }, async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before the request'))
    const cancelled = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', cancelled)
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(cancelled).not.toHaveBeenCalled()

    // 真实计时器：12 秒请求超时后映射为 WEB_ABORTED（该用例自带更长超时）。
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))

    // 等待响应期间由调用方取消：取消标志让任何网络层错误都报告 WEB_ABORTED。
    const midway = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
      })))
    const interrupted = provider().search({ query: 'q' }, midway.signal)
    const interruptedAssertion = expect(interrupted).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    midway.abort(new Error('cancelled midway'))
    await interruptedAssertion

    // 响应已完整读到时再取消：搜索结果照常返回，只在释放连接阶段按取消处理。
    const late = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { late.abort(); return json(PAYLOAD) }))
    await expect(provider().search({ query: 'q' }, late.signal)).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
  })

  it('cools down keyless searches after an egress refusal and lets a key bypass the pause', async () => {
    const fetchMock = vi.fn(async () => json({ error: VPN_REFUSAL_DETAIL }, 403))
    vi.stubGlobal('fetch', fetchMock)
    const credentials: { apiKey?: string } = {}
    const keyless = new FirecrawlSearchProvider(() => credentials.apiKey)
    await expect(keyless.search({ query: 'q' }))
      .rejects.toThrow(/egress IP/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 冷却期内不发请求，直接给出诊断。
    await expect(keyless.search({ query: 'q' })).rejects.toThrow(/cooling down/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 配置 key 即绕过 keyless 冷却。
    credentials.apiKey = 'recovered-key'
    vi.stubGlobal('fetch', vi.fn(async () => json(PAYLOAD)))
    await expect(keyless.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
  })

  it('expires the keyless cooldown after six hours', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => json({ error: VPN_REFUSAL_DETAIL }, 403))
    vi.stubGlobal('fetch', fetchMock)
    const keyless = provider()
    await expect(keyless.search({ query: 'q' })).rejects.toThrow(/egress IP/)
    await vi.advanceTimersByTimeAsync(FIRECRAWL_KEYLESS_COOLDOWN_MS)
    vi.stubGlobal('fetch', vi.fn(async () => json(PAYLOAD)))
    await expect(keyless.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
  })

  it('scopes the keyless cooldown to the resolved egress proxy', async () => {
    const origin = await originServer()
    const proxy = await forwardingProxy()
    let proxyURL: string | undefined
    const keyless = new FirecrawlSearchProvider(() => undefined, () => origin.origin, () => proxyURL)
    try {
      origin.reply(403, VPN_REFUSAL)
      await expect(keyless.search({ query: 'q' })).rejects.toThrow(/egress IP/)
      expect(origin.hits()).toBe(1)
      // 同一出口仍在冷却：不发请求。
      await expect(keyless.search({ query: 'q' })).rejects.toThrow(/cooling down/)
      expect(origin.hits()).toBe(1)
      // 换一套出口代理即新的判定周期，请求再次发出并经过代理转发。
      proxyURL = `http://127.0.0.1:${String(proxy.port)}`
      origin.reply(200, JSON.stringify(PAYLOAD))
      await expect(keyless.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
      expect(origin.hits()).toBe(2)
      expect(proxy.targets).toEqual([`${origin.origin}/v2/search`])
    } finally {
      vi.unstubAllGlobals()
      await proxy.close()
      await origin.close()
    }
  })

  it('sends a real CONNECT to the configured egress proxy', async () => {
    const proxy = await refusingProxy()
    try {
      await expect(provider({ apiKey: API_KEY, proxyURL: `http://127.0.0.1:${String(proxy.port)}` }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(proxy.targets).toEqual(['api.firecrawl.test:443'])
    } finally {
      await proxy.close()
    }
  })
})

describe('Firecrawl plugin', () => {
  it('registers through the plugin with settings validation, settings-only keys, and unload', async () => {
    const previous = process.env.FIRECRAWL_API_KEY
    delete process.env.FIRECRAWL_API_KEY
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'firecrawl' })
      await ctx.plugin(MemorySettings).await()
      const fiber = await ctx.plugin(firecrawlPlugin, {})
      await fiber.await()
      const fetchMock = vi.fn(async () => json(PAYLOAD))
      vi.stubGlobal('fetch', fetchMock)
      const headersOf = (index: number): Record<string, string> =>
        (fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].headers as Record<string, string>

      await expect(ctx.web.search({ query: 'keyless' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
      expect(headersOf(0)).not.toHaveProperty('authorization')
      // 未配置 baseURL 时回落官方端点。
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.firecrawl.dev/v2/search')

      // 环境变量不再作为密钥来源：仍是匿名请求。
      process.env.FIRECRAWL_API_KEY = 'ambient-key'
      await ctx.web.search({ query: 'ambient' })
      expect(headersOf(1)).not.toHaveProperty('authorization')

      await ctx.settings.update(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, { apiKey: 'stored-key' })
      await ctx.web.search({ query: 'stored' })
      expect(headersOf(2).authorization).toBe('Bearer stored-key')
      const [descriptor] = ctx.settings.describe({ redactSecrets: true }).filter(row => String(row.ns) === 'web-search-firecrawl')
      expect(JSON.stringify(descriptor)).not.toContain('stored-key')

      await ctx.settings.update(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, { baseURL: 'https://firecrawl.gateway.test' })
      await ctx.web.search({ query: 'gateway' })
      expect((fetchMock.mock.calls[3] as unknown as [string])[0]).toBe('https://firecrawl.gateway.test/v2/search')

      for (const baseURL of ['https://user:pw@api.firecrawl.test', 'ftp://api.firecrawl.test', 'https://api.firecrawl.test/?token=x']) {
        await expect(ctx.settings.update(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, { baseURL })).rejects.toThrow()
      }
      await expect(ctx.settings.update(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, { outbound: { mode: 'custom' } }))
        .rejects.toThrow(/web-search-firecrawl.outbound/)

      await fiber.dispose()
      expect(ctx.settings.describe().map(row => String(row.ns))).not.toContain(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE)
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    } finally {
      if (previous === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = previous
      await ctx.fiber.dispose()
    }
  })

  it('registers from a raw composition config without a settings service', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'firecrawl' })
      // 直接调用 apply 拿到的原始组合配置：没有设置分节补默认值时，端点与出站都要回落官方端点与直连。
      firecrawlPlugin.apply(ctx, { apiKey: 'literal' })
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/one' }] })
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.firecrawl.dev/v2/search')
      expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).toMatchObject({
        authorization: 'Bearer literal',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('routes pool and custom outbound selections through the proxy contract', async () => {
    const proxy = await refusingProxy()
    const ctx = new Context()
    const fetchMock = vi.fn(async () => json(PAYLOAD))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'firecrawl' })
      await ctx.plugin(MemorySettings).await()
      await ctx.plugin(firecrawlPlugin, { apiKey: 'literal', baseURL: 'https://api.firecrawl.test' }).await()
      const disposePool = ctx.provide('proxyPool', { proxyURL: () => `http://127.0.0.1:${String(proxy.port)}` })
      // 未配置出站时直连：请求由原生 fetch 完成，不经过任何代理。
      await ctx.web.search({ query: 'direct' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(proxy.targets).toEqual([])
      for (const outbound of [{ mode: 'pool' as const }, { mode: 'custom' as const, customUrl: `http://127.0.0.1:${String(proxy.port)}` }]) {
        await ctx.settings.update(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, { outbound })
        await expect(ctx.web.search({ query: 'proxied' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
        expect(proxy.targets).toEqual(['api.firecrawl.test:443'])
        proxy.targets.length = 0
      }
      // 清空出站后下一次请求回到直连。
      await ctx.settings.replace(WEB_SEARCH_FIRECRAWL_SETTINGS_NAMESPACE, {})
      await ctx.web.search({ query: 'back-to-direct' })
      expect(proxy.targets).toEqual([])
      disposePool()
    } finally {
      vi.unstubAllGlobals()
      await ctx.fiber.dispose()
      await proxy.close()
    }
  })
})
