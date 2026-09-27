import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
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

  it('ends discovery when its ten-second budget expires', async () => {
    const controller = new AbortController()
    controller.abort(new Error('timed out'))
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    try {
      const ctx = await boot()
      await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
        .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
      expect(timeout).toHaveBeenCalledWith(10_000)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      timeout.mockRestore()
    }
  })

  it.each(['caller', 'timeout'] as const)('settles while stored credential lookup hangs on %s cancellation', async (kind) => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    let rejectCredential: (reason: Error) => void = () => { throw new Error('lookup not started') }
    const credential = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectCredential = reject
    }))
    try {
      const result = discoverModels(
        { provider: 'deepseek-official', ...kind === 'caller' ? { signal: caller.signal } : {} },
        DeepSeek.resolveAdapterOptions({ baseURL: 'https://api.deepseek.com' }),
        credential,
      )
      await vi.waitFor(() => { expect(credential).toHaveBeenCalledOnce() })
      if (kind === 'caller') caller.abort()
      else deadline.abort(new Error('deadline exceeded'))
      await expect(result).rejects.toMatchObject({ code: kind === 'caller' ? 'ABORTED' : 'DISCOVERY_FAILED' })
      rejectCredential(new Error('late credential rejection'))
      await Promise.resolve()
      expect(fetcher).not.toHaveBeenCalled()
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
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

  it('resolves and enforces explicit per-model reasoning levels without changing unlisted models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeek, { models: [{ id: 'vision', inputModalities: ['text', 'image'], reasoningEfforts: ['off', 'low'] }] })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'vision')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: ReasoningEffortId('off') }, { id: ReasoningEffortId('low') }], defaultEffort: ReasoningEffortId('off') },
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
