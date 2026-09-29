// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

async function mount(options: {
  dormantConfigured?: boolean
  failCustomCredentialOnce?: boolean
  customWriteGate?: Promise<void>
} = {}) {
  const profiles = {
    ready: { apiKeyEnv: 'READY_API_KEY', baseURL: 'https://ready.test' },
    ...options.dormantConfigured === true ? { dormant: { apiKeyEnv: 'DORMANT_API_KEY', baseURL: 'https://dormant.test' } } : {},
  }
  let namespace: EditableNamespace = {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(Schema.object({ providers: Schema.dict(Schema.object({
      apiKeyEnv: Schema.string().role('credential-ref'),
      baseURL: Schema.string(),
      api: Schema.union(['openai-completions']),
      models: Schema.array(Schema.object({ id: Schema.string().required() })),
    })) }).toJSON())) as unknown,
    value: { providers: profiles },
    user: { providers: profiles },
    revision: 2, applies: 'live' as const, secrets: [],
  }
  const stored = new Set(['READY_API_KEY'])
  const mutate = vi.fn(async (request: { expectedRevision?: number; ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] }) => {
    if (request.ops.some(op => op.path.join('.') === 'providers.acme')) await options.customWriteGate
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
  let rejectCustomKey = options.failCustomCredentialOnce === true
  const set = vi.fn(async (request: { ref: string }) => {
    if (request.ref === 'ACME_API_KEY' && rejectCustomKey) {
      rejectCustomKey = false
      return { result: { ok: false, error: { code: 'credential-rejected', message: 'credential store unavailable' } } }
    }
    stored.add(request.ref)
    return { result: { ok: true, value: {} } }
  })
  const api = {
    llm: { providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
      { provider: 'ready', displayName: 'Ready', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ready'], active: true },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'], active: false },
      { provider: 'reserve', displayName: 'Reserve', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'reserve'], active: false },
      ...Object.entries(namespace.value.providers as Record<string, { displayName?: string }>)
        .filter(([provider]) => !['ready', 'dormant', 'reserve'].includes(provider))
        .map(([provider, profile]) => ({
          provider, displayName: profile.displayName ?? provider, settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', provider], active: true,
        })),
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
  async function submitCustomChannel(key = ''): Promise<HTMLElement> {
    const rail = screen.getByRole('complementary', { name: en.provider })
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    const dialog = screen.getByRole('dialog', { name: en.add })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.customRoute }), { target: { value: 'acme' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.customDisplayName }), { target: { value: 'Acme' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://acme.test/v1' } })
    if (key !== '') fireEvent.change(within(dialog).getByLabelText(en.keyInput), { target: { value: key } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.addModel }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: `${en.modelId} 1` }), { target: { value: 'acme-chat' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.create }))
    return dialog
  }

  it('lists configured channels but never offers dormant built-in routes for addition', async () => {
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
    const dialog = screen.getByRole('dialog', { name: en.add })
    expect(within(dialog).getByRole('textbox', { name: en.customRoute })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Dormant/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /Reserve/ })).toBeNull()
    expect(within(dialog).queryByRole('textbox', { name: en.searchProviders })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog', { name: en.add })).toBeNull()
    expect(within(rail).getByRole('button', { name: /Ready/ }).getAttribute('aria-current')).toBe('true')
    expect(within(rail).queryByRole('button', { name: 'Reserve' })).toBeNull()
  })

  it('preserves a saved detail across custom-modal cancellation', async () => {
    await mount({ dormantConfigured: true })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Ready') })
    const rail = screen.getByRole('complementary', { name: en.provider })
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    const dialog = screen.getByRole('dialog', { name: en.add })
    expect(screen.getByRole('status').textContent).toContain('Ready')
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.getByRole('status').textContent).toContain('Ready')
    fireEvent.click(within(rail).getByRole('button', { name: /Dormant/ }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Dormant') })
    fireEvent.click(within(rail).getByRole('button', { name: /Ready/ }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('selects the created custom route and focuses its right-hand detail', async () => {
    const { mutate } = await mount()
    const rail = screen.getByRole('complementary', { name: en.provider })
    const search = within(rail).getByRole<HTMLInputElement>('textbox', { name: en.searchProviders })
    fireEvent.change(search, { target: { value: 'Ready' } })
    await submitCustomChannel()
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
    expect(search.value).toBe('')
    expect(within(rail).getByRole('button', { name: 'Acme' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText(en.keyInput))
    expect(mutate).toHaveBeenCalledOnce()
    expect(mutate.mock.calls[0]?.[0].ops[0]?.path).toEqual(['providers', 'acme'])
  })

  it('keeps focus inside the modal while the create action is pending and disabled', async () => {
    let release!: () => void
    const customWriteGate = new Promise<void>((resolve) => { release = resolve })
    const { mutate } = await mount({ customWriteGate })
    const dialog = await submitCustomChannel()
    const create = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.creating })
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(create.disabled).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: en.close }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: en.add })).toBe(dialog)
    await act(async () => { release(); await customWriteGate })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
  })

  it('selects a committed route when the credential fails and the modal is dismissed', async () => {
    const { mutate, set } = await mount({ failCustomCredentialOnce: true })
    const dialog = await submitCustomChannel('sk-acme')
    expect(await within(dialog).findByText('credential store unavailable')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.customRoute }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
    expect(within(screen.getByRole('complementary', { name: en.provider }))
      .getByRole('button', { name: 'Acme' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText(en.keyInput))
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledOnce()
  })

  it('uses each local commit revision for the next key, URL, and model save without losing the current catalog', async () => {
    const { mutate, set, controller } = await mount({ dormantConfigured: true })
    fireEvent.click(within(screen.getByRole('complementary', { name: en.provider })).getByRole('button', { name: 'Dormant' }))
    expect(screen.getByRole('heading', { name: 'Dormant' })).toBeTruthy()
    expect(within(screen.getByRole('complementary', { name: en.provider }))
      .getByRole('button', { name: 'Dormant' }).getAttribute('aria-current')).toBe('true')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'key-two' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.baseUrl }), { target: { value: 'https://dormant-next.test' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]?.[0].expectedRevision).toBe(2)
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DORMANT_API_KEY', value: 'key-two' }) })
    await waitFor(() => { expect(controller.store.getSnapshot().namespaces.get('llm-pi-ai')?.revision).toBe(3) })

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByRole('textbox', { name: `${en.modelId} 1` }), { target: { value: 'cerebras-one' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate.mock.calls[1]?.[0].expectedRevision).toBe(3)
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
