// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SearchSettingsSection, type SearchSettingsSectionProps } from '../src/client/SearchSettingsSection.tsx'
import type { SearchSettingsState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(overrides: Partial<SearchSettingsState> = {}, provider: 'duckduckgo' | 'deepseek-official' | 'tavily' = 'duckduckgo') {
  const state = createSnapshotStore<SearchSettingsState>({
    web: { status: 'ready', value: { searchProvider: provider }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' },
    duckDuckGo: { status: 'ready', value: {}, base: {}, user: {}, revision: 4, writable: true, mode: 'host' },
    deepSeek: { status: 'ready', value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' },
    tavily: { status: 'ready', value: { baseURL: 'https://api.tavily.com', apiKeyEnv: 'TAVILY_API_KEY' }, base: {}, user: {}, revision: 7, writable: true, mode: 'host' },
    credential: provider === 'duckduckgo' ? { ref: '', status: 'ready', configured: false, writable: false }
      : { provider, ref: provider === 'tavily' ? 'TAVILY_API_KEY' : 'DEEPSEEK_SEARCH_API_KEY', status: 'ready', configured: false, writable: true },
    saving: false, keySaving: false, failed: false, keyFailed: false,
    ...overrides,
  })
  const chooseProvider = vi.fn(async () => true)
  const saveFields = vi.fn(async () => true)
  const saveKey = vi.fn(async () => true)
  render(<SearchSettingsSection {...({
    t: (key: keyof typeof zh) => zh[key],
    useSearchSettings: bindSnapshotSelector(state),
    chooseProvider, saveFields, saveKey,
  } as unknown as SearchSettingsSectionProps)} />)
  return { state, chooseProvider, saveFields, saveKey }
}

describe('search settings section', () => {
  it('selects the free provider by default and shows only its proxy configuration', () => {
    bench()
    expect(screen.getByRole('radio', { name: /DuckDuckGo/ })).toHaveProperty('checked', true)
    expect(screen.getByLabelText(zh.proxy)).toBeTruthy()
    expect(screen.queryByLabelText(zh.apiKey)).toBeNull()
    expect(screen.queryByLabelText(zh.endpoint)).toBeNull()
    expect(screen.getByRole('region', { name: zh.title })).toBeTruthy()
  })

  it('changes provider without saving a key or the independent settings', () => {
    const subject = bench()
    fireEvent.click(screen.getByRole('radio', { name: /DeepSeek 官方/ }))
    expect(subject.chooseProvider).toHaveBeenCalledWith('deepseek-official')
    expect(subject.saveFields).not.toHaveBeenCalled()
    expect(subject.saveKey).not.toHaveBeenCalled()
  })

  it('saves a blank endpoint as inherited, not a hardcoded official URL', async () => {
    const subject = bench({}, 'deepseek-official')
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: 'search-model' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(subject.saveFields).toHaveBeenCalledWith('deepseek-official', {
      baseURL: '', proxyURL: '', model: 'search-model', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY',
    }) })
    expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('value', '')
  })

  it('does not block DeepSeek model edits for an inherited single-label HTTPS endpoint', () => {
    const subject = bench({ deepSeek: { status: 'ready', value: {
      baseURL: 'https://intranet', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY',
    }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' } }, 'deepseek-official')
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: 'new-model' } })
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect(subject.saveFields).toHaveBeenCalledWith('deepseek-official', {
      baseURL: 'https://intranet', proxyURL: '', model: 'new-model', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY',
    })
  })

  it('rejects unsafe endpoint locally while preserving the draft', () => {
    const subject = bench({}, 'deepseek-official')
    for (const endpoint of ['https://localhost./v1', 'https://search.local./v1', 'https://search.internal./v1']) {
      fireEvent.change(screen.getByLabelText(zh.endpoint), { target: { value: endpoint } })
      expect(screen.getByText(zh.invalidEndpoint)).toBeTruthy()
      expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
      expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('value', endpoint)
    }
    expect(subject.saveFields).not.toHaveBeenCalled()
  })

  it('keeps key text only in the private input, and clears it on success', async () => {
    const subject = bench({}, 'deepseek-official')
    fireEvent.change(screen.getByLabelText(zh.apiKey), { target: { value: 'private-key' } })
    expect(JSON.stringify(subject.state.getSnapshot())).not.toContain('private-key')
    fireEvent.click(screen.getByRole('button', { name: zh.saveKey }))
    await waitFor(() => { expect(subject.saveKey).toHaveBeenCalledWith('private-key') })
    await waitFor(() => { expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('value', '') })
  })

  it('does not submit a key under the old ref while a new ref is unsaved', () => {
    const subject = bench({}, 'deepseek-official')
    fireEvent.change(screen.getByLabelText(zh.keyRef), { target: { value: 'NEW_KEY' } })
    expect(screen.getByText(zh.keyRefPending)).toBeTruthy()
    expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('disabled', true)
    expect(subject.saveKey).not.toHaveBeenCalled()
  })

  it('keeps credential editing separate from a read-only settings document', () => {
    bench({ deepSeek: { status: 'ready', value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' },
      base: {}, user: {}, revision: 1, writable: false, mode: 'host' } }, 'deepseek-official')
    expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('disabled', false)
  })

  it('renders Tavily fields and key separately, without DeepSeek model', () => {
    bench({}, 'tavily')
    expect(screen.getByRole('radio', { name: /Tavily/ })).toHaveProperty('checked', true)
    expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('value', 'https://api.tavily.com')
    expect(screen.getByLabelText(zh.proxy)).toBeTruthy()
    expect(screen.getByText(zh.tavilyKeyMissing)).toBeTruthy()
    expect(screen.queryByLabelText(zh.model)).toBeNull()
  })

  it('saves DuckDuckGo proxy, allows loopback, and rejects credentials or query', () => {
    const subject = bench()
    fireEvent.change(screen.getByLabelText(zh.proxy), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect(subject.saveFields).toHaveBeenCalledWith('duckduckgo', { proxyURL: 'http://127.0.0.1:7890' })
    for (const value of ['http://user:pass@localhost:7890', 'http://localhost:7890/?q=1']) {
      fireEvent.change(screen.getByLabelText(zh.proxy), { target: { value } })
      expect(screen.getByText(zh.invalidProxy)).toBeTruthy()
      expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    }
  })

  it('keeps each provider draft isolated through switches', () => {
    const subject = bench()
    fireEvent.change(screen.getByLabelText(zh.proxy), { target: { value: 'http://localhost:7001' } })
    act(() => { subject.state.update((draft) => { draft.web.value = { searchProvider: 'tavily' }; draft.credential = {
      provider: 'tavily', ref: 'TAVILY_API_KEY', status: 'ready', configured: false, writable: true,
    } }) })
    expect(screen.getByLabelText(zh.proxy)).toHaveProperty('value', '')
    fireEvent.change(screen.getByLabelText(zh.proxy), { target: { value: 'http://localhost:7002' } })
    act(() => { subject.state.update((draft) => { draft.web.value = { searchProvider: 'duckduckgo' }; draft.credential = {
      ref: '', status: 'ready', configured: false, writable: false,
    } }) })
    expect(screen.getByLabelText(zh.proxy)).toHaveProperty('value', 'http://localhost:7001')
  })

  it('preserves newer field and key input when an older save completes', async () => {
    let settleFields!: (ok: boolean) => void
    const subject = bench({}, 'deepseek-official')
    subject.saveFields.mockImplementation(() => new Promise((resolve) => { settleFields = resolve }))
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: 'second' } })
    settleFields(true)
    await waitFor(() => { expect(screen.getByLabelText(zh.model)).toHaveProperty('value', 'second') })
    let settleKey!: (ok: boolean) => void
    subject.saveKey.mockImplementation(() => new Promise((resolve) => { settleKey = resolve }))
    fireEvent.change(screen.getByLabelText(zh.apiKey), { target: { value: 'first-key' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveKey }))
    fireEvent.change(screen.getByLabelText(zh.apiKey), { target: { value: 'second-key' } })
    settleKey(true)
    await waitFor(() => { expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('value', 'second-key') })
    expect(JSON.stringify(subject.state.getSnapshot())).not.toContain('second-key')
  })

  it('offers focusable provider controls and shows credential errors only for keyed providers', () => {
    const subject = bench({ credential: { provider: 'tavily', ref: 'TAVILY_API_KEY', status: 'error', configured: false, writable: false }, keyFailed: true }, 'tavily')
    expect(screen.getByText(zh.keyError)).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveProperty('textContent', zh.keyFailed)
    const deepSeek = screen.getByRole('radio', { name: /DeepSeek 官方/ })
    deepSeek.focus()
    expect(document.activeElement).toBe(deepSeek)
    fireEvent.click(deepSeek)
    expect(subject.chooseProvider).toHaveBeenCalledWith('deepseek-official')
  })
})
