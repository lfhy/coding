import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ReasoningEffortId } from 'coding-llm'
import * as DeepSeek from 'coding-llm-deepseek'
import { discoverModels } from '../src/discovery.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function boot(baseURL = 'https://api.deepseek.com') {
  vi.stubEnv('DEEPSEEK_API_KEY', 'stored-secret')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, { baseURL })
  return ctx
}

describe('DeepSeek official model discovery', () => {
  it('uses /v1/models on the public URL, preserving an explicit /v1 without doubling it', async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ data: [
      { id: 'deepseek-v4-flash', name: 'Flash', context_window: 123, max_output_tokens: 42 },
      { id: 'deepseek-v4-pro' }, { id: '' }, { invalid: true }, { id: 'deepseek-v4-pro' },
    ] })))
    vi.stubGlobal('fetch', fetcher)
    const ctx = await boot()
    const found = await ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' })
    expect(found).toEqual([
      { id: 'deepseek-v4-flash', name: 'Flash', contextWindow: 123, maxTokens: 42 },
      { id: 'deepseek-v4-pro' },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/models')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer stored-secret' } })
    await ctx.llm.discoverModels('llm-deepseek', { baseURL: 'https://api.deepseek.com/v1/' })
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.deepseek.com/v1/models')
  })

  it('never sends the stored secret to another draft endpoint or follows a redirect', async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://attacker.test/models' } })))
    vi.stubGlobal('fetch', fetcher)
    const ctx = await boot()
    await expect(ctx.llm.discoverModels('llm-deepseek', { baseURL: 'https://gateway.test/openai/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://gateway.test/openai/v1/models')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization')
  })

  it('validates draft URLs and key before network I/O', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const ctx = await boot()
    for (const baseURL of ['file:///tmp/key', 'https://user:pass@example.com', 'https://example.com?token=x', 'bad-url']) {
      await expect(ctx.llm.discoverModels('llm-deepseek', { baseURL })).rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
    }
    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official', apiKey: 'bad\r\nkey' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds the body and honors caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('x', { headers: { 'content-length': '4194305' } }))))
    const ctx = await boot()
    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('x'.repeat(4 * 1024 * 1024 + 1)))))
    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('rejects a non-listing JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ object: 'error' }))))
    const ctx = await boot()
    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('settles when a fetch implementation ignores its abort signal', async () => {
    const controller = new AbortController()
    let rejectFetch: (reason: Error) => void = () => { throw new Error('fetch not started') }
    const fetcher = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject }))
    vi.stubGlobal('fetch', fetcher)
    const result = discoverModels(
      { provider: 'deepseek-official', signal: controller.signal, apiKey: 'draft-key' },
      DeepSeek.resolveAdapterOptions({}),
      () => Promise.reject(new Error('stored credential must not be read')),
    )
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' })
    rejectFetch(new Error('late fetch rejection'))
    await Promise.resolve()
  })

  it('retries a transport failure and returns the answer of the second attempt', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
      }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'second-try' }] }))
    vi.stubGlobal('fetch', fetcher)
    const ctx = await boot()

    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .resolves.toEqual([{ id: 'second-try' }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('names the transport cause when both attempts fail to connect', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway.test'), { code: 'ENOTFOUND' }),
    }))))
    const ctx = await boot()

    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toThrow(/could not read https:\/\/api\.deepseek\.com\/v1\/models: fetch failed: getaddrinfo ENOTFOUND gateway\.test/)
  })

  it('reports a reply that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('not json at all'))))
    const ctx = await boot()

    await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
      .rejects.toThrow(/did not answer with JSON/)
  })

  it('reports a stored credential it could not read, keeping its own failure code', async () => {
    const options = DeepSeek.resolveAdapterOptions({ baseURL: 'https://api.deepseek.com' })

    await expect(discoverModels(
      { provider: 'deepseek-official' },
      options,
      () => Promise.reject(new Error('keychain is locked')),
    )).rejects.toThrow(/could not read this provider's stored API key for https:\/\/api\.deepseek\.com\/v1\/models/)

    await expect(discoverModels(
      { provider: 'deepseek-official' },
      options,
      () => Promise.reject(new LlmError('no credential for this route', 'MISSING_CREDENTIAL')),
    )).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('resolves and enforces explicit per-model reasoning levels without changing unlisted models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeek, { models: [{ id: 'vision', inputModalities: ['text', 'image'], reasoningEfforts: ['off', 'low'] }] })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'vision')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: ReasoningEffortId('off') }, { id: ReasoningEffortId('low') }], defaultEffort: ReasoningEffortId('low') },
    })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'unlisted')).resolves.toMatchObject({
      inputModalities: ['text'], reasoning: { efforts: [{ id: ReasoningEffortId('off') }, { id: ReasoningEffortId('low') }, { id: ReasoningEffortId('high') }, { id: ReasoningEffortId('max') }] },
    })
    const adapter = new DeepSeek.DeepSeekAdapter({
      options: () => DeepSeek.resolveAdapterOptions({ models: [{ id: 'vision', reasoningEfforts: ['off', 'low'] }] }),
      resolveApiKey: () => Promise.reject(new Error('must reject before credentials')),
      resolveUserId: () => { throw new Error('must reject before network') },
    })
    await expect((async () => { for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'vision', messages: [], reasoningEffort: ReasoningEffortId('max') })) { /* drain */ } })())
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })
})
