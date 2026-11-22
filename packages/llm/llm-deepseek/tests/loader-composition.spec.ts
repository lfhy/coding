/**
 * Real-composition guard for the dynamic-configuration chain: LlmRuntime,
 * settings-file, credentials-local, and llm-deepseek boot from a test-only
 * cordis.yml through the actual Loader + Include path, external edits of
 * settings.yaml and the credentials document hot-publish through their providers, and the very
 * next request carries the fresh base URL and credential. The same adapter
 * composition without settings or credentials entries keeps entry-config
 * behavior — the documented optional-inject fallback.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { ReasoningEffortId } from 'coding-llm'
import { credentialRef } from 'coding-credentials'
import LocalCredentialProvider from 'coding-credentials-local'
import { settingsNamespace } from 'coding-settings'
import FileSettingsProvider from 'coding-settings-file'
import { getOrCreateAnonymousUserId } from 'coding-anonymous-user-id'
import * as LlmDeepSeek from 'coding-llm-deepseek'
import * as LlmPiAi from 'coding-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const responsesEvents = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'responses' },
  { type: 'response.output_item.done', output_index: 0, item: {
    type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'responses', annotations: [] }],
  } },
  { type: 'response.completed', response: {
    id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  } },
].map(event => JSON.stringify(event))

const messagesEvents = [
  { type: 'message_start', message: {
    id: 'msg_anthropic', type: 'message', role: 'assistant', model: 'special-model', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 },
  } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'messages' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`)

const NS = settingsNamespace('llm-deepseek')
const KEY_REF = credentialRef('DEEPSEEK_API_KEY')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function loadComposition(
  options: {
    withDynamic: boolean
    baseURL: string
    reuseRoot?: string
    withGeneric?: boolean
    legacyOnly?: boolean
    withoutLegacyKey?: boolean
    settingsDocument?: string
  },
): Promise<{ ctx: Context; settingsPath: string; credentialsPath: string }> {
  // A reused root is the restart case: the same harness home, its documents
  // exactly as the previous process left them.
  const fresh = options.reuseRoot === undefined
  root = options.reuseRoot ?? await mkdtemp(join(tmpdir(), 'dsh-llm-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  if (options.withDynamic && fresh) {
    await writeFile(settingsPath, options.settingsDocument ?? '# personal settings\n')
    await writeFile(credentialsPath, [
      ...options.withoutLegacyKey === true ? [] : ['DEEPSEEK_API_KEY: boot-key'],
      ...options.withGeneric === true ? ['GATEWAY_API_KEY: gateway-key'] : [],
      '',
    ].join('\n'), { mode: 0o600 })
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    ...options.withDynamic
      ? [
        '- id: settings',
        "  name: 'coding-settings-file'",
        '  config:',
        `    path: ${JSON.stringify(settingsPath)}`,
        '    debounceMs: 10',
        '- id: credentials',
        "  name: 'coding-credentials-local'",
        '  config:',
        `    path: ${JSON.stringify(credentialsPath)}`,
        '    debounceMs: 10',
      ]
      : [],
    ...options.withGeneric === true ? ['- id: llm-pi-ai', "  name: 'coding-llm-pi-ai'"] : [],
    '- id: llm-deepseek',
    "  name: 'coding-llm-deepseek'",
    '  config:',
    `    baseURL: ${JSON.stringify(options.baseURL)}`,
    ...options.legacyOnly === true ? ['    legacyOnly: true'] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['coding-settings-file', FileSettingsProvider],
    ['coding-credentials-local', LocalCredentialProvider],
    ['coding-llm-deepseek', LlmDeepSeek],
    ['coding-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath, credentialsPath }
}

describe('llm-deepseek real dynamic composition', () => {
  it('migrates the legacy route once without resetting its model, credential, or reasoning preferences', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const server = await mockServer([textEvents, responsesEvents].map(events => ({ kind: 'sse', events })))
    const options = { withDynamic: true, withGeneric: true, legacyOnly: true, baseURL: server.url }
    const { ctx, settingsPath } = await loadComposition({
      ...options,
      settingsDocument: [
        'llm-deepseek:', '  channelName: 自用网关', '  reasoningEffort: low', '  userAgent: legacy-gateway/1.0',
        '  models:', '    - id: existing-model', '      maxTokens: 64', '      reasoningEfforts: [off, low, high]',
        '    - id: disabled-model', '      reasoningEfforts: [off]',
        'llm-pi-ai:', '  providers:', '    unrelated:',
        `      baseURL: ${JSON.stringify(server.url)}`, '      models: [{ id: unrelated-model }]', '',
      ].join('\n'),
    })
    const settings = ctx.get('settings')!
    const target = settingsNamespace('llm-pi-ai')
    const route = 'deepseek-official'
    const entry = () => ctx.llm.listConfigurableProviders().find(item => item.provider === route)
    await vi.waitFor(() => {
      expect(entry()).toMatchObject({ displayName: '自用网关', settingsNs: target, settingsPath: ['providers', route], declared: true })
    })
    expect(settings.get(target)).toMatchObject({ migratedDeepSeek: true, providers: {
      unrelated: { models: [{ id: 'unrelated-model' }] },
      [route]: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [
        { id: 'existing-model', reasoningEfforts: { off: null, low: 'low', high: 'high' }, defaultReasoningEffort: 'low' },
        { id: 'disabled-model', reasoningEfforts: false },
      ] },
    } })
    await expect(ctx.llm.resolveModelInfo(route, 'existing-model')).resolves.toMatchObject({
      reasoning: { defaultEffort: 'low' }, defaultMaxTokens: 64,
    })
    const generate = (context: Context) => assemble(context, {
      provider: route, model: 'existing-model', messages: [], reasoningEffort: ReasoningEffortId('high'),
    })
    expect((await generate(ctx)).finish.kind).toBe('stop')
    expect(server.requests[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(server.headers[0]).toMatchObject({ authorization: 'Bearer boot-key', 'user-agent': 'legacy-gateway/1.0' })

    await settings.mutate(target, [{ op: 'set', path: ['providers', route, 'api'], value: 'openai-responses' }])
    const home = root!
    await ctx.fiber.dispose()
    const { ctx: restarted } = await loadComposition({ ...options, reuseRoot: home })
    expect((await generate(restarted)).finish.kind).toBe('stop')
    expect(server.requests[1]).toMatchObject({ reasoning: { effort: 'high' } })
    expect(server.paths).toEqual(['/chat/completions', '/responses'])
    const persisted = await readFile(settingsPath, 'utf8')
    expect(persisted).not.toContain('boot-key')
    await restarted.get('settings')!.mutate(target, [{ op: 'unset', path: ['providers', route] }])
    await restarted.fiber.dispose()
    const { ctx: afterDeletion } = await loadComposition({ ...options, reuseRoot: home })
    expect(afterDeletion.llm.listConfigurableProviders().some(item => item.provider === route)).toBe(false)
  })

  it('keeps an existing custom route with the same id and does not import the legacy channel over it', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const route = 'deepseek-official'
    const { ctx } = await loadComposition({
      withDynamic: true, withGeneric: true, legacyOnly: true, baseURL: 'http://localhost:1',
      settingsDocument: [
        'llm-deepseek: { channelName: 原渠道 }', 'llm-pi-ai:', '  providers:', `    ${route}:`,
        '      displayName: 已配置渠道', '      baseURL: http://localhost:2', '      models: [{ id: custom-model }]', '',
      ].join('\n'),
    })
    const target = settingsNamespace('llm-pi-ai')
    await vi.waitFor(() => {
      expect(ctx.get('settings')!.get(target)).toMatchObject({ migratedDeepSeek: true, providers: {
        [route]: { displayName: '已配置渠道', baseURL: 'http://localhost:2', models: [{ id: 'custom-model' }] },
      } })
    })
    expect(ctx.llm.listConfigurableProviders().filter(item => item.provider === route)).toMatchObject([
      { settingsNs: target, settingsPath: ['providers', route] },
    ])
  })

  it('migrates the old default channel when only its credential is configured', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { ctx } = await loadComposition({
      withDynamic: true, withGeneric: true, legacyOnly: true, baseURL: 'http://localhost:1',
    })
    const target = settingsNamespace('llm-pi-ai')
    await vi.waitFor(() => {
      expect(ctx.get('settings')!.get(target)).toMatchObject({ migratedDeepSeek: true, providers: {
        'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] },
      } })
    })
  })

  it('keeps serving the old route when its settings cannot be represented by the custom adapter', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsPath } = await loadComposition({
      withDynamic: true, withGeneric: true, legacyOnly: true, baseURL: server.url,
      settingsDocument: 'llm-deepseek: {models: []}\n',
    })
    expect((await assemble(ctx, { model: 'unlisted-legacy-model', messages: [] })).finish.kind).toBe('stop')
    expect(await readFile(settingsPath, 'utf8')).toBe('llm-deepseek: {models: []}\n')
    expect(ctx.llm.listConfigurableProviders().find(item => item.provider === 'deepseek-official'))
      .toMatchObject({ settingsNs: NS })
  })

  it('configures DeepSeek as a custom channel and reuses its thinking effort after switching to Responses', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const server = await mockServer([textEvents, responsesEvents].map(events => ({ kind: 'sse', events })))
    const { ctx } = await loadComposition({
      withDynamic: true, withGeneric: true, legacyOnly: true, withoutLegacyKey: true, baseURL: server.url,
    })
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'deepseek-official')).toBe(false)
    const settings = ctx.get('settings')!
    const ns = settingsNamespace('llm-pi-ai')
    const profile = {
      displayName: 'DeepSeek Gateway', baseURL: server.url, apiKeyEnv: 'GATEWAY_API_KEY',
      models: [{ id: 'gateway-model', reasoningEfforts: { off: null, high: 'high' } }],
    }
    for (const api of ['openai-completions', 'openai-responses'] as const) {
      await settings.update(ns, { providers: { gateway: { ...profile, api } } })
      const result = await assemble(ctx, {
        provider: 'gateway', model: 'gateway-model', messages: [], reasoningEffort: ReasoningEffortId('high'),
      })
      expect(result.finish).toEqual({ kind: 'stop' })
    }
    expect(server.paths).toEqual(['/chat/completions', '/responses'])
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(server.requests[1]).toMatchObject({ reasoning: { effort: 'high' } })

  })

  it('uses the channel protocol unless a model overrides it, and returns to Chat after clearing', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const server = await mockServer([textEvents, responsesEvents, messagesEvents, textEvents]
      .map(events => ({ kind: 'sse', events })))
    const initial = await loadComposition({ withDynamic: true, baseURL: server.url })
    let ctx = initial.ctx
    const generate = (model: string) => assemble(ctx, {
      model, messages: [], system: 'Use plain text.', maxTokens: 64, reasoningEffort: ReasoningEffortId('high'),
    })
    const expectText = async (model: string, text: string): Promise<void> => {
      const result = await generate(model)
      expect(result.finish).toEqual({ kind: 'stop' })
      expect(result.message.content).toContainEqual({ type: 'text', text })
    }

    await expectText('deepseek-v4-flash', 'hello')
    const settings = ctx.get('settings')!
    await settings.update(NS, {
      api: 'openai-responses',
      userAgent: 'test-channel/1.0',
      models: [{ id: 'inherited-model' }, { id: 'special-model', api: 'anthropic-messages' }],
    })
    const home = root!
    await ctx.fiber.dispose()
    const restarted = await loadComposition({ withDynamic: true, baseURL: server.url, reuseRoot: home })
    ctx = restarted.ctx
    await expectText('inherited-model', 'responses')
    await expectText('special-model', 'messages')
    const responses = server.requests[1] as Record<string, unknown>
    const messages = server.requests[2] as Record<string, unknown>
    expect(responses).toMatchObject({ model: 'inherited-model', max_output_tokens: 64 })
    expect(Array.isArray(responses['input'])).toBe(true)
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(responses).toMatchObject({ reasoning: { effort: 'high' } })
    expect(messages).toMatchObject({
      model: 'special-model', max_tokens: 64 + 16_384, thinking: { type: 'enabled', budget_tokens: 15_424 },
    })
    expect(Array.isArray(messages['messages'])).toBe(true)
    expect(server.headers[1]).toMatchObject({ authorization: 'Bearer boot-key', 'user-agent': 'test-channel/1.0' })
    expect(server.headers[2]).toMatchObject({ 'x-api-key': 'boot-key', 'user-agent': 'test-channel/1.0' })
    expect(server.headers[2]?.['x-deepseek-harness-user-id']).toBe(server.headers[0]?.['x-deepseek-harness-user-id'])
    const reloadedSettings = ctx.get('settings')!
    await expect(reloadedSettings.update(NS, { api: 'chat' })).rejects.toThrow()
    await expect(reloadedSettings.update(NS, { models: [{ id: 'bad-model', api: 'unknown' }] })).rejects.toThrow()

    // 模拟用户移除两级覆盖；不需要改密钥、重启或换模型 ID。
    await writeFile(restarted.settingsPath, 'llm-deepseek:\n  models:\n    - id: special-model\n')
    await vi.waitFor(() => {
      expect(reloadedSettings.get(NS)).toMatchObject({ models: [{ id: 'special-model' }] })
      expect(reloadedSettings.get(NS)).not.toHaveProperty('api')
    }, { timeout: 5000 })
    await expectText('special-model', 'hello')
    expect(server.paths).toEqual(['/chat/completions', '/responses', '/v1/messages', '/chat/completions'])
  })

  it('uses the configured outbound proxy in all formats without changing direct requests', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const upstream = await mockServer([{ kind: 'sse', events: textEvents }])
    // HTTP 代理接收绝对形式的 URL，直接回放上游响应；不能绕过它联系上游。
    const proxy = await mockServer([textEvents, responsesEvents, messagesEvents].map(events => ({ kind: 'sse', events })))
    const { ctx } = await loadComposition({ withDynamic: true, baseURL: upstream.url })
    const settings = ctx.get('settings')!
    const generate = () => assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
      await settings.update(NS, { api, outbound: { mode: 'custom', customUrl: proxy.url } })
      expect((await generate()).finish).toEqual({ kind: 'stop' })
    }
    expect(upstream.paths).toEqual([])
    expect(proxy.paths).toEqual(['/chat/completions', '/responses', '/v1/messages'].map(path => upstream.url + path))
    await settings.replace(NS, {})
    expect((await generate()).finish).toEqual({ kind: 'stop' })
    expect(upstream.paths).toEqual(['/chat/completions'])
  })

  it.each([
    ['openai-responses', '/responses', responsesEvents],
    ['anthropic-messages', '/v1/messages', messagesEvents],
  ] as const)('cancels an in-flight %s request through the channel signal', async (api, path, events) => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const upstream = await mockServer([{ kind: 'sse', events, delayMs: 100 }])
    const { ctx } = await loadComposition({ withDynamic: true, baseURL: upstream.url })
    await ctx.get('settings')!.update(NS, { api })
    const caller = new AbortController()
    const result = assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: caller.signal })
    try {
      await vi.waitFor(() => { expect(upstream.paths).toEqual([path]) })
    } finally {
      caller.abort()
    }
    expect((await result).finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('does not forward the Messages credential to a redirected endpoint', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const destination = await mockServer([{ kind: 'sse', events: messagesEvents }])
    const upstream = await mockServer([{
      kind: 'http-error', status: 307, body: '', headers: { location: `${destination.url}/v1/messages` },
    }])
    const { ctx } = await loadComposition({ withDynamic: true, baseURL: upstream.url })
    await ctx.get('settings')!.update(NS, { api: 'anthropic-messages' })
    expect((await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })).finish.kind).toBe('error')
    expect(upstream.headers[0]?.['x-api-key']).toBe('boot-key')
    expect(destination.paths).toEqual([])
  })

  it('reloads the channel directory name from external settings and a real restart', async () => {
    const { ctx, settingsPath } = await loadComposition({ withDynamic: true, baseURL: 'http://127.0.0.1:1' })
    const home = root!
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: NS, settingsPath: [],
    }])

    await writeFile(settingsPath, 'llm-deepseek:\n  channelName: 外部渠道\n')
    await vi.waitFor(() => {
      expect(ctx.llm.listConfigurableProviders()[0]?.displayName).toBe('外部渠道')
    }, { timeout: 5000 })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: '外部渠道' }])
    expect(ctx.get('settings')!.get(NS)).toMatchObject({ channelName: '外部渠道', apiKeyEnv: 'DEEPSEEK_API_KEY' })

    const llm = ctx.llm
    await ctx.fiber.dispose()
    context = undefined
    expect(llm.listConfigurableProviders()).toEqual([])
    const restarted = await loadComposition({ withDynamic: true, baseURL: 'http://127.0.0.1:1', reuseRoot: home })
    expect(restarted.ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official', displayName: '外部渠道', settingsNs: NS, settingsPath: [],
    }])
    expect(restarted.ctx.llm.listProviders()[0]?.name).toBe('外部渠道')
    expect(restarted.ctx.get('settings')!.get(NS)).toMatchObject({ channelName: '外部渠道', apiKeyEnv: 'DEEPSEEK_API_KEY' })
  })

  it('boots from cordis.yml and routes the next request after external settings and credential edits', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsPath, credentialsPath } = await loadComposition({ withDynamic: true, baseURL: serverA.url })

    // 组合只有一个设置分节：User-Agent 属于渠道自己的分节，没有共享的 llm 分节。
    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toEqual([NS])
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(serverA.headers[0]?.authorization).toBe('Bearer boot-key')
    expect(serverA.headers[0]?.['x-deepseek-harness-user-id']).toBe(getOrCreateAnonymousUserId())

    // External edits, exactly as a user or the web UI would leave them on disk.
    await writeFile(settingsPath, `llm-deepseek:\n  baseURL: ${serverB.url}\n`)
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { baseURL?: string }).baseURL).toBe(serverB.url)
    }, { timeout: 5000 })
    await writeFile(credentialsPath, 'DEEPSEEK_API_KEY: rotated-key\n', { mode: 0o600 })
    await vi.waitFor(async () => {
      expect(await ctx.get('credentials')!.resolve(KEY_REF)).toEqual({ value: 'rotated-key', source: 'file' })
    }, { timeout: 5000 })

    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer rotated-key')
  })

  it('keeps a stored key writable and rotatable across a real restart', async () => {
    // No ambient DEEPSEEK_API_KEY: the shipped surfaces do not hoist
    // the credentials document into process.env, so a stored key must stay file-sourced.
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const first = await mockServer([{ kind: 'sse', events: textEvents }])
    const second = await mockServer([{ kind: 'sse', events: textEvents }])
    const boot = await loadComposition({ withDynamic: true, baseURL: first.url })
    const home = root!
    await boot.ctx.get('credentials')!.set(KEY_REF, 'stored-by-ui')
    expect(await boot.ctx.get('credentials')!.describe(KEY_REF))
      .toEqual({ configured: true, source: 'file', writable: true })
    await assemble(boot.ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(first.headers[0]?.authorization).toBe('Bearer stored-by-ui')
    await boot.ctx.fiber.dispose()
    context = undefined

    // Restart over the same harness home.
    const restarted = await loadComposition({ withDynamic: true, baseURL: second.url, reuseRoot: home })
    const credentials = restarted.ctx.get('credentials')!
    // The stored key is still the provider's own writable file entry — not a
    // read-only launch override, which is what hoisting it would have made it.
    expect(await credentials.resolve(KEY_REF)).toEqual({ value: 'stored-by-ui', source: 'file' })
    expect(await credentials.describe(KEY_REF)).toEqual({ configured: true, source: 'file', writable: true })
    // Rotation still works after the restart, and the next request uses it.
    await credentials.set(KEY_REF, 'rotated-after-restart')
    await assemble(restarted.ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(second.headers[0]?.authorization).toBe('Bearer rotated-after-restart')
  })

  it('boots the same adapter on entry config alone, resolving the reference from the environment', async () => {
    // No settings and no credentials provider: configuration carries only the
    // reference, so the environment is the whole credential plane here.
    vi.stubEnv('DEEPSEEK_API_KEY', 'entry-key')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await loadComposition({ withDynamic: false, baseURL: server.url })

    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('credentials')).toBeUndefined()
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer entry-key')
  })
})
