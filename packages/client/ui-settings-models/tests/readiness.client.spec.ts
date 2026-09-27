/** Pure first-run readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingReadiness, providerUsable } from '../src/client/store.ts'

const missingCredential: CredentialView = { configured: false, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: missingCredential,
    ...overrides,
  }
}

/** A second provider the user configured themselves. */
function otherRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'hfai',
      displayName: 'HFAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'hfai'],
      active: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: 'HFAI_API_KEY',
    credential: { configured: true, source: 'file', writable: true },
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    hasLoaded: true,
    error: null,
    credentialError: null,
    writable: true,
    rows: [row()],
    namespaces: new Map(),
    visionModels: [],
    visionModelsError: null,
    onboardingModels: [],
    onboardingModelsError: null,
    onboardingModelFailures: [],
    onboardingDefault: null,
    ...overrides,
  }
}

describe('providerUsable', () => {
  it('requires a registered route and a stored key for every named reference', () => {
    expect(providerUsable(otherRow())).toBe(true)
    expect(providerUsable(otherRow({ entry: { ...otherRow().entry, active: false } }))).toBe(false)
    expect(providerUsable(otherRow({ credential: missingCredential }))).toBe(false)
    expect(providerUsable(otherRow({ credential: undefined }))).toBe(false)
  })

  it('treats a reference-free registered route as provider-native authentication', () => {
    expect(providerUsable(otherRow({ apiKeyEnv: undefined, credential: undefined }))).toBe(true)
  })
})

describe('onboardingReadiness', () => {
  const choice = { provider: 'hfai', providerName: 'HFAI', model: 'chat', modelName: 'Chat' }
  const selectable = () => state({
    rows: [row(), otherRow()],
    namespaces: new Map([['agent-default-model', {} as never]]),
    onboardingModels: [choice],
  })

  it('waits for every join even when old rows and choices remain visible', () => {
    expect(onboardingReadiness(state({ status: 'idle', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ status: 'loading', rows: [], onboardingModels: [choice] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness({ ...selectable(), status: 'loading', onboardingDefault: { provider: 'hfai', model: 'chat' } }))
      .toEqual({ kind: 'loading' })
  })

  it('requires an explicit current default and a model returned by a usable route', () => {
    expect(onboardingReadiness(selectable())).toEqual({ kind: 'needs-selection' })
    expect(onboardingReadiness({ ...selectable(), onboardingDefault: { provider: 'deepseek-official', model: 'stale' } }))
      .toEqual({ kind: 'needs-selection' })
    expect(onboardingReadiness({ ...selectable(), onboardingDefault: { provider: 'hfai', model: 'chat' } }))
      .toEqual({ kind: 'ready' })
  })

  it('keeps no route, missing credential, and an empty successful model directory distinct', () => {
    const namespace = new Map([['agent-default-model', {} as never]])
    expect(onboardingReadiness(state({ rows: [], namespaces: namespace }))).toEqual({ kind: 'needs-setup', reason: 'no-provider' })
    expect(onboardingReadiness(state({ namespaces: namespace }))).toEqual({ kind: 'needs-setup', reason: 'credential-missing' })
    expect(onboardingReadiness(state({ rows: [otherRow()], namespaces: namespace })))
      .toEqual({ kind: 'needs-setup', reason: 'no-models' })
  })

  it('accepts read-only environment and provider-native authentication when the catalog confirms a model', () => {
    for (const credential of [{ configured: true, source: 'env' as const, writable: false }, undefined]) {
      const candidate = otherRow({ apiKeyEnv: credential === undefined ? undefined : 'HFAI_API_KEY', credential })
      expect(onboardingReadiness({ ...selectable(), rows: [candidate] })).toEqual({ kind: 'needs-selection' })
    }
  })

  it('accepts a registered route with no settings address only when its default model is listed', () => {
    const route = otherRow({
      entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: '', settingsPath: [], active: true },
      configured: false, apiKeyEnv: undefined, credential: undefined,
    })
    const bare = state({ rows: [route], namespaces: new Map([['agent-default-model', {} as never]]) })
    expect(onboardingReadiness(bare)).toEqual({ kind: 'needs-setup', reason: 'no-models' })
    expect(onboardingReadiness({
      ...bare,
      onboardingModels: [{ provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-flash', modelName: 'Flash' }],
      onboardingDefault: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })).toEqual({ kind: 'ready' })
  })

  it('keeps whole and provider-local catalog failures distinct from an empty catalog', () => {
    expect(onboardingReadiness({ ...selectable(), onboardingModelsError: 'RPC down' }))
      .toEqual({ kind: 'unavailable', reason: 'catalog-unavailable', detail: 'RPC down' })
    expect(onboardingReadiness({ ...selectable(), onboardingModels: [], onboardingModelFailures: [
      { id: 'hfai', name: 'HFAI', message: 'timeout' },
    ] })).toEqual({ kind: 'unavailable', reason: 'catalog-provider-failed', detail: 'HFAI (hfai): timeout' })
    expect(onboardingReadiness({ ...selectable(), onboardingModelFailures: [
      { id: 'deepseek-official', name: 'DeepSeek', message: 'timeout' },
    ] })).toEqual({ kind: 'needs-selection' })
  })

  it('shows failures or read-only settings without marking onboarding complete', () => {
    expect(onboardingReadiness(state({ status: 'error', error: 'settings down' }))).toEqual({
      kind: 'unavailable',
      reason: 'load-failed',
      detail: 'settings down',
    })
    expect(onboardingReadiness(state({
      credentialError: 'credentials service is absent',
      namespaces: new Map([['agent-default-model', {} as never]]),
    }))).toEqual({
      kind: 'unavailable',
      reason: 'credentials-unavailable',
      detail: 'credentials service is absent',
    })
    expect(onboardingReadiness(state({
      rows: [row({ credential: undefined })],
      namespaces: new Map([['agent-default-model', {} as never]]),
    }))).toEqual({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: false, writable: false } })],
      namespaces: new Map([['agent-default-model', {} as never]]),
    }))).toEqual({ kind: 'unavailable', reason: 'credential-read-only' })
    expect(onboardingReadiness(state({ writable: false }))).toEqual({
      kind: 'unavailable',
      reason: 'settings-read-only',
    })
  })
})
