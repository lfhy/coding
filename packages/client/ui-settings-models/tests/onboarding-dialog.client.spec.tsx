// @vitest-environment jsdom
/** 首次引导直接配置模型页，并以已保存的可启动默认模型作为完成条件。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingDialogProps } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

let rpcId = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `onboarding-${rpcId++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `onboarding-${rpcId++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const deepSeekSchema = Schema.object({
  channelName: Schema.string().default('default'),
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
  models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string() })),
})
const defaultSchema = Schema.object({
  provider: Schema.string(), model: Schema.string(), reasoningEffort: Schema.string(),
})

function namespace(ns: string, schema: Schema, value: Record<string, unknown>, revision = 0): SettingsNamespaceView {
  return {
    ns, schema: JSON.parse(JSON.stringify(schema.toJSON())) as unknown,
    value, base: value, user: {}, applies: 'live', secrets: [], revision,
  }
}

function harness(options: {
  provider?: 'deepseek-official' | 'other' | 'none'
  secondProvider?: boolean
  configured?: boolean
  models?: boolean
  defaultModel?: boolean
  writable?: boolean
  keyWritable?: boolean
  directoryError?: string
  modelError?: string
  modelFailure?: string
  writeError?: string
  credentialError?: string
} = {}) {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  let hasKey = options.configured ?? false
  let hasModels = options.models ?? false
  let selectedDefault = options.defaultModel ?? false
  let revision = 0
  let catalogGate: Promise<void> | undefined
  let directoryError = options.directoryError
  let settingsError: string | undefined
  const provider = options.provider ?? 'deepseek-official'
  const providerId = provider === 'other' ? 'other' : 'deepseek-official'
  const credentialRef = provider === 'other' ? 'OTHER_API_KEY' : 'DEEPSEEK_API_KEY'
  let deepSeekValue: Record<string, unknown> = { apiKeyEnv: credentialRef, channelName: 'default' }
  const getDeepSeek = () => namespace('llm-deepseek', deepSeekSchema, deepSeekValue, revision)
  const getDefault = () => namespace('agent-default-model', defaultSchema,
    selectedDefault ? { provider: providerId, model: 'model-one' } : {})
  const mutate = vi.fn(async (payload: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] }) => {
    if (options.writeError !== undefined) return fail<SettingsNamespaceView>(options.writeError)
    if (payload.ns === 'agent-default-model') {
      selectedDefault = true
      return ok(getDefault())
    }
    for (const op of payload.ops) {
      if (op.op === 'set' && op.path.join('.') === 'models') {
        hasModels = true
        deepSeekValue = { ...deepSeekValue, models: op.value }
      }
    }
    revision += 1
    return ok(getDeepSeek())
  })
  const set = vi.fn(async () => { hasKey = true; return ok({}) })
  const face = {
    llm: {
      providers: async () => directoryError === undefined
        ? ok({ providers: provider === 'none' ? [] : [{
          provider: providerId, displayName: provider === 'other' ? 'Other AI' : 'DeepSeek',
          settingsNs: 'llm-deepseek', settingsPath: [], active: true,
        }, ...options.secondProvider ? [{ provider: 'other', displayName: 'Other AI',
          settingsNs: 'llm-deepseek', settingsPath: [], active: true }] : []] }) : fail(directoryError),
      models: async () => {
        if (catalogGate !== undefined) {
          const pending = catalogGate
          catalogGate = undefined
          await pending
        }
        return options.modelError === undefined
          ? ok({ groups: hasModels ? [{ id: providerId, name: provider === 'other' ? 'Other AI' : 'DeepSeek',
            models: [{ id: 'model-one', name: 'Model One' }] }] : [],
          failures: options.modelFailure === undefined ? [] : [{ id: providerId, name: 'Other AI', message: options.modelFailure }] })
          : fail(options.modelError)
      },
    },
    settings: {
      describe: async () => settingsError === undefined
        ? ok({ writable: options.writable ?? true, hasDocument: false,
          namespaces: [getDeepSeek(), getDefault()] }) : fail(settingsError),
      mutate,
    },
    credentials: {
      describe: async () => options.credentialError === undefined
        ? ok({ credentials: { [credentialRef]: { configured: hasKey,
          writable: options.keyWritable ?? true } } }) : fail(options.credentialError),
      set, unset: vi.fn(),
    },
  }
  const mirror = new SettingsDescribeMirror(face as never)
  const controller = new ModelsSettingsStore(face as never, settingsSchema, mirror)
  const complete = vi.fn()
  const openSection = vi.fn()
  const unusedHook = (() => { throw new Error('unused hook') }) as never
  const props: DeepSeekOnboardingDialogProps = {
    stepId: 'deepseek-official', complete, openSection,
    useSessions: unusedHook, useWorkspaces: unusedHook,
    controller, useModels: bindSnapshotSelector(controller.store),
    api: face as never, schema: settingsSchema, t: key => en[key],
  }
  return { props, controller, mirror, complete, openSection, mutate, set,
    setDirectoryError: (error: string | undefined) => { directoryError = error },
    setSettingsError: (error: string | undefined) => { settingsError = error },
    pauseCatalog: () => {
      let release = (): void => {}
      catalogGate = new Promise<void>((resolve) => { release = resolve })
      return release
    },
  }
}

describe('DeepSeekOnboardingDialog', () => {
  it('blocks the workbench while the initial catalog is unresolved without flashing a dialog', async () => {
    const h = harness({ configured: true, models: true, defaultModel: true })
    const release = h.pauseCatalog()
    const appRoot = document.getElementById('root')!
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(appRoot.inert).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { release() })
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
    expect(appRoot.inert).toBeFalsy()
    expect(screen.queryByRole('dialog')).toBeNull()
    view.unmount()
    expect(appRoot.inert).toBeFalsy()
  })

  it('blocks during initial model loading and restores interaction after a required setup unmounts', async () => {
    const h = harness({ configured: true })
    const release = h.pauseCatalog()
    const appRoot = document.getElementById('root')!
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(appRoot.inert).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { release() })
    await screen.findByText(en.onboardingNoModels)
    expect(appRoot.inert).toBe(true)
    view.unmount()
    expect(appRoot.inert).toBeFalsy()
  })

  it('keeps one modal through loading and missing provider, without opening Settings', async () => {
    const h = harness({ provider: 'none' })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await screen.findByText(en.onboardingProviderUnavailable)
    const dialog = screen.getByRole('dialog', { name: en.onboardingTitle })
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(true)
    expect(h.complete).not.toHaveBeenCalled()
    expect(h.openSection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
    expect(within(dialog).queryByText(en.visionFallback)).toBeNull()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('keeps a provider without models in setup until a model is actually available', async () => {
    const h = harness({ configured: true })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingNoModels)
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(true)
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('keeps the selected channel and unsaved draft mounted throughout a refresh', async () => {
    const h = harness({ secondProvider: true, configured: true, models: true })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSelectHint)
    fireEvent.click(screen.getByRole('button', { name: /^Other AI/ }))
    expect(screen.getByRole('heading', { name: 'Other AI' })).toBeTruthy()
    const channelName = screen.getByLabelText<HTMLInputElement>(en.channelName)
    fireEvent.change(channelName, { target: { value: 'Uncommitted channel' } })
    const selector = screen.getByLabelText<HTMLSelectElement>(en.onboardingModel)
    fireEvent.change(selector, { target: { value: 'deepseek-official\u0000model-one' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(false)
    const release = h.pauseCatalog()
    let refresh: Promise<void> | undefined
    await act(async () => { refresh = h.controller.load() })
    expect(screen.getByText(en.onboardingLoading)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Other AI' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.channelName)).toBe(channelName)
    expect(channelName.value).toBe('Uncommitted channel')
    expect(selector.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(true)
    await act(async () => { release(); await refresh })
    await screen.findByText(en.onboardingSelectHint)
    expect(screen.getByRole('heading', { name: 'Other AI' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.channelName)).toBe(channelName)
    expect(channelName.value).toBe('Uncommitted channel')
    expect(selector.disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(false)
  })

  it('preserves key and manual model drafts on a failed refresh, disables saving, and retries', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingCredentialMissing)
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-unsaved' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    const model = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
    fireEvent.change(model, { target: { value: 'manual-unsaved' } })
    h.setDirectoryError('directory offline')
    await act(async () => { await h.controller.load() })
    expect(screen.getByText(text => text.includes('directory offline'))).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput)).toBe(key)
    expect(key.value).toBe('sk-unsaved')
    expect(key.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)).toBe(model)
    expect(model.value).toBe('manual-unsaved')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(true)
    expect(h.set).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
    h.setDirectoryError(undefined)
    fireEvent.click(screen.getAllByRole('button', { name: en.retry })[0]!)
    await waitFor(() => { expect(key.disabled).toBe(false) })
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput)).toBe(key)
    expect(key.value).toBe('sk-unsaved')
    expect(model.value).toBe('manual-unsaved')
  })

  it('preserves drafts and refuses completion when the held settings mirror fails to refresh', async () => {
    const h = harness({ configured: true, models: true })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSelectHint)
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-held-draft' } })
    h.setSettingsError('settings refresh offline')
    await act(async () => { await h.mirror.load(); await h.controller.load() })
    expect(screen.getByText(text => text.includes('settings refresh offline'))).toBeTruthy()
    expect(key.value).toBe('sk-held-draft')
    expect(key.disabled).toBe(true)
    expect(h.complete).not.toHaveBeenCalled()
    h.setSettingsError(undefined)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(key.disabled).toBe(false) })
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput)).toBe(key)
    expect(key.value).toBe('sk-held-draft')
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('configures a key and a model in the embedded editor, then saves the default', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingCredentialMissing)
    expect(screen.getByLabelText(en.baseUrl)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-first-run' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'model-one' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(h.set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-first-run' }) })
    const selector = await screen.findByLabelText<HTMLSelectElement>(en.onboardingModel)
    await waitFor(() => { expect(selector.options.length).toBe(2) })
    expect(h.complete).not.toHaveBeenCalled()
    fireEvent.change(selector, { target: { value: 'deepseek-official\u0000model-one' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingStart }))
    await waitFor(() => { expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({
      ns: 'agent-default-model', expectedRevision: 0,
      ops: [
        { op: 'set', path: ['provider'], value: 'deepseek-official' },
        { op: 'set', path: ['model'], value: 'model-one' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
    })) })
    await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('dialog', { name: en.onboardingTitle })).toBeNull()
  })

  it('offers another provider model and skips when a saved default already matches', async () => {
    const h = harness({ provider: 'other', configured: true, models: true })
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSelectHint)
    expect(screen.getByRole('option', { name: /Other AI.*Model One/ })).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
    view.unmount()
    document.getElementById('root')?.remove()

    const ready = harness({ provider: 'other', configured: true, models: true, defaultModel: true })
    render(<DeepSeekOnboardingDialog {...ready.props} />)
    await waitFor(() => { expect(ready.complete).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows partial model directory failures while retaining an available choice and retry', async () => {
    const h = harness({ configured: true, models: true, modelFailure: 'gateway timeout' })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(text => text.includes('gateway timeout'))
    expect(screen.getByRole('option', { name: /Model One/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('keeps failures and read-only deployments visible instead of completing by credential alone', async () => {
    for (const [options, diagnostic] of [
      [{ configured: true, writable: false, models: true }, en.onboardingReadOnly],
      [{ configured: true, modelError: 'catalog offline' }, en.onboardingCatalogFailed],
      [{ directoryError: 'directory offline' }, en.onboardingLoadFailed],
      [{ credentialError: 'vault offline' }, en.onboardingCredentialsUnavailable],
      [{ keyWritable: false }, en.onboardingCredentialReadOnly],
    ] as const) {
      const h = harness(options)
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await screen.findByText(text => text.includes(diagnostic))
      expect(screen.getByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
      expect(h.complete).not.toHaveBeenCalled()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingStart }).disabled).toBe(true)
      view.unmount()
      document.getElementById('root')?.remove()
    }
  })

  it('reports a failed default write without closing', async () => {
    const h = harness({ configured: true, models: true, writeError: 'revision conflict' })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSelectHint)
    fireEvent.change(screen.getByLabelText(en.onboardingModel), { target: { value: 'deepseek-official\u0000model-one' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingStart }))
    expect(await screen.findByText('revision conflict')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
  })

  it('blocks implicit dismissal, restores inert and returns focus on unmount', async () => {
    const focus = document.createElement('button')
    document.body.append(focus)
    focus.focus()
    const h = harness({ configured: true, models: true })
    const appRoot = document.getElementById('root')!
    appRoot.inert = true
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSelectHint)
    expect(appRoot.inert).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: en.onboardingTitle }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog').parentElement!.firstElementChild!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.complete).not.toHaveBeenCalled()
    view.unmount()
    expect(appRoot.inert).toBe(true)
    expect(document.activeElement).toBe(focus)
    focus.remove()
  })

  it('lets a child confirmation consume Escape without closing the onboarding container', () => {
    function Nested(): ReactNode {
      const [innerOpen, setInnerOpen] = useState(true)
      return <OnboardingModal title="Setup" focusTitle>
        <Modal open={innerOpen} title="Confirm" onClose={() => { setInnerOpen(false) }}>Continue editing</Modal>
      </OnboardingModal>
    }
    render(<Nested />)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy()
  })
})
