// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from 'coding-client-runtime/client'
import { SettingsDescribeMirror } from 'coding-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { TitleRow, type TitleRowProps } from '../src/client/TitleRow.tsx'
import { en, type ModelsKey } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

/** 通用设置行不读全局会话/工作区钩子，这里只补齐占位实现。 */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/** 标题模型分节的默认取值；调用方可以覆盖模式与路由。 */
const title = {
  ns: 'session-title',
  schema: {},
  value: { mode: 'inherit' },
  user: {},
  revision: 3,
  applies: 'live' as const,
  secrets: [],
}

function wire(value: Record<string, unknown> = { mode: 'inherit' }, writable = true) {
  const namespace = { ...title, value }
  const mutate = vi.fn(async () => ({ result: { ok: true, value: { ...namespace, revision: 4 } } }))
  const api = {
    llm: {
      providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
        { provider: 'vision', displayName: 'Vision', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'vision'], active: true },
      ] } } })),
      models: vi.fn(async () => ({ result: { ok: true, value: { groups: [
        { id: 'vision', name: 'Vision', models: [
          { id: 'text-1', name: 'Text 1', inputModalities: ['text'] },
          { id: 'text-2', name: 'Text 2', inputModalities: ['text'] },
        ] },
      ], failures: [] } } })),
    },
    credentials: { describe: vi.fn(async () => ({ result: { ok: true, value: { credentials: {
      VISION_API_KEY: { configured: true, writable: true },
    } } } })) },
    settings: {
      describe: vi.fn(async () => ({ result: { ok: true, value: { writable, hasDocument: true, namespaces: [
        namespace,
        { ns: 'llm-pi-ai', schema: namespace.schema, value: { providers: {
          vision: { apiKeyEnv: 'VISION_API_KEY' },
        } }, user: {}, revision: 0, applies: 'live', secrets: [] },
      ] } } })), mutate,
    },
  }
  return { api, mutate }
}

async function mount(value: Record<string, unknown> = { mode: 'inherit' }, writable = true) {
  const { api, mutate } = wire(value, writable)
  const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api as never))
  await controller.load()
  render(<TitleRow controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
    schema={settingsSchema} api={api as never}
    t={((key: ModelsKey) => en[key]) as TitleRowProps['t']}
    useSessions={emptySessions()} useWorkspaces={emptyWorkspaces()} />)
  return { controller, mutate }
}

describe('session-title model settings', () => {
  it('offers the three title model modes and inherits the conversation model by default', async () => {
    const { mutate } = await mount()
    expect(screen.getByText(en.titleModelSection)).toBeTruthy()
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: en.titleModelMode })
    expect(picker.value).toBe('inherit')
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      en.titleModelInherit,
      en.titleModelCustom,
      en.titleModelOff,
    ])
    expect(mutate).not.toHaveBeenCalled()
  })

  it('writes the off mode and clears any stored route', async () => {
    const { mutate } = await mount({ mode: 'custom', provider: 'vision', model: 'text-1' })
    fireEvent.change(screen.getByRole('combobox', { name: en.titleModelMode }), { target: { value: 'off' } })
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ ns: 'session-title', expectedRevision: 3, ops: [
      { op: 'set', path: ['mode'], value: 'off' },
      { op: 'unset', path: ['provider'] },
      { op: 'unset', path: ['model'] },
    ] }) })
  })

  it('keeps a stored route and switches it to the custom mode in one write', async () => {
    const { mutate } = await mount({ mode: 'inherit', provider: 'vision', model: 'text-1' })
    fireEvent.change(screen.getByRole('combobox', { name: en.titleModelMode }), { target: { value: 'custom' } })
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ ns: 'session-title', expectedRevision: 3, ops: [
      { op: 'set', path: ['mode'], value: 'custom' },
      { op: 'set', path: ['provider'], value: 'vision' },
      { op: 'set', path: ['model'], value: 'text-1' },
    ] }) })
  })

  it('reveals the model picker when no route is stored yet and writes the picked model', async () => {
    const { mutate } = await mount()
    fireEvent.change(screen.getByRole('combobox', { name: en.titleModelMode }), { target: { value: 'custom' } })
    await waitFor(() => { expect(screen.getByRole('combobox', { name: en.titleModelRoute })).toBeTruthy() })
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('combobox', { name: en.titleModelRoute }), {
      target: { value: JSON.stringify(['vision', 'text-2']) },
    })
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ ns: 'session-title', expectedRevision: 3, ops: [
      { op: 'set', path: ['mode'], value: 'custom' },
      { op: 'set', path: ['provider'], value: 'vision' },
      { op: 'set', path: ['model'], value: 'text-2' },
    ] }) })
  })

  it('reports an unavailable namespace and keeps writes disabled for a read-only document', async () => {
    const { api } = wire()
    const original = await api.settings.describe()
    api.settings.describe = vi.fn(async () => ({ result: { ok: true, value: {
      ...original.result.value,
      namespaces: original.result.value.namespaces.filter(namespace => namespace.ns !== 'session-title'),
    } } }))
    const controller = new ModelsSettingsStore(api as never, settingsSchema, new SettingsDescribeMirror(api as never))
    await controller.load()
    render(<TitleRow controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
      schema={settingsSchema} api={api as never}
      t={((key: ModelsKey) => en[key]) as TitleRowProps['t']}
      useSessions={emptySessions()} useWorkspaces={emptyWorkspaces()} />)
    expect(screen.getByText(en.titleModelUnavailable)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: en.titleModelMode })).toBeNull()

    await mount({ mode: 'inherit' }, false)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.titleModelMode }).disabled).toBe(true)
  })
})
