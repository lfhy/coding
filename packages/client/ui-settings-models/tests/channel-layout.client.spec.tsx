// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

/** Fixture 层明确是可按路径编辑的对象；wire 契约故意将它们公开为 unknown。 */
type EditableNamespace = Omit<SettingsNamespaceView, 'value' | 'user'> & {
  value: Record<string, unknown>
  user: Record<string, unknown>
}

async function mount() {
  let namespace: EditableNamespace = {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(Schema.object({ providers: Schema.dict(Schema.object({
      apiKeyEnv: Schema.string().role('credential-ref'),
      baseURL: Schema.string(),
      models: Schema.array(Schema.object({ id: Schema.string().required() })),
    })) }).toJSON())) as unknown,
    value: { providers: { ready: { apiKeyEnv: 'READY_API_KEY', baseURL: 'https://ready.test' } } },
    user: { providers: { ready: { apiKeyEnv: 'READY_API_KEY', baseURL: 'https://ready.test' } } },
    revision: 2, applies: 'live' as const, secrets: [],
  }
  const stored = new Set(['READY_API_KEY'])
  const mutate = vi.fn(async (request: { expectedRevision?: number; ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] }) => {
    if (request.expectedRevision !== namespace.revision) {
      return { result: { ok: false, error: { code: 'settings-conflict', message: 'stale revision' } } }
    }
    let user = namespace.user
    let value = namespace.value
    for (const op of request.ops) {
      user = op.op === 'set' ? settingsSchema.setPath(user, op.path, op.value) : settingsSchema.deletePath(user, op.path)
      value = op.op === 'set' ? settingsSchema.setPath(value, op.path, op.value) : settingsSchema.deletePath(value, op.path)
    }
    namespace = { ...namespace, revision: namespace.revision + 1, user, value }
    return { result: { ok: true, value: namespace } }
  })
  const set = vi.fn(async (request: { ref: string }) => {
    stored.add(request.ref)
    return { result: { ok: true, value: {} } }
  })
  const api = {
    llm: { providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
      { provider: 'ready', displayName: 'Ready', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ready'], active: true },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'], active: false },
      { provider: 'reserve', displayName: 'Reserve', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'reserve'], active: false },
    ] } } })) },
    settings: { describe: vi.fn(async () => ({ result: { ok: true, value: {
      writable: true, hasDocument: true, namespaces: [namespace],
    } } })), mutate },
    credentials: {
      describe: vi.fn(async (request: { refs: string[] }) => ({ result: { ok: true, value: { credentials:
        Object.fromEntries(request.refs.map(ref => [ref, { configured: stored.has(ref), writable: true }])) } } })),
      set,
    },
  }
  const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api as never))
  await controller.load()
  render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
    api={api as never} schema={settingsSchema} t={key => en[key]} />)
  return {
    api, controller, mutate, set,
    externallySetBaseUrl: async (url: string) => {
      const path = ['providers', 'ready', 'baseURL']
      namespace = {
        ...namespace,
        revision: namespace.revision + 1,
        value: settingsSchema.setPath(namespace.value, path, url),
        user: settingsSchema.setPath(namespace.user, path, url),
      }
      controller.acceptSettingsView(namespace)
      await controller.load()
    },
  }
}

describe('channel settings layout', () => {
  it('lists configured channels and offers dormant routes only in the explicit add flow', async () => {
    const { mutate } = await mount()
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).getByRole('button', { name: /Ready/ }).getAttribute('aria-current')).toBe('true')
    expect(within(rail).queryByRole('button', { name: 'Dormant' })).toBeNull()
    expect(within(rail).queryByRole('button', { name: 'Reserve' })).toBeNull()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(document.querySelector('details')).toBeNull()
    expect(document.body.textContent).not.toContain('Details')

    fireEvent.change(within(rail).getByRole('textbox', { name: en.searchProviders }), { target: { value: 'Dormant' } })
    expect(within(rail).queryByRole('button', { name: /Ready/ })).toBeNull()
    expect(within(rail).queryByRole('button', { name: 'Dormant' })).toBeNull()
    fireEvent.change(within(rail).getByRole('textbox', { name: en.searchProviders }), { target: { value: '' } })
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: en.provider })
    expect([...picker.options].map(option => option.value)).toEqual(['dormant', 'reserve'])
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Dormant' }).getAttribute('aria-current')).toBe('true')
    })
    expect(mutate.mock.calls[0]?.[0].ops).toEqual([{ op: 'set', path: ['providers', 'dormant'], value: {} }])
    expect(within(rail).queryByRole('button', { name: 'Reserve' })).toBeNull()
  })

  it('clears a saved notice when the user changes channels or opens the add flow', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Ready') })
    const rail = screen.getByRole('complementary', { name: en.provider })
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Dormant') })
    fireEvent.click(within(rail).getByRole('button', { name: /Ready/ }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Ready') })
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('uses each local commit revision for the next key, URL, and model save without losing the current catalog', async () => {
    const { mutate, set, controller } = await mount()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.change(screen.getByRole('combobox', { name: en.provider }), { target: { value: 'dormant' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Dormant' })).toBeTruthy() })
    expect(within(screen.getByRole('complementary', { name: en.provider }))
      .getByRole('button', { name: 'Dormant' }).getAttribute('aria-current')).toBe('true')
    expect(mutate.mock.calls[0]?.[0].expectedRevision).toBe(2)
    expect(controller.store.getSnapshot().namespaces.get('llm-pi-ai')?.revision).toBe(3)

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'key-two' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://dormant.test' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate.mock.calls[1]?.[0].expectedRevision).toBe(3)
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DORMANT_API_KEY', value: 'key-two' }) })
    await waitFor(() => { expect(controller.store.getSnapshot().namespaces.get('llm-pi-ai')?.revision).toBe(4) })

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByRole('textbox', { name: `${en.modelId} 1` }), { target: { value: 'cerebras-one' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(3) })
    expect(mutate.mock.calls[2]?.[0].expectedRevision).toBe(4)
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: `${en.modelId} 1` }).value).toBe('cerebras-one')
    })
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByRole('button', { name: en.resetModels })).toBeNull()
    expect(screen.queryByText(en.conflict)).toBeNull()
  })

  it('retains a draft and rejects a true external revision change while the card stays open', async () => {
    const { mutate, set, externallySetBaseUrl } = await mount()
    fireEvent.change(screen.getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://my-draft.test' } })
    await externallySetBaseUrl('https://another-tab.test')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.baseUrl }).value).toBe('https://my-draft.test')
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'must-not-store' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect(mutate.mock.calls[0]?.[0].expectedRevision).toBe(2)
    expect(set).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.baseUrl }).value).toBe('https://my-draft.test')
  })
})
