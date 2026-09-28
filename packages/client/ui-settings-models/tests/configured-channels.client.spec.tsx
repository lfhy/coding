// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { CredentialView, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const providerSchema = Schema.object({ providers: Schema.dict(Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
  models: Schema.array(Schema.object({ id: Schema.string().required() })),
})) })
const defaultSchema = Schema.object({ provider: Schema.string(), model: Schema.string(), reasoningEffort: Schema.string() })

type EditableNamespace = Omit<SettingsNamespaceView, 'value' | 'user' | 'base'> & {
  value: Record<string, unknown>
  user: Record<string, unknown>
  base: Record<string, unknown>
}

function namespace(
  ns: string, schema: Schema, value: Record<string, unknown>, user: Record<string, unknown>, base: Record<string, unknown>,
): EditableNamespace {
  return {
    ns, schema: JSON.parse(JSON.stringify(schema.toJSON())) as unknown,
    value, user, base, revision: 0, applies: 'live', secrets: [],
  }
}

interface FixtureOptions {
  profile?: Record<string, unknown>
  baseProfile?: boolean
  credential?: CredentialView
  credentialError?: boolean
  inactive?: boolean
  onboarding?: boolean
}

async function mount(options: FixtureOptions = {}) {
  const providers = options.profile === undefined ? {} : { existing: options.profile }
  let section = namespace('llm-pi-ai', providerSchema, { providers },
    { providers: options.baseProfile === true ? {} : providers },
    { providers: options.baseProfile === true ? providers : {} })
  let defaultSection = namespace('agent-default-model', defaultSchema, {}, {}, {})
  const credential = options.credential ?? { configured: false, writable: true }
  const mutate = vi.fn(async (request: { ns: string; expectedRevision?: number; ops: SettingsPathOpView[] }) => {
    const current = request.ns === section.ns ? section : defaultSection
    if (request.expectedRevision !== current.revision) {
      return { result: { ok: false, error: { code: 'settings-conflict', message: 'stale revision' } } }
    }
    let value = current.value
    let user = current.user
    for (const op of request.ops) {
      value = op.op === 'set' ? settingsSchema.setPath(value, op.path, op.value) : settingsSchema.deletePath(value, op.path)
      user = op.op === 'set' ? settingsSchema.setPath(user, op.path, op.value) : settingsSchema.deletePath(user, op.path)
    }
    const next = { ...current, value, user, revision: current.revision + 1 }
    if (request.ns === section.ns) section = next
    else defaultSection = next
    return { result: { ok: true, value: next } }
  })
  const api = {
    llm: {
      providers: vi.fn(async () => ({ result: { ok: true, value: { providers: ['existing', 'catalog'].map(provider => ({
        provider, displayName: provider === 'existing' ? 'Existing' : 'Catalog',
        settingsNs: section.ns, settingsPath: ['providers', provider],
        active: options.inactive !== true && settingsSchema.hasPath(section.value, ['providers', provider]),
      })) } } })),
      models: vi.fn(async () => ({ result: { ok: true, value: {
        groups: ['existing', 'catalog'].filter(provider => settingsSchema.hasPath(section.value, ['providers', provider]))
          .map(provider => ({ id: provider, name: provider === 'existing' ? 'Existing' : 'Catalog',
            models: [{ id: 'chat', name: 'Chat' }] })),
        failures: [],
      } } })),
    },
    settings: {
      describe: vi.fn(async () => ({ result: { ok: true, value: {
        writable: true, hasDocument: true, namespaces: [section, defaultSection],
      } } })),
      mutate,
    },
    credentials: {
      describe: vi.fn(async (request: { refs: string[] }) => options.credentialError === true
        ? { result: { ok: false, error: { code: 'internal', message: 'credential service unavailable' } } }
        : { result: { ok: true, value: {
          credentials: Object.fromEntries(request.refs.map(ref => [ref, credential])),
        } } }),
      set: vi.fn(async () => ({ result: { ok: true, value: {} } })),
    },
  }
  const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api as never))
  await controller.load()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused hook') }) as never
  if (options.onboarding === true) {
    render(<DeepSeekOnboardingDialog stepId="deepseek-official" complete={complete} openSection={vi.fn()}
      useSessions={unusedHook} useWorkspaces={unusedHook} controller={controller}
      useModels={bindSnapshotSelector(controller.store)} api={api as never} schema={settingsSchema} t={key => en[key]} />)
  } else {
    render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
      api={api as never} schema={settingsSchema} t={key => en[key]} />)
  }
  return { api, controller, mutate, complete }
}

const existingCases: Array<FixtureOptions & { name: string }> = [
  { name: 'missing credential', profile: { apiKeyEnv: 'EXISTING_API_KEY' }, inactive: true },
  { name: 'credential lookup failure', profile: { apiKeyEnv: 'EXISTING_API_KEY' }, credentialError: true },
  { name: 'provider-native authentication', profile: {} },
  { name: 'composition profile', profile: { apiKeyEnv: 'EXISTING_API_KEY' }, baseProfile: true },
  { name: 'environment credential', profile: { apiKeyEnv: 'EXISTING_API_KEY' },
    credential: { configured: true, source: 'env', writable: false } },
]

describe('configured channel projection', () => {
  it.each(existingCases)('retains an existing channel with $name', async (options) => {
    const { controller } = await mount(options)
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).getByRole('button', { name: /Existing/ }).getAttribute('aria-current')).toBe('true')
    expect(within(rail).queryByRole('button', { name: 'Catalog' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Existing' })).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    const existing = controller.store.getSnapshot().rows.find(row => row.entry.provider === 'existing')
    expect(existing?.configured).toBe(true)
    expect(existing?.removable).toBe(options.baseProfile !== true)
    expect(within(rail).queryByText(en.configuredShort) !== null).toBe(options.credential?.configured === true)
  })

  it('keeps an empty channel list empty until adding a catalog profile explicitly', async () => {
    const { api, mutate } = await mount()
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).queryByRole('button', { name: 'Existing' })).toBeNull()
    expect(within(rail).queryByRole('button', { name: 'Catalog' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Existing' })).toBeNull()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.getByText(en.intro)).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: en.provider })
    expect([...picker.options].map(option => option.value)).toEqual(['existing', 'catalog'])
    fireEvent.change(picker, { target: { value: 'catalog' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Catalog' }).getAttribute('aria-current')).toBe('true')
    })
    expect(mutate).toHaveBeenCalledWith({ ns: 'llm-pi-ai', expectedRevision: 0,
      ops: [{ op: 'set', path: ['providers', 'catalog'], value: {} }] })
    expect(api.credentials.set).not.toHaveBeenCalled()
    expect(within(rail).queryByRole('button', { name: 'Existing' })).toBeNull()
  })

  it('can configure the first channel and select its default model during onboarding', async () => {
    const { complete, mutate } = await mount({ onboarding: true })
    expect(screen.getByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    const models = screen.getByRole<HTMLSelectElement>('combobox', { name: en.onboardingModel })
    await waitFor(() => { expect([...models.options].map(option => option.value)).toContain('existing\u0000chat') })
    expect(screen.getByRole('complementary', { name: en.provider }).textContent).toContain('Existing')
    fireEvent.change(models, { target: { value: 'existing\u0000chat' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingStart }))
    await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
    expect(mutate).toHaveBeenLastCalledWith({ ns: 'agent-default-model', expectedRevision: 0, ops: [
      { op: 'set', path: ['provider'], value: 'existing' },
      { op: 'set', path: ['model'], value: 'chat' },
      { op: 'unset', path: ['reasoningEffort'] },
    ] })
  })
})
