import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { createUserMessage, INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-deepseek')
const KEY_REF = credentialRef('DEEPSEEK_API_KEY')
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

class StaticAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 64,
    maxImagePixels: 4,
    maxImageDimension: 4,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(IMAGE_REF)
  }

  readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) })
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + settings-file + credentials-local +
 * llm-deepseek over one temp harness home. `watch: false` keeps every change
 * flowing through the in-process write path, which is deterministic; external
 * file watching is the providers' own covered concern.
 */
async function boot(dir: string, config: object): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(StaticAttachmentStore)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmDeepSeek, config)
  return { ctx, settingsFiber }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it.each(['团队 渠道', 'default', '  团队 渠道  '])('advertises the initial channel name %j unchanged', async (channelName) => {
    const dir = await home()
    const { ctx } = await boot(dir, { channelName, baseURL: 'http://127.0.0.1:1' })

    expect(ctx.settings.get(NS)).toMatchObject({ channelName, apiKeyEnv: 'DEEPSEEK_API_KEY' })
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official', displayName: channelName, settingsNs: NS, settingsPath: [],
    }])
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: channelName }])
  })

  it('persists and reloads the channel directory name without changing other fields', async () => {
    const dir = await home()
    await writeFile(join(dir, 'settings.yaml'), [
      'llm-deepseek:',
      '  baseURL: https://unchanged.example',
      '  apiKeyEnv: DEEPSEEK_API_KEY',
      '  unknownField:',
      '    retained: true',
      '',
    ].join('\n'))
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    expect(ctx.settings.get(NS)).toMatchObject({ channelName: 'DeepSeek' })
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: NS, settingsPath: [],
    }])
    const before = ctx.settings.describe().find(entry => entry.ns === NS)!
    const observed: string[][] = []
    const observedRoutes: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listConfigurableProviders().map(entry => entry.displayName))
      observedRoutes.push(ctx.llm.listProviders().map(entry => entry.name))
    })
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['channelName'], value: '我的 DeepSeek' }], before.revision)
    expect(ctx.settings.get(NS)).toMatchObject({ channelName: '我的 DeepSeek' })
    expect(ctx.settings.describe().find(entry => entry.ns === NS)!.user).toEqual({
      baseURL: 'https://unchanged.example',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      unknownField: { retained: true },
      channelName: '我的 DeepSeek',
    })
    expect(await readFile(join(dir, 'settings.yaml'), 'utf8')).toContain('channelName: 我的 DeepSeek')
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: '我的 DeepSeek' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official',
      displayName: '我的 DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    }])
    expect(observed).toEqual([['我的 DeepSeek'], ['我的 DeepSeek']])
    expect(observedRoutes).toEqual([['DeepSeek'], ['我的 DeepSeek']])

    await ctx.settings.mutate(NS, [{ op: 'set', path: ['channelName'], value: 'default' }])
    expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('default')
    expect(ctx.llm.listProviders()[0]?.name).toBe('default')
    await ctx.fiber.dispose()
    const restarted = await boot(dir, { baseURL: 'http://127.0.0.1:1' })
    expect(restarted.ctx.settings.get(NS)).toMatchObject({ channelName: 'default', apiKeyEnv: 'DEEPSEEK_API_KEY' })
    expect(restarted.ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('default')
    expect(restarted.ctx.llm.listProviders()[0]?.name).toBe('default')
    expect(restarted.ctx.settings.describe().find(entry => entry.ns === NS)!.user).toMatchObject({
      unknownField: { retained: true }, baseURL: 'https://unchanged.example',
    })
  })

  it.each([undefined, '基础渠道'])('restores the inherited channel name %j after removing the user override', async (channelName) => {
    const dir = await home()
    const { ctx } = await boot(dir, {
      baseURL: 'http://127.0.0.1:1', ...channelName === undefined ? {} : { channelName },
    })
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['channelName'], value: '用户渠道' }])
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['channelName'] }])
    expect(ctx.settings.get(NS)).toMatchObject({ channelName: channelName ?? 'DeepSeek' })
    expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe(channelName ?? 'DeepSeek')
    expect(ctx.llm.listProviders()[0]?.name).toBe(channelName ?? 'DeepSeek')
    expect(ctx.settings.describe().find(entry => entry.ns === NS)!.user).not.toHaveProperty('channelName')
  })

  it('rejects empty and whitespace-only channel names before persisting', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    for (const channelName of ['', ' \t\u3000 ', 'a'.repeat(65)]) {
      await expect(ctx.settings.update(NS, { channelName })).rejects.toThrow()
    }
    expect(ctx.settings.get(NS)).toMatchObject({ channelName: 'DeepSeek' })
    expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('DeepSeek')
    await expect(access(join(dir, 'settings.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('routes the next request with the freshly resolved base URL and credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: first-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.headers[0]?.authorization).toBe('Bearer first-key')

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await ctx.credentials.set(KEY_REF, 'second-key')

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved both facts.
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer second-key')
  })

  it('starts keyless and serves the next request once the key arrives', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    const keyless = await prompt(ctx)
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    await expect(access(join(dir, '.anonymous-user-id'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.credentials.set(KEY_REF, 'sk-arrived')
    await prompt(ctx)
    expect(server.headers[0]?.authorization).toBe('Bearer sk-arrived')
    await expect(access(join(dir, '.anonymous-user-id'))).resolves.toBeUndefined()
  })

  it('rejects a stored credential no header can carry, never echoing it in the failure', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })
    const secret = 'sk-\u{1F600}supersecret'

    // The real credentials seam (the path the web Models page writes through),
    // not a hand-built stub: this package's own dynamic-config harness already
    // boots one, and round-tripping the value through its actual store/read
    // path is stronger evidence than a canned in-memory return would be.
    await ctx.credentials.set(KEY_REF, secret)
    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: INVALID_CREDENTIAL_CODE } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).not.toContain(secret)
    expect(result.finish.failure.message).not.toContain('supersecret')
    expect(result.finish.failure.message).not.toContain('ByteString')
  })

  it('advertises a live settings catalog without re-registration', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(2)
    await ctx.settings.update(NS, {
      models: [{ id: 'settings-model', name: 'From Settings', inputModalities: ['text', 'image'] }],
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'settings-model', name: 'From Settings', inputModalities: ['text', 'image'] },
    ])
  })

  it('discovers from the latest settings endpoint and its matching credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'https://first.example/v1' })
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ data: [{ id: 'remote-model' }] })))
    vi.stubGlobal('fetch', fetcher)
    try {
      await ctx.settings.update(NS, { baseURL: 'https://second.example/v1' })
      await ctx.credentials.set(KEY_REF, 'second-key')
      await expect(ctx.llm.discoverModels('llm-deepseek', { provider: 'deepseek-official' }))
        .resolves.toEqual([{ id: 'remote-model' }])
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://second.example/v1/models')
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer second-key' } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies a changed request image bound to the next request', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const dir = await home()
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const { ctx } = await boot(dir, {
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    })
    const messages = [createUserMessage({
      content: [
        { type: 'image', attachment: IMAGE_REF },
        { type: 'image', attachment: IMAGE_REF },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })]

    await assemble(ctx, { model: 'deepseek-v4-flash-vision-exp', messages })
    await ctx.settings.update(NS, { maxRequestImageBytes: 4 })
    await assemble(ctx, { model: 'deepseek-v4-flash-vision-exp', messages })

    const first = (server.requests[0] as { messages: Array<{ content: unknown }> }).messages[0]?.content
    const second = (server.requests[1] as { messages: Array<{ content: unknown }> }).messages[0]?.content
    expect(JSON.stringify(first).match(/"type":"image_url"/g)).toHaveLength(2)
    expect(JSON.stringify(second)).toContain('[image omitted to keep the request within its image limit')
    expect(JSON.stringify(second).match(/"type":"image_url"/g)).toHaveLength(1)
  })

  it('re-registers the route in place when the captured retry policy changes, without an empty-registry window', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Observing the topology event, not just the end state: disposing and
    // re-registering also lands on the right final registry, but publishes an
    // empty route set in between, so an observer sees the provider disappear.
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    expect(observed).toEqual([['deepseek-official']])
  })

  it('keeps the last good options when a settings snapshot fails beyond-schema validation', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Schema-valid but resolver-invalid: duplicate catalog ids pass the array
    // schema and fail the explicit resolve step.
    await ctx.settings.update(NS, { models: [{ id: 'dup' }, { id: 'dup' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(2)
    await ctx.settings.update(NS, { models: [{ id: 'recovered' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'recovered', name: 'recovered', inputModalities: ['text'] },
    ])
  })

  it('keeps the whole last-good snapshot when a rejected one changed the URL', async () => {
    const dir = await home()
    const good = await mockServer([{ kind: 'sse', events: textEvents }])
    const rejected = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_API_KEY', 'good-key')
    const { ctx } = await boot(dir, { baseURL: good.url })

    // One snapshot moves the endpoint and fails the resolve step beyond the
    // schema (duplicate catalog ids).
    await ctx.settings.update(NS, {
      baseURL: rejected.url,
      models: [{ id: 'dup' }, { id: 'dup' }],
    })

    await prompt(ctx)
    // The rejected generation contributes nothing: not its endpoint, and — the
    // regression this pins — not its key either.
    expect(rejected.requests).toHaveLength(0)
    expect(good.requests).toHaveLength(1)
    expect(good.headers[0]?.authorization).toBe('Bearer good-key')
  })

  it('falls back to the composition entry when settings detach', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: steady-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsFiber } = await boot(dir, { baseURL: serverA.url, channelName: '基础渠道' })

    await ctx.settings.update(NS, { baseURL: serverB.url, channelName: '用户渠道' })
    expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('用户渠道')
    await prompt(ctx)
    expect(serverB.requests).toHaveLength(1)

    await settingsFiber.dispose()
    expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('基础渠道')
    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverA.headers[0]?.authorization).toBe('Bearer steady-key')
  })
})
