// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SearchSettingsSection, type SearchSettingsSectionProps } from '../src/client/SearchSettingsSection.tsx'
import type { SearchSettingsState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(overrides: Partial<SearchSettingsState> = {}) {
  const state = createSnapshotStore<SearchSettingsState>({
    web: { status: 'ready', value: { searchProvider: 'duckduckgo' }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' },
    deepSeek: { status: 'ready', value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' }, base: {}, user: {}, revision: 1, writable: true, mode: 'host' },
    credential: { ref: 'DEEPSEEK_SEARCH_API_KEY', status: 'ready', configured: false, writable: true },
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
  it('selects the free provider by default and warns that DeepSeek needs a key', () => {
    bench()
    expect(screen.getByRole('radio', { name: /DuckDuckGo/ })).toHaveProperty('checked', true)
    expect(screen.getByText(zh.keyMissing)).toBeTruthy()
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
    const subject = bench()
    fireEvent.change(screen.getByLabelText(zh.model), { target: { value: 'search-model' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(subject.saveFields).toHaveBeenCalledWith({
      baseURL: '', model: 'search-model', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY',
    }) })
    expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('value', '')
  })

  it('rejects unsafe endpoint locally while preserving the draft', () => {
    const subject = bench()
    for (const endpoint of ['https://localhost./v1', 'https://search.local./v1', 'https://search.internal./v1']) {
      fireEvent.change(screen.getByLabelText(zh.endpoint), { target: { value: endpoint } })
      expect(screen.getByText(zh.invalidEndpoint)).toBeTruthy()
      expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
      expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('value', endpoint)
    }
    expect(subject.saveFields).not.toHaveBeenCalled()
  })

  it('keeps key text only in the private input, and clears it on success', async () => {
    const subject = bench()
    fireEvent.change(screen.getByLabelText(zh.apiKey), { target: { value: 'private-key' } })
    expect(JSON.stringify(subject.state.getSnapshot())).not.toContain('private-key')
    fireEvent.click(screen.getByRole('button', { name: zh.saveKey }))
    await waitFor(() => { expect(subject.saveKey).toHaveBeenCalledWith('private-key') })
    await waitFor(() => { expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('value', '') })
  })

  it('does not submit a key under the old ref while a new ref is unsaved', () => {
    const subject = bench()
    fireEvent.change(screen.getByLabelText(zh.keyRef), { target: { value: 'NEW_KEY' } })
    expect(screen.getByText(zh.keyRefPending)).toBeTruthy()
    expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('disabled', true)
    expect(subject.saveKey).not.toHaveBeenCalled()
  })

  it('keeps credential editing separate from a read-only settings document', () => {
    bench({ deepSeek: { status: 'ready', value: { model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' },
      base: {}, user: {}, revision: 1, writable: false, mode: 'host' } })
    expect(screen.getByLabelText(zh.endpoint)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh.apiKey)).toHaveProperty('disabled', false)
  })
})
