import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SearchSettingsController, decodeDeepSeek, decodeDuckDuckGo, decodeTavily, decodeWeb, validField,
  type DeepSeekSearchSettings, type DuckDuckGoSearchSettings, type TavilySearchSettings, type SearchProvider, type WebSettings,
} from '../src/client/controller.ts'

function bench(provider: SearchProvider = 'duckduckgo') {
  const web = stubSettingsScope<WebSettings>()
  const duckDuckGo = stubSettingsScope<DuckDuckGoSearchSettings>()
  const deepSeek = stubSettingsScope<DeepSeekSearchSettings>()
  const tavily = stubSettingsScope<TavilySearchSettings>()
  web.publish({ status: 'ready', writable: true, value: { searchProvider: provider }, user: {}, base: { searchProvider: 'duckduckgo' }, revision: 1 })
  duckDuckGo.publish({ status: 'ready', writable: true, value: {}, user: {}, base: {}, revision: 5 })
  deepSeek.publish({ status: 'ready', writable: true,
    value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' },
    user: {}, base: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' }, revision: 1 })
  tavily.publish({ status: 'ready', writable: true, value: { baseURL: 'https://api.tavily.com', apiKeyEnv: 'TAVILY_API_KEY' },
    user: {}, base: { baseURL: 'https://api.tavily.com', apiKeyEnv: 'TAVILY_API_KEY' }, revision: 9 })
  const describe = vi.fn(async () => ({ rpcId: 'd' as never, result: { ok: true as const, value: {
    credentials: { DEEPSEEK_SEARCH_API_KEY: { configured: false, writable: true }, TAVILY_API_KEY: { configured: false, writable: true } },
  } } }))
  const set = vi.fn(async () => ({ rpcId: 's' as never, result: { ok: true as const, value: {} } }))
  const controller = new SearchSettingsController(
    web.scope, duckDuckGo.scope, deepSeek.scope, tavily.scope, { credentials: { describe, set } } as never,
  )
  return { web, duckDuckGo, deepSeek, tavily, describe, set, controller, state: () => controller.store.getSnapshot() }
}

describe('search settings controller', () => {
  it('narrows both Host sections and allows an omitted environment-owned endpoint', () => {
    expect(decodeWeb({ searchProvider: 'duckduckgo' })).toEqual({ searchProvider: 'duckduckgo' })
    expect(decodeWeb({ searchProvider: 'tavily' })).toEqual({ searchProvider: 'tavily' })
    expect(decodeWeb({ searchProvider: 'other' })).toBeUndefined()
    expect(decodeDeepSeek({ model: 'deepseek-v4-flash', apiKeyEnv: 'SEARCH_KEY' }))
      .toEqual({ model: 'deepseek-v4-flash', apiKeyEnv: 'SEARCH_KEY' })
    expect(decodeDeepSeek({ baseURL: 17 })).toBeUndefined()
    expect(decodeDeepSeek({ proxyURL: 17 })).toBeUndefined()
    expect(decodeTavily({ proxyURL: 'http://127.0.0.1:7890' })).toEqual({ proxyURL: 'http://127.0.0.1:7890' })
    expect(decodeTavily({ apiKeyEnv: 17 })).toBeUndefined()
    expect(decodeDuckDuckGo({ proxyURL: 'http://localhost:7890' })).toEqual({ proxyURL: 'http://localhost:7890' })
    expect(decodeDuckDuckGo({ proxyURL: 17 })).toBeUndefined()
  })

  it('rejects local endpoints and malformed refs before sending settings', () => {
    for (const endpoint of ['http://search.example', 'https://localhost/v1', 'https://127.0.0.1/v1',
      'https://[::1]/v1', 'https://search.local/v1', 'https://search.internal/v1',
      'https://localhost./v1', 'https://search.local./v1', 'https://search.internal./v1',
      'https://search.local../v1', 'https://intranet/v1', 'https:tavily.example.test',
      'https://user:pass@search.example/v1', 'https://@search.example/v1',
      'https://search.example/v1?q=1', 'https://search.example/v1?']) {
      expect(validField('baseURL', endpoint)).toBe(false)
    }
    expect(validField('baseURL', 'https://api.deepseek.com/anthropic/v1')).toBe(true)
    expect(validField('baseURL', 'https://intranet', 'deepseek-official')).toBe(true)
    expect(validField('baseURL', 'https://intranet', 'tavily')).toBe(false)
    expect(validField('baseURL', 'https://localhost', 'deepseek-official')).toBe(false)
    expect(validField('apiKeyEnv', 'SEARCH_KEY_1')).toBe(true)
    expect(validField('apiKeyEnv', 'invalid-ref')).toBe(false)
    expect(validField('baseURL', '')).toBe(true)
    for (const proxy of ['http://127.0.0.1:7890', 'http://localhost:7890', 'https://[::1]:7890']) {
      expect(validField('proxyURL', proxy)).toBe(true)
    }
    for (const proxy of ['socks5://127.0.0.1:7890', 'http:localhost:7890', 'http://user:pass@localhost:7890',
      'http://localhost:7890/?key=secret', 'http://localhost:7890/#frag',
      'http://@localhost:7890', 'http://localhost:7890/?', 'http://localhost:7890/#']) {
      expect(validField('proxyURL', proxy)).toBe(false)
    }
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
    const { deepSeek, controller, state } = bench('deepseek-official')
    await expect(controller.saveFields('deepseek-official', { baseURL: '', proxyURL: '', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' })).resolves.toBe(true)
    expect(deepSeek.set).not.toHaveBeenCalled()
    expect(deepSeek.unset).not.toHaveBeenCalled()
    expect(state().failed).toBe(false)
    controller.dispose()
  })

  it('accepts a DeepSeek single-label HTTPS endpoint while keeping Tavily restricted', async () => {
    const { deepSeek, tavily, controller } = bench('deepseek-official')
    deepSeek.set.mockImplementation((field, value) => {
      deepSeek.publish({ value: { ...deepSeek.scope.getSnapshot().value, [field]: value as string }, revision: 2 })
    })
    await expect(controller.saveFields('deepseek-official', {
      baseURL: 'https://intranet', proxyURL: '', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY',
    })).resolves.toBe(true)
    expect(deepSeek.set).toHaveBeenCalledWith('baseURL', 'https://intranet')
    await expect(controller.saveFields('tavily', {
      baseURL: 'https://intranet', proxyURL: '', apiKeyEnv: 'TAVILY_API_KEY',
    })).resolves.toBe(false)
    expect(tavily.set).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps drafts caller-owned and reports a partially rejected sequential save', async () => {
    const { deepSeek, controller, state } = bench('deepseek-official')
    deepSeek.set.mockImplementation((field, value) => {
      if (field === 'baseURL') deepSeek.publish({
        value: { ...deepSeek.scope.getSnapshot().value, baseURL: value as string },
        user: { baseURL: value as string }, revision: 2,
      })
    })
    const drafts = { baseURL: 'https://search.example/v1', proxyURL: '', model: 'changed-model', apiKeyEnv: 'SEARCH_KEY' }

    await expect(controller.saveFields('deepseek-official', drafts)).resolves.toBe(false)
    expect(deepSeek.set.mock.calls).toEqual([['baseURL', drafts.baseURL], ['model', drafts.model]])
    expect(state().deepSeek.value?.baseURL).toBe(drafts.baseURL)
    expect(state().failed).toBe(true)
    expect(drafts.model).toBe('changed-model')
    controller.dispose()
  })

  it('uses only credential existence and writability; no literal enters the store', async () => {
    const { deepSeek, controller, describe, set, state } = bench('deepseek-official')
    await vi.waitFor(() => { expect(state().credential.status).toBe('ready') })
    expect(state().credential).toMatchObject({ ref: 'DEEPSEEK_SEARCH_API_KEY', configured: false, writable: true })
    describe.mockImplementation(async () => ({ rpcId: 'd' as never, result: { ok: true as const, value: {
      credentials: { DEEPSEEK_SEARCH_API_KEY: { configured: true, writable: true }, TAVILY_API_KEY: { configured: false, writable: true } },
    } } }))
    await expect(controller.saveKey('ds-secret')).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_SEARCH_API_KEY', value: 'ds-secret' })
    expect(JSON.stringify(state())).not.toContain('ds-secret')
    deepSeek.publish({ value: { model: 'deepseek-v4-flash', apiKeyEnv: 'OTHER_KEY' } })
    await vi.waitFor(() => { expect(describe).toHaveBeenLastCalledWith({ refs: ['OTHER_KEY'] }) })
    controller.dispose()
  })

  it('refreshes the same ref after reconnect, but not unrelated update, and detaches on dispose', async () => {
    const { deepSeek, controller, describe, state } = bench('deepseek-official')
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

  it('saves each provider namespace independently and clears only user overrides', async () => {
    const { duckDuckGo, tavily, deepSeek, controller } = bench()
    duckDuckGo.set.mockImplementation((_field, value) => {
      const proxyURL = value as string
      duckDuckGo.publish({ value: { proxyURL }, user: { proxyURL }, revision: 6 })
    })
    await expect(controller.saveFields('duckduckgo', { proxyURL: 'http://127.0.0.1:7890' })).resolves.toBe(true)
    expect(duckDuckGo.set).toHaveBeenCalledWith('proxyURL', 'http://127.0.0.1:7890')
    expect(deepSeek.set).not.toHaveBeenCalled()
    tavily.set.mockImplementation((field, value) => {
      const name = field as string
      const text = value as string
      tavily.publish({ value: { ...tavily.scope.getSnapshot().value, [name]: text }, user: { [name]: text }, revision: 10 })
    })
    await expect(controller.saveFields('tavily', { baseURL: 'https://api.tavily.com', proxyURL: 'http://localhost:7890', apiKeyEnv: 'TAVILY_API_KEY' })).resolves.toBe(true)
    expect(tavily.set).toHaveBeenCalledWith('proxyURL', 'http://localhost:7890')
    expect(duckDuckGo.set).toHaveBeenCalledTimes(1)
    duckDuckGo.unset.mockImplementation(() => { duckDuckGo.publish({ user: {}, value: {}, revision: 7 }) })
    await expect(controller.saveFields('duckduckgo', { proxyURL: '' })).resolves.toBe(true)
    expect(duckDuckGo.unset).toHaveBeenCalledWith('proxyURL')
    controller.dispose()
  })

  it('only describes the selected keyed provider after a switch, reconnect, or external update', async () => {
    const { web, controller, describe, state } = bench()
    expect(describe).not.toHaveBeenCalled()
    web.publish({ value: { searchProvider: 'tavily' }, revision: 2 })
    await vi.waitFor(() => { expect(state().credential).toMatchObject({ provider: 'tavily', ref: 'TAVILY_API_KEY', status: 'ready' }) })
    expect(describe).toHaveBeenCalledWith({ refs: ['TAVILY_API_KEY'] })
    controller.refreshCredential('DEEPSEEK_SEARCH_API_KEY')
    expect(describe).toHaveBeenCalledTimes(1)
    controller.refreshCredential('TAVILY_API_KEY')
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
    web.publish({ value: { searchProvider: 'duckduckgo' }, revision: 3 })
    expect(state().credential.ref).toBe('')
    controller.refreshAfterReset()
    expect(describe).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('ignores a delayed credential description from the previous provider', async () => {
    const { web, controller, describe, state } = bench('deepseek-official')
    await vi.waitFor(() => { expect(state().credential.status).toBe('ready') })
    let settle!: (response: never) => void
    describe.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    controller.refreshAfterReset()
    expect(state().credential.status).toBe('loading')
    web.publish({ value: { searchProvider: 'tavily' }, revision: 2 })
    await vi.waitFor(() => { expect(state().credential).toMatchObject({ provider: 'tavily', status: 'ready' }) })
    settle({ rpcId: 'old', result: { ok: true, value: {
      credentials: { DEEPSEEK_SEARCH_API_KEY: { configured: true, writable: true } },
    } } } as never)
    await vi.waitFor(() => { expect(state().credential).toMatchObject({ provider: 'tavily', ref: 'TAVILY_API_KEY', configured: false }) })
    controller.dispose()
  })
})
