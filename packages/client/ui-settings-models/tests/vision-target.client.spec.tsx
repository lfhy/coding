// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { VisionSection } from '../src/client/VisionSection.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const vision = {
  ns: 'vision-understanding',
  schema: {},
  value: {}, user: {}, revision: 3, applies: 'live' as const, secrets: [],
}

function wire(value: Record<string, string> = {}, candidates = true, writable = true) {
  const namespace = { ...vision, value }
  const mutate = vi.fn(async () => ({ result: { ok: true, value: {
    ...namespace, revision: 4, value: { provider: 'vision', model: 'image-1' }, user: { provider: 'vision', model: 'image-1' },
  } } }))
  const api = {
    llm: {
      providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
        { provider: 'vision', displayName: 'Vision', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'vision'], active: true },
        { provider: 'no-key', displayName: 'No key', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'no-key'], active: true },
      ] } } })),
      models: vi.fn(async () => ({ result: { ok: true, value: { groups: candidates ? [
        { id: 'vision', name: 'Vision', models: [
          { id: 'image-1', name: 'Image 1', inputModalities: ['text', 'image'] },
          { id: 'unknown', name: 'Unknown' },
          { id: 'text', name: 'Text', inputModalities: ['text'] },
        ] },
        { id: 'no-key', name: 'No key', models: [{ id: 'image-2', name: 'Image 2', inputModalities: ['image'] }] },
      ] : [], failures: [] } } })),
    },
    credentials: { describe: vi.fn(async () => ({ result: { ok: true, value: { credentials: {
      VISION_API_KEY: { configured: true, writable: true },
      NO_KEY_API_KEY: { configured: false, writable: true },
    } } } })) },
    settings: {
      describe: vi.fn(async () => ({ result: { ok: true, value: { writable, hasDocument: true, namespaces: [
        namespace,
        { ns: 'llm-pi-ai', schema: namespace.schema, value: { providers: {
          vision: { apiKeyEnv: 'VISION_API_KEY' }, 'no-key': { apiKeyEnv: 'NO_KEY_API_KEY' },
        } }, user: {}, revision: 0, applies: 'live', secrets: [] },
      ] } } })), mutate,
    },
  }
  return { api, mutate }
}

async function mount(value: Record<string, string> = {}, candidates = true, writable = true) {
  const { api, mutate } = wire(value, candidates, writable)
  const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
  await controller.load()
  renderStore(controller, api)
  return { controller, mutate }
}

function renderStore(controller: ModelsSettingsStore, api: ReturnType<typeof wire>['api']) {
  render(<VisionSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
    schema={settingsSchema} api={api as never} t={key => en[key]} />)
}

describe('vision-understanding settings', () => {
  it('keeps the separate section readable when its namespace is absent', async () => {
    const { api } = wire()
    const original = await api.settings.describe()
    api.settings.describe = vi.fn(async () => ({ result: { ok: true, value: {
      ...original.result.value,
      namespaces: original.result.value.namespaces.filter(namespace => namespace.ns !== 'vision-understanding'),
    } } }))
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    renderStore(controller, api)
    expect(screen.getByRole('heading', { name: en.visionFallback })).toBeTruthy()
    expect(screen.getByText(en.visionUnavailable)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: en.visionRoute })).toBeNull()
  })

  it('shows a failed settings load with a retry action', async () => {
    const { api } = wire()
    const original = api.settings.describe
    api.settings.describe = vi.fn().mockResolvedValueOnce({ result: { ok: false, error: { message: 'settings offline' } } })
      .mockImplementation(original) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    renderStore(controller, api)
    expect(screen.getByRole('alert').textContent).toContain('settings offline')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByRole('combobox', { name: en.visionRoute })).toBeTruthy() })
  })

  it('refreshes a held settings mirror after a failed background read', async () => {
    const { api } = wire()
    const mirror = new SettingsDescribeMirror(api)
    const controller = new ModelsSettingsStore(api as never, settingsSchema, mirror)
    await controller.load()
    const original = api.settings.describe
    api.settings.describe = vi.fn().mockResolvedValueOnce({ result: { ok: false, error: { message: 'settings stale' } } })
      .mockImplementation(original) as never
    await mirror.load()
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', hasLoaded: true })
    renderStore(controller, api)
    expect(screen.getByRole('alert').textContent).toContain('settings stale')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(screen.getByRole('combobox', { name: en.visionRoute })).toBeTruthy() })
    expect(api.settings.describe).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('offers only explicit image-capable models on usable configured routes, then writes a revision-fenced pair', async () => {
    const { controller, mutate } = await mount()
    expect(controller.store.getSnapshot().visionModels).toEqual([
      { provider: 'vision', providerName: 'Vision', model: 'image-1', modelName: 'Image 1' },
    ])
    expect(screen.getByRole('heading', { name: en.visionFallback, level: 1 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.visionTool })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Vision' })).toBeNull()
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: en.visionRoute })
    expect(picker.parentElement?.querySelector('[aria-hidden="true"] svg')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: en.visionRoute }), { target: { value: JSON.stringify(['vision', 'image-1']) } })
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ ns: 'vision-understanding', expectedRevision: 3, ops: [
      { op: 'set', path: ['provider'], value: 'vision' }, { op: 'set', path: ['model'], value: 'image-1' },
    ] }) })
    expect(screen.getByRole('combobox', { name: en.visionRoute })).toBeTruthy()
  })

  it('keeps an old target visible, reports empty candidates and allows clearing the pair', async () => {
    const { mutate } = await mount({ provider: 'old', model: 'retired' }, false)
    expect(screen.getByText(en.visionNoCandidates)).toBeTruthy()
    expect(screen.getByText(en.visionOldTarget)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: en.visionRoute }), { target: { value: '' } })
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ ns: 'vision-understanding', expectedRevision: 3, ops: [
      { op: 'unset', path: ['provider'] }, { op: 'unset', path: ['model'] },
    ] }) })
  })

  it('reports a usable provider catalog failure, retains its saved target, and retries successfully', async () => {
    const { api } = wire({ provider: 'vision', model: 'retired' })
    const original = api.llm.models
    api.llm.models = vi.fn().mockResolvedValueOnce({ result: { ok: true, value: {
      groups: [], failures: [{ id: 'vision', name: 'Vision', message: 'catalog timeout' }],
    } } }).mockImplementation(original) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', visionModels: [],
      visionModelsError: 'Vision (vision): catalog timeout' })
    renderStore(controller, api)
    expect(screen.getByRole('alert').textContent).toContain('catalog timeout')
    expect(screen.queryByText(en.visionNoCandidates)).toBeNull()
    expect(screen.queryByText(en.visionOldTarget)).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.visionRoute }).value)
      .toBe(JSON.stringify(['vision', 'retired']))
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(controller.store.getSnapshot().visionModelsError).toBeNull() })
    expect(controller.store.getSnapshot().visionModels).toHaveLength(1)
    expect(screen.getByText(en.visionOldTarget)).toBeTruthy()
  })

  it('keeps successful candidates while diagnosing another usable provider failure', async () => {
    const { api } = wire()
    api.credentials.describe = vi.fn(async () => ({ result: { ok: true, value: { credentials: {
      VISION_API_KEY: { configured: true, writable: true }, NO_KEY_API_KEY: { configured: true, writable: true },
    } } } }))
    const original = await api.llm.models()
    api.llm.models = vi.fn(async () => ({ result: { ok: true, value: {
      groups: original.result.value.groups.filter(group => group.id === 'vision'),
      failures: [{ id: 'no-key', name: 'No key', message: 'gateway unavailable' }],
    } } })) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    expect(controller.store.getSnapshot().visionModels).toEqual([
      { provider: 'vision', providerName: 'Vision', model: 'image-1', modelName: 'Image 1' },
    ])
    expect(controller.store.getSnapshot().visionModelsError).toContain('No key (no-key): gateway unavailable')
    renderStore(controller, api)
    expect(screen.getByRole('option', { name: 'Vision / Image 1' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('gateway unavailable')
    expect(screen.queryByText(en.visionNoCandidates)).toBeNull()
  })

  it('ignores catalog failures from unusable providers and reports a genuine empty candidate set', async () => {
    const { api } = wire({ provider: 'old', model: 'retired' })
    api.llm.models = vi.fn(async () => ({ result: { ok: true, value: {
      groups: [], failures: [{ id: 'no-key', name: 'No key', message: 'irrelevant failure' }],
    } } })) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    expect(controller.store.getSnapshot().visionModelsError).toBeNull()
    renderStore(controller, api)
    expect(screen.getByText(en.visionNoCandidates)).toBeTruthy()
    expect(screen.getByText(en.visionOldTarget)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the independent detail readable but disables writes for read-only settings', async () => {
    await mount({}, true, false)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.visionRoute }).disabled).toBe(true)
  })

  it.each([
    ['host rejection', () => Promise.resolve({ result: { ok: false, error: { message: 'models denied' } } }), 'models denied'],
    ['transport rejection', () => Promise.reject(new Error('models offline')), 'models offline'],
  ])('reports %s without claiming an empty catalog, preserves the saved target and retries', async (_name, failed, diagnostic) => {
    const { api } = wire({ provider: 'old', model: 'retired' })
    const original = api.llm.models
    api.llm.models = vi.fn().mockImplementationOnce(failed).mockImplementation(original) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', visionModelsError: diagnostic })
    expect(controller.store.getSnapshot().rows).toHaveLength(2)
    renderStore(controller, api)
    expect(screen.getByRole('alert').textContent).toContain(diagnostic)
    expect(screen.queryByText(en.visionNoCandidates)).toBeNull()
    expect(screen.queryByText(en.visionOldTarget)).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.visionRoute }).value)
      .toBe(JSON.stringify(['old', 'retired']))
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => {
      expect(controller.store.getSnapshot().visionModelsError).toBeNull()
      expect(controller.store.getSnapshot().visionModels).toHaveLength(1)
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(en.visionNoCandidates)).toBeNull()
  })

  it('does not let a stale vision-directory failure replace a newer successful refresh', async () => {
    const { api } = wire()
    const original = api.llm.models
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    api.llm.models = vi.fn()
      .mockImplementationOnce(async () => { await gate; return { result: { ok: false, error: { message: 'stale failure' } } } })
      .mockImplementation(original) as never
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api))
    const oldLoad = controller.load()
    await waitFor(() => { expect(api.llm.models).toHaveBeenCalledTimes(1) })
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', visionModelsError: null })
    expect(controller.store.getSnapshot().visionModels).toHaveLength(1)
    release?.()
    await oldLoad
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', visionModelsError: null })
    expect(controller.store.getSnapshot().visionModels).toHaveLength(1)
  })
})
