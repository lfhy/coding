import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SearchSettingsController, decodeDeepSeek, decodeWeb, validField,
  type DeepSeekSearchSettings, type WebSettings,
} from '../src/client/controller.ts'

function bench() {
  const web = stubSettingsScope<WebSettings>()
  const deepSeek = stubSettingsScope<DeepSeekSearchSettings>()
  web.publish({ status: 'ready', writable: true, value: { searchProvider: 'duckduckgo' }, user: {}, base: { searchProvider: 'duckduckgo' }, revision: 1 })
  deepSeek.publish({ status: 'ready', writable: true,
    value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' },
    user: {}, base: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' }, revision: 1 })
  const describe = vi.fn(async () => ({ rpcId: 'd' as never, result: { ok: true as const, value: {
    credentials: { DEEPSEEK_SEARCH_API_KEY: { configured: false, writable: true } },
  } } }))
  const set = vi.fn(async () => ({ rpcId: 's' as never, result: { ok: true as const, value: {} } }))
  const controller = new SearchSettingsController(web.scope, deepSeek.scope, { credentials: { describe, set } } as never)
  return { web, deepSeek, describe, set, controller, state: () => controller.store.getSnapshot() }
}

describe('search settings controller', () => {
  it('narrows both Host sections and allows an omitted environment-owned endpoint', () => {
    expect(decodeWeb({ searchProvider: 'duckduckgo' })).toEqual({ searchProvider: 'duckduckgo' })
    expect(decodeWeb({ searchProvider: 'other' })).toBeUndefined()
    expect(decodeDeepSeek({ model: 'deepseek-v4-flash', apiKeyEnv: 'SEARCH_KEY' }))
      .toEqual({ model: 'deepseek-v4-flash', apiKeyEnv: 'SEARCH_KEY' })
    expect(decodeDeepSeek({ baseURL: 17 })).toBeUndefined()
  })

  it('rejects local endpoints and malformed refs before sending settings', () => {
    for (const endpoint of ['http://search.example', 'https://localhost/v1', 'https://127.0.0.1/v1',
      'https://[::1]/v1', 'https://search.local/v1', 'https://search.internal/v1',
      'https://localhost./v1', 'https://search.local./v1', 'https://search.internal./v1',
      'https://search.local../v1',
      'https://user:pass@search.example/v1', 'https://search.example/v1?q=1']) {
      expect(validField('baseURL', endpoint)).toBe(false)
    }
    expect(validField('baseURL', 'https://api.deepseek.com/anthropic/v1')).toBe(true)
    expect(validField('apiKeyEnv', 'SEARCH_KEY_1')).toBe(true)
    expect(validField('apiKeyEnv', 'invalid-ref')).toBe(false)
    expect(validField('baseURL', '')).toBe(true)
  })

  it('writes the provider through its own revision-fenced namespace', async () => {
    const { web, controller } = bench()
    web.set.mockImplementation((_field, value) => { web.publish({ value: { searchProvider: value as 'deepseek-official' } }) })

    await expect(controller.chooseProvider('deepseek-official')).resolves.toBe(true)
    expect(web.set).toHaveBeenCalledWith('searchProvider', 'deepseek-official')
    expect(controller.store.getSnapshot().web.value?.searchProvider).toBe('deepseek-official')
    controller.dispose()
  })

  it('clears an absent endpoint without writing the official URL over an environment default', async () => {
    const { deepSeek, controller, state } = bench()
    await expect(controller.saveFields({ baseURL: '', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' })).resolves.toBe(true)
    expect(deepSeek.set).not.toHaveBeenCalled()
    expect(deepSeek.unset).not.toHaveBeenCalled()
    expect(state().failed).toBe(false)
    controller.dispose()
  })

  it('keeps drafts caller-owned and reports a partially rejected sequential save', async () => {
    const { deepSeek, controller, state } = bench()
    deepSeek.set.mockImplementation((field, value) => {
      if (field === 'baseURL') deepSeek.publish({
        value: { ...deepSeek.scope.getSnapshot().value, baseURL: value as string },
        user: { baseURL: value as string }, revision: 2,
      })
    })
    const drafts = { baseURL: 'https://search.example/v1', model: 'changed-model', apiKeyEnv: 'SEARCH_KEY' }

    await expect(controller.saveFields(drafts)).resolves.toBe(false)
    expect(deepSeek.set.mock.calls).toEqual([['baseURL', drafts.baseURL], ['model', drafts.model]])
    expect(state().deepSeek.value?.baseURL).toBe(drafts.baseURL)
    expect(state().failed).toBe(true)
    expect(drafts.model).toBe('changed-model')
    controller.dispose()
  })

  it('uses only credential existence and writability; no literal enters the store', async () => {
    const { deepSeek, controller, describe, set, state } = bench()
    await vi.waitFor(() => { expect(state().credential.status).toBe('ready') })
    expect(state().credential).toMatchObject({ ref: 'DEEPSEEK_SEARCH_API_KEY', configured: false, writable: true })
    describe.mockImplementation(async () => ({ rpcId: 'd' as never, result: { ok: true as const, value: {
      credentials: { DEEPSEEK_SEARCH_API_KEY: { configured: true, writable: true } },
    } } }))
    await expect(controller.saveKey('ds-secret')).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_SEARCH_API_KEY', value: 'ds-secret' })
    expect(JSON.stringify(state())).not.toContain('ds-secret')
    deepSeek.publish({ value: { model: 'deepseek-v4-flash', apiKeyEnv: 'OTHER_KEY' } })
    await vi.waitFor(() => { expect(describe).toHaveBeenLastCalledWith({ refs: ['OTHER_KEY'] }) })
    controller.dispose()
  })

  it('refreshes the same ref after reconnect, but not unrelated update, and detaches on dispose', async () => {
    const { deepSeek, controller, describe, state } = bench()
    await vi.waitFor(() => { expect(state().credential.status).toBe('ready') })
    describe.mockClear()
    controller.refreshCredential('OTHER_KEY')
    expect(describe).not.toHaveBeenCalled()
    controller.refreshAfterReset()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
    controller.dispose()
    deepSeek.publish({ value: { model: 'new-model', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' } })
    expect(state().deepSeek.value?.model).toBe('deepseek-v4-flash')
  })
})
