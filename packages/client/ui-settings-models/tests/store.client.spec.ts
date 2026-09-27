/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { messageOf, ModelsSettingsStore } from '../src/client/store.ts'
import { onboardingReadiness } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'agent-default-model', schema: {},
    value: { provider: 'deepseek-official', model: 'stale', reasoningEffort: 'high' },
    user: { provider: 'deepseek-official', model: 'stale', reasoningEffort: 'high' },
    applies: 'live' as const, secrets: [], revision: 7,
  },
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RpcResponse<{ writable: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: string[]) => Promise<RpcResponse<{ credentials: Record<string, unknown> }>>
  models?: () => Promise<RpcResponse<{
    groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    failures: Array<{ id: string; name: string; message: string }>
  }>>
  mutate?: (payload: unknown) => Promise<unknown>
} = {}) {
  const seenRefs: string[][] = []
  const face = {
    llm: {
      providers: overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY }))),
      models: overrides.models ?? (() => Promise.resolve(ok({ groups: [], failures: [] }))),
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
      mutate: overrides.mutate ?? (() => Promise.resolve(fail('unused'))),
    },
    credentials: {
      describe: (payload: { refs: string[] }) => {
        seenRefs.push(payload.refs)
        return (overrides.describeCredentials ?? (refs => Promise.resolve(ok({
          credentials: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        }))))(payload.refs)
      },
      set: () => Promise.resolve(ok({})),
      unset: () => Promise.resolve(ok({})),
    },
  }
  const wire = face as never
  return { face: wire, mirror: new SettingsDescribeMirror(wire), seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('requires a successfully listed model even after a key is configured', async () => {
    const { face, mirror } = api()
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().onboardingModels).toEqual([])
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'needs-setup', reason: 'credential-missing' })
    const configured = api({ describeCredentials: async refs => ok({ credentials: Object.fromEntries(refs.map(ref => [
      ref, { configured: true, writable: true },
    ])) }) })
    const configuredStore = new ModelsSettingsStore(configured.face, settingsSchema, configured.mirror)
    await configuredStore.load()
    expect(onboardingReadiness(configuredStore.store.getSnapshot())).toEqual({ kind: 'needs-setup', reason: 'no-models' })
  })

  it('offers other configured routes when the preset DeepSeek default is stale', async () => {
    const { face, mirror } = api({ models: async () => ok({ groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'stale', name: 'Old' }] },
      { id: 'openai', name: 'OpenAI', models: [{ id: 'chat', name: 'Chat' }] },
      { id: 'ghost', name: 'Ghost', models: [{ id: 'ghost', name: 'Ghost' }] },
    ], failures: [] }) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().onboardingModels).toEqual([
      { provider: 'openai', providerName: 'OpenAI', model: 'chat', modelName: 'Chat' },
      { provider: 'ghost', providerName: 'Ghost', model: 'ghost', modelName: 'Ghost' },
    ])
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'needs-selection' })
  })

  it('joins Host-attached route-only adapters without accepting an unresolved named profile', async () => {
    const directory = [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: '', settingsPath: [], active: true },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'], active: true },
    ]
    const { face, mirror, seenRefs } = api({
      providers: async () => ok({ providers: directory as never }),
      describeSettings: async () => ok({ writable: true, namespaces: NAMESPACES.map(ns => ns.ns === 'agent-default-model'
        ? { ...ns, value: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } : ns) } as never),
      models: async () => ok({ groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
        { id: 'dormant', name: 'Dormant', models: [{ id: 'not-configured', name: 'Not configured' }] },
      ], failures: [] }),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().rows.map(row => row.configured)).toEqual([false, false])
    expect(store.store.getSnapshot().onboardingModels).toEqual([
      { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'DeepSeek-V4-Flash' },
    ])
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'ready' })
  })

  it('does not complete a route-only default when the catalog returns no model', async () => {
    const { face, mirror } = api({
      providers: async () => ok({ providers: [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: '', settingsPath: [], active: true },
      ] as never }),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'needs-setup', reason: 'no-models' })
  })

  it('preserves the full-catalog and per-provider failure distinction', async () => {
    const failing = api({ models: async () => fail('catalog RPC rejected') })
    const store = new ModelsSettingsStore(failing.face, settingsSchema, failing.mirror)
    await store.load()
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({
      kind: 'unavailable', reason: 'catalog-unavailable', detail: 'catalog RPC rejected',
    })
    const partial = api({ models: async () => ok({ groups: [], failures: [
      { id: 'openai', name: 'OpenAI', message: 'list failed' },
      { id: 'anthropic', name: 'Anthropic', message: 'not configured' },
    ] }) })
    const partialStore = new ModelsSettingsStore(partial.face, settingsSchema, partial.mirror)
    await partialStore.load()
    expect(partialStore.store.getSnapshot().onboardingModelFailures).toEqual([
      { id: 'openai', name: 'OpenAI', message: 'list failed' },
    ])
    expect(onboardingReadiness(partialStore.store.getSnapshot())).toEqual({
      kind: 'unavailable', reason: 'catalog-provider-failed', detail: 'OpenAI (openai): list failed',
    })
  })

  it('atomically saves a current choice at the expected revision and clears stale effort', async () => {
    const mutate = vi.fn(async () => ok({
      ...NAMESPACES[0], revision: 8, value: { provider: 'openai', model: 'chat' }, user: { provider: 'openai', model: 'chat' },
    }))
    const wire = api({
      mutate,
      models: async () => ok({ groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'chat', name: 'Chat' }] }], failures: [] }),
    })
    const store = new ModelsSettingsStore(wire.face, settingsSchema, wire.mirror)
    await store.load()
    expect(await store.selectOnboardingModel({ provider: 'deepseek-official', model: 'stale' }))
      .toContain('不在当前可用目录')
    expect(mutate).not.toHaveBeenCalled()
    expect(await store.selectOnboardingModel({ provider: 'openai', model: 'chat' })).toBeUndefined()
    expect(mutate).toHaveBeenCalledWith({ ns: 'agent-default-model', expectedRevision: 7, ops: [
      { op: 'set', path: ['provider'], value: 'openai' },
      { op: 'set', path: ['model'], value: 'chat' },
      { op: 'unset', path: ['reasoningEffort'] },
    ] })
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'ready' })
  })

  it('returns revision conflicts and transport errors without accepting a failed default', async () => {
    for (const mutate of [async () => fail('settings-conflict'), async () => { throw new Error('wire down') }]) {
      const wire = api({
        mutate,
        models: async () => ok({ groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'chat', name: 'Chat' }] }], failures: [] }),
      })
      const store = new ModelsSettingsStore(wire.face, settingsSchema, wire.mirror)
      await store.load()
      expect(await store.selectOnboardingModel({ provider: 'openai', model: 'chat' }))
        .toMatch(/settings-conflict|wire down/)
      expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'needs-selection' })
    }
  })

  it('joins rows with configured, removable, and credential state', async () => {
    const { face, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { face, mirror } = api({ describeCredentials: () => Promise.resolve(fail('no provider')) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('settles a credential transport rejection without leaving the store loading', async () => {
    const { face, mirror } = api({
      describeCredentials: () => Promise.reject(new Error('credential transport down')),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: 'credential transport down',
    })
  })

  it('stringifies a non-Error credential transport rejection', async () => {
    const { face, mirror } = api({
      describeCredentials: async () => { throw 'credential transport refusal' },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot().credentialError).toBe('credential transport refusal')
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    let unavailable = false
    const { face, mirror } = api({ providers: async () => unavailable
      ? fail('directory down') : ok({ providers: DIRECTORY }) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const lastGood = store.store.getSnapshot()
    expect(lastGood).toMatchObject({ status: 'ready', hasLoaded: true })
    expect(lastGood.rows).toHaveLength(4)
    unavailable = true
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', hasLoaded: true, error: 'directory down' })
    expect(store.store.getSnapshot().rows).toBe(lastGood.rows)
    expect(store.store.getSnapshot().namespaces).toBe(lastGood.namespaces)
    unavailable = false
    await store.retry()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', hasLoaded: true, error: null })
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.face, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', hasLoaded: false, error: 'directory down' })
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('does not expose old candidate rows as ready while a newer catalog is pending', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face, mirror } = api({
      models: async () => {
        call += 1
        if (call === 2) {
          await gate
          return ok({ groups: [], failures: [] })
        }
        return ok({ groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'chat', name: 'Chat' }] }], failures: [] })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const pending = store.load()
    expect(onboardingReadiness(store.store.getSnapshot())).toEqual({ kind: 'loading' })
    expect(await store.selectOnboardingModel({ provider: 'openai', model: 'chat' })).toContain('不在当前可用目录')
    release?.()
    await pending
    expect(store.store.getSnapshot().onboardingModels).toEqual([])
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { face, mirror } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('skips the credential describe entirely when no row names a reference', async () => {
    const { face, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a settings describe failure', async () => {
    const { face, mirror } = api({ describeSettings: () => Promise.resolve(fail('settings down')) })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(
      face,
      settingsSchema,
      new SettingsDescribeMirror(face, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { face, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1 || settingsCall === 3
          ? ok({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : fail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', hasLoaded: true, error: 'settings refresh down' })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    await store.retry()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', hasLoaded: true, error: null })
  })

  it('stringifies a non-Error load failure', async () => {
    // The wire can surface non-Error throwables; the store must stringify them.
    const { face, mirror } = api({ providers: async () => { throw 'plain refusal' } })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'plain refusal' })
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})

describe('messageOf', () => {
  it('reads an Error message, and stringifies anything else a rejection may carry', () => {
    // The wire layer rejects with an Error, but a host or a runtime can reject
    // with any value, and the page still has to render something.
    expect(messageOf(new Error('connection lost'))).toBe('connection lost')
    expect(messageOf('the host refused')).toBe('the host refused')
    expect(messageOf(undefined)).toBe('undefined')
  })
})
