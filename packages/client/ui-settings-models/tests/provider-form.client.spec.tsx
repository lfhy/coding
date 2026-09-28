// @vitest-environment jsdom
/** 模型目录编辑、端点发现，以及手工声明渠道的交互契约。 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsSection, providerCopy } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { CustomProviderCard } from '../src/client/CustomProviderCard.tsx'
import { formatCapacity, parseCapacity } from '../src/client/DeepSeekModelsEditor.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore, deriveKeyRef, protocolChoices } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const PI_AI_CAPABILITIES = {
  input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
}

/** 手工添加与发现导入都声明完整能力，不依赖模型名称猜测。 */
function piAiModel(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, ...PI_AI_CAPABILITIES }
}

/** The pi-ai profile shape as the host serializes it, including the layer-1 fields. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref'),
    displayName: Schema.string(),
    api: Schema.union(PROTOCOLS),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string(),
      contextWindow: Schema.number(),
      maxTokens: Schema.number(),
    })),
    reasoning: Schema.union(['off', 'high']),
  })),
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string, code: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code, message, details: {} } as never } }
}

function piAiNamespace(
  providers: Record<string, unknown>,
  userProviders: Record<string, unknown> = providers,
  baseProviders: Record<string, unknown> = {},
): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as unknown,
    // `value` is the effective section; `user` is only the layer this page
    // writes. They differ whenever a composition `base` supplies something.
    value: { providers },
    base: { providers: baseProviders },
    user: { providers: userProviders },
    applies: 'live',
    secrets: [],
    revision: 3,
  }
}

function scriptedFace(options: {
  providers?: Record<string, unknown>
  /** User layer, when it differs from the effective section. */
  userProviders?: Record<string, unknown>
  /** Composition layer, for a route a `cordis.yml` pins rather than the page. */
  baseProviders?: Record<string, unknown>
  /** Routes the adapter reports as hand-declared; the rest come back as shipped. */
  declaredRoutes?: readonly string[]
  /** 适配器目录中尚未配置的路由不会占用左栏，而是在添加入口供选择。 */
  directory?: readonly string[]
  discover?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
} = {}) {
  const providers = options.providers ?? {
    openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy.example/v1' },
  }
  const namespace = piAiNamespace(providers, options.userProviders ?? providers, options.baseProviders ?? {})
  const discover = options.discover ?? vi.fn(() => Promise.resolve(ok({ models: [] })))
  const mutate = options.mutate ?? vi.fn(() => Promise.resolve(ok(namespace)))
  const set = options.set ?? vi.fn(() => Promise.resolve(ok({})))
  const face = {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: (options.directory ?? Object.keys(providers)).map(provider => ({
          provider,
          displayName: provider,
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', provider],
          active: true,
          declared: options.declaredRoutes?.includes(provider) ?? false,
        })),
      }))),
      models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
      discoverModels: discover,
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({ writable: true, namespaces: [namespace] }))),
      update: vi.fn(),
      replace: vi.fn(),
      mutate,
    },
    credentials: {
      describe: vi.fn((payload: { refs: string[] }) => Promise.resolve(ok({
        credentials: Object.fromEntries(payload.refs.map(ref => [ref, { configured: false, writable: true }])),
      }))),
      set,
      unset: vi.fn(),
    },
  }
  return { face, discover, mutate, set, namespace }
}

type WireFace = ConstructorParameters<typeof ModelsSettingsStore>[0]

/** The settings write one card produced, as the scripted face recorded it. */
interface MutateCall {
  ns: string
  expectedRevision?: number
  ops: { op: string; path: string[]; value?: unknown }[]
}

/** The first interrogation payload; fails the case when nothing was asked. */
function firstProbe(discover: ReturnType<typeof vi.fn>): unknown {
  const call = (discover.mock.calls as unknown as [unknown][])[0]?.[0]
  if (call === undefined) throw new Error('no interrogation was recorded')
  return call
}

/** The first recorded settings write; fails the case when nothing was written. */
function firstMutate(mutate: ReturnType<typeof vi.fn>): MutateCall {
  const call = mutate.mock.calls[0]?.[0] as MutateCall | undefined
  if (call === undefined) throw new Error('no settings write was recorded')
  return call
}

async function mountSection(options: Parameters<typeof scriptedFace>[0] = {}) {
  const scripted = scriptedFace(options)
  const controller = new ModelsSettingsStore(
    scripted.face as unknown as WireFace, settingsSchema, new SettingsDescribeMirror(scripted.face as never))
  await controller.load()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: scripted.face as never,
    schema: settingsSchema,
    t,
  }
  render(<ModelsSection {...injected} />)
  return { ...scripted, controller }
}

/** 渠道目录选中后，详情始终展示凭据、端点和模型目录。 */
function openEditor(provider: string): void {
  const rail = screen.getByRole('complementary', { name: en.provider })
  fireEvent.click(within(rail).getByRole('button', { name: provider }))
  expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: provider })).toBeTruthy()
}

/** Open one model row's advanced fold, where the capacities live. */
function expandModel(index: number): void {
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} ${index}` }))
}

/** The button carrying `label`, typed so its disabled/title state is readable. */
function buttonNamed(label: string): HTMLButtonElement {
  const found = screen.getByRole('button', { name: label })
  if (!(found instanceof HTMLButtonElement)) throw new Error(`"${label}" is not a button`)
  return found
}

/** 按可访问名称定位复选框，并保证 checked 读取来自真实 input。 */
function checkbox(scope: HTMLElement, name: string): HTMLInputElement {
  const found = within(scope).getByRole('checkbox', { name })
  if (!(found instanceof HTMLInputElement)) throw new Error(`"${name}" is not a checkbox input`)
  return found
}

/** Click the button with `label` inside `scope`. */
function within_(scope: HTMLElement, label: string): HTMLElement {
  return within(scope).getByRole('button', { name: label })
}

describe('protocolChoices', () => {
  it('reads the protocols out of the namespace schema and nothing else', async () => {
    const { namespace } = scriptedFace()
    expect(protocolChoices(namespace, settingsSchema)).toEqual(PROTOCOLS)
    expect(protocolChoices(undefined, settingsSchema)).toEqual([])
    const plain = { ...namespace, schema: JSON.parse(JSON.stringify(Schema.object({}).toJSON())) as unknown }
    expect(protocolChoices(plain, settingsSchema)).toEqual([])
    await Promise.resolve()
  })
})

describe('model list editing', () => {
  it('adds, edits, and removes rows without storing emptied optional fields', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '65536' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Acme' } })
    // Clearing an optional field must drop it rather than store an empty value.
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate)).toMatchObject({
      ns: 'llm-pi-ai',
      expectedRevision: 3,
      ops: [{ op: 'set', path: ['providers', 'openai', 'models'], value: [{ id: 'acme-large', contextWindow: 65_536 }] }],
    })
  })

  it('names a duplicate model id in the edit flow too', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'dup' }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'dup' } })

    // The create card refuses this in place; an edited route must not have to
    // learn it from the host's refusal instead.
    expect(screen.getByText(`${en.model} 2: ${en.modelIdDuplicate}`)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reads K and M suffixes and keeps the text the user typed', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '1M' } })
    fireEvent.change(screen.getByLabelText(`${en.modelMaxTokens} 1`), { target: { value: '32K' } })

    // The field keeps the spelling rather than snapping to the expansion, and
    // a plain count is not rewritten into a suffix mid-word either.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelContextWindow} 1`).value).toBe('1M')
    fireEvent.change(screen.getByLabelText(`${en.modelMaxTokens} 1`), { target: { value: '1000' } })
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelMaxTokens} 1`).value).toBe('1000')

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    // 设置中保存纯数值；输入框则保留用户正在键入的容量写法。
    expect(firstMutate(mutate).ops[0]?.value)
      .toEqual([piAiModel({ id: 'm', contextWindow: 1_000_000, maxTokens: 1000 })])
  })

  it('edits vision and reasoning for one model without changing another or losing unknown fields', async () => {
    const { mutate } = await mountSection({ providers: { openai: {
      baseURL: 'https://proxy.example/v1',
      models: [
        { ...piAiModel({ id: 'first', customField: 'kept' }) },
        piAiModel({ id: 'second' }),
      ],
    } } })
    openEditor('openai')
    expandModel(1)
    const main = screen.getByRole('main')
    expect(checkbox(main, en.visionSupport).checked).toBe(true)
    expect(checkbox(main, en.reasoningSupport).checked).toBe(true)
    fireEvent.click(within(main).getByRole('checkbox', { name: en.visionSupport }))
    fireEvent.click(within(main).getByRole('checkbox', { name: 'high' }))
    fireEvent.click(within(main).getByRole('button', { name: en.apply }))

    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'set', path: ['providers', 'openai', 'models'], value: [
      { id: 'first', customField: 'kept', input: ['text'], reasoningEfforts: { off: null, low: 'low', max: 'max' } },
      piAiModel({ id: 'second' }),
    ] }])
  })

  it('refuses to apply while a capacity is unreadable', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelMaxTokens} 1`), { target: { value: 'abc' } })

    // Silently dropping it would store a route sized differently from what the
    // field shows, so the text stays put and the write is refused instead.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelMaxTokens} 1`).value).toBe('abc')
    expect(screen.getByText(`${en.model} 1: ${en.modelMaxTokensInvalid}`)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('spells a stored capacity back the way it is typed', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'kept', contextWindow: 1_000_000, maxTokens: 256_000 }],
        },
      },
    })
    openEditor('openai')
    expandModel(1)

    // Opening a row reads the stored counts, which are plain integers; showing
    // them as such would make an already-configured route look unlike one the
    // user just typed, and re-applying would rewrite the field it read.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelContextWindow} 1`).value).toBe('1M')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelMaxTokens} 1`).value).toBe('256K')
  })

  it('edits one row of several and lets a cleared capacity leave the profile', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'first' }, { id: 'second' }] } },
    })
    openEditor('openai')

    expandModel(2)
    fireEvent.change(screen.getByLabelText(`${en.modelMaxTokens} 2`), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 2`), { target: { value: 'Second' } })
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 2`), { target: { value: '4096' } })
    // Clearing it back to empty must drop the field, not store a zero.
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 2`), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'first' },
      { id: 'second', name: 'Second', maxTokens: 2048 },
    ])
  })

  it('shows the adapter defaults as inherited until an edit takes them over', async () => {
    await mountSection({ providers: { openai: { baseURL: 'https://proxy.example/v1' } } })
    openEditor('openai')

    // The user layer names no models, so the list belongs to the adapter and
    // says so; taking it over is an explicit act, not a side effect of opening.
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.queryByText(en.resetModels)).toBeNull()
  })


  it('keeps expansion on the row it belongs to after an earlier one is removed', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        },
      },
    })
    openEditor('openai')

    // Expansion is keyed by position, so removing an earlier row shifts the
    // rest down; without reindexing, row 3 would inherit row 2's open state.
    expandModel(2)
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 1`))

    // 'second' now sits at position 1 and keeps its capacities open; 'third'
    // moved to position 2 and stays folded.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('second')
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).not.toBeNull()
    expect(screen.queryByLabelText(`${en.modelContextWindow} 2`)).toBeNull()
  })

  it('leaves an earlier row expanded and forgets the removed row\u2019s own state', async () => {
    await mountSection({
      providers: {
        openai: {
          baseURL: 'https://proxy.example/v1',
          models: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        },
      },
    })
    openEditor('openai')

    // A row before the removal keeps its own position and stays open.
    expandModel(1)
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('first')
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).not.toBeNull()

    // Removing the expanded row itself drops that state rather than handing it
    // to whichever row slides into the position.
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 1`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('third')
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).toBeNull()
  })

  it('allows editing a configured catalog without displaying a reset control', async () => {
    const { mutate } = await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept' }] } },
    })
    openEditor('openai')

    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    expect(screen.queryByRole('button', { name: en.resetModels })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: `${en.modelName} 1` }), { target: { value: 'Kept model' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops)
      .toContainEqual({ op: 'set', path: ['providers', 'openai', 'models'], value: [{ id: 'kept', name: 'Kept model' }] })
  })

})

describe('capacity spellings', () => {
  it.each([
    ['', undefined],
    ['65536', 65_536],
    ['256K', 256_000],
    ['1m', 1_000_000],
    // A decimal multiple is exact in intent but not in binary floating point,
    // so an integral result snaps back instead of landing a few ULPs high.
    ['2.3M', 2_300_000],
    // Not an integral count: kept as written rather than silently rounded.
    ['1.0005K', 1000.5],
  ])('reads %j as %j', (text, expected) => {
    expect(parseCapacity(text)).toBe(expected)
  })

  it.each(['abc', '12x', '1 000', '-5', ''])('refuses %j rather than guessing', (text) => {
    const parsed = parseCapacity(text)
    expect(parsed === undefined || Number.isNaN(parsed)).toBe(true)
  })

  it.each([
    [1_000_000, '1M'],
    [256_000, '256K'],
    [65_536, '65536'],
    // Never a spelling that would not survive being read back.
    [0, '0'],
    [1.5, '1.5'],
  ])('spells %j as %j', (value, expected) => {
    expect(formatCapacity(value)).toBe(expected)
  })

  it('round-trips every spelling it produces', () => {
    for (const value of [1_000_000, 256_000, 65_536, 4096, 1000]) {
      expect(parseCapacity(formatCapacity(value))).toBe(value)
    }
  })
})

describe('endpoint interrogation', () => {
  it('asks the endpoint the form shows, with a key that is not yet stored', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({ models: [{ id: 'acme-large', contextWindow: 65_536 }] })))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'typed-not-saved' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://edited.example/v1' } })
    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(firstProbe(discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      // The route is named, so an adapter that already describes it answers
      // from its own registry rather than the endpoint.
      provider: 'openai',
      baseURL: 'https://edited.example/v1',
      apiKey: 'typed-not-saved',
    })
  })

  it('carries the protocol the profile already names', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({ models: [] })))
    await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', api: 'openai-responses' } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(firstProbe(discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      provider: 'openai',
      baseURL: 'https://proxy.example/v1',
      api: 'openai-responses',
    })
  })

  it('adopts only the picked candidates, keeping a row the user already tuned', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({
      models: [{ id: 'kept', contextWindow: 999 }, { id: 'fresh', contextWindow: 4096, name: 'Fresh' }],
    })))
    const { mutate } = await mountSection({
      discover,
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'kept', contextWindow: 111 }] } },
    })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog', { name: `openai ${en.models}` })
    // 发现候选一律默认不选；显式选择新行也不会覆写已配置的容量。
    expect(checkbox(dialog, 'kept').checked).toBe(false)
    expect(checkbox(dialog, 'fresh').checked).toBe(false)
    fireEvent.click(checkbox(dialog, 'fresh'))
    fireEvent.click(within(dialog).getByRole('button', { name: en.fetchAdopt }))

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'kept', contextWindow: 111 },
      piAiModel({ id: 'fresh', contextWindow: 4096, name: 'Fresh' }),
    ])
  })

  it('searches the discovered list and imports one model without persisting before Apply', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({ models: [
      { id: 'acme-2.5-flash' }, { id: 'acme-2.5-pro' }, { id: 'elsewhere' },
    ] })))
    const { mutate } = await mountSection({ discover })
    openEditor('openai')
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    const dialog = await screen.findByRole('dialog', { name: `openai ${en.models}` })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.searchModels }),
      { target: { value: 'flash' } })
    expect(within(dialog).getByRole('checkbox', { name: 'acme-2.5-flash' })).toBeTruthy()
    expect(within(dialog).queryByRole('checkbox', { name: 'acme-2.5-pro' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: `${en.addModel} acme-2.5-flash` }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.getByRole('textbox', { name: `${en.modelId} 1` })).toHaveProperty('value', 'acme-2.5-flash')
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'openai', 'models'], value: [piAiModel({ id: 'acme-2.5-flash' })],
    }])
  })

  it('keeps the rows editable when the provider cannot be interrogated', async () => {
    const discover = vi.fn(() => Promise.resolve(
      fail('https://proxy.example/v1/models answered 401; check the API key', 'model-discovery-failed'),
    ))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))

    await screen.findByText(/answered 401; check the API key/)
    // The failure is a detour, not a dead end: hand-entry is still offered.
    expect(screen.getByRole('button', { name: en.addModel })).toBeTruthy()
  })

  it('reports an empty listing and a rejected transport', async () => {
    const empty = vi.fn(() => Promise.resolve(ok({ models: [] })))
    await mountSection({ discover: empty })
    openEditor('openai')
    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchEmpty)
    cleanup()

    const rejected = vi.fn(() => Promise.reject(new Error('carrier down')))
    await mountSection({ discover: rejected })
    openEditor('openai')
    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText('carrier down')
  })

  it('can be asked for a configured route even with no endpoint', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({ models: [{ id: 'from-registry' }] })))
    await mountSection({ discover, providers: { openai: {} } })
    openEditor('openai')

    // A route the adapter already describes needs no endpoint at all.
    expect(buttonNamed(en.fetchModels).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.fetchModels))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(firstProbe(discover)).toEqual({ settingsNs: 'llm-pi-ai', provider: 'openai' })
  })

  it('keeps the create card asking only once it has an endpoint', () => {
    // A provider being declared has no route yet, so the endpoint is the only
    // thing an interrogation could go on.
    const scripted = scriptedFace()
    render(
      <CustomProviderCard
        taken={[]} protocols={PROTOCOLS} revision={7} api={scripted.face as never}
        t={t} readOnly={false} onClose={vi.fn()}
      />,
    )
    expect(buttonNamed(en.fetchModels).disabled).toBe(true)
    expect(buttonNamed(en.fetchModels).title).toBe(en.fetchNeedsBaseUrl)

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(buttonNamed(en.fetchModels).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.fetchModels))

    // A provider being declared names no route, so only the endpoint travels.
    expect(firstProbe(scripted.discover)).toEqual({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://acme.test/v1',
      api: 'openai-completions',
    })
  })

  it('folds a row\u2019s capacities away until they are asked for', async () => {
    await mountSection({
      providers: { openai: { baseURL: 'https://proxy.example/v1', models: [{ id: 'only' }] } },
    })
    openEditor('openai')

    // The row shows what identifies a model; capacities are the exception.
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).toBeNull()
    expandModel(1)
    expect(screen.getByLabelText(`${en.modelContextWindow} 1`)).toBeTruthy()
    expandModel(1)
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).toBeNull()
  })

  it('closes the picker without adopting anything on cancel', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({ models: [{ id: 'fresh' }] })))
    const { mutate } = await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    // 编辑器本身也有取消按钮，这里只关闭发现弹窗。
    fireEvent.click(within_(dialog, en.cancel))

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: `openai ${en.models}` })).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('toggles a candidate off and back on before adopting', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({
      models: [{ id: 'a' }, { id: 'b', maxTokens: 2048 }],
    })))
    const { mutate } = await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog', { name: `openai ${en.models}` })
    const first = within(dialog).getByRole('checkbox', { name: 'a' }) as HTMLInputElement
    fireEvent.click(first)
    fireEvent.click(first)
    fireEvent.click(first)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'b' }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.fetchAdopt }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    // 候选模型提供了输出上限时一并导入，未提供时不凭空补值。
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      piAiModel({ id: 'a' }), piAiModel({ id: 'b', maxTokens: 2048 }),
    ])
  })

  it('selects and clears every discovered candidate in one action', async () => {
    const discover = vi.fn(() => Promise.resolve(ok({
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })))
    await mountSection({ discover })
    openEditor('openai')

    fireEvent.click(screen.getByText(en.fetchModels))
    const dialog = await screen.findByRole('dialog')
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(box => box.checked)).toEqual([false, false, false])

    fireEvent.click(within_(dialog, en.fetchSelectAll))
    expect(boxes.map(box => box.checked)).toEqual([true, true, true])
    expect(within_(dialog, en.fetchDeselectAll)).toBeTruthy()

    fireEvent.click(within_(dialog, en.fetchDeselectAll))
    expect(boxes.map(box => box.checked)).toEqual([false, false, false])
    expect(within_(dialog, en.fetchSelectAll)).toBeTruthy()
  })
})

describe('channel directory and detail', () => {
  it('keeps dormant catalog routes in Add while the rail shows the configured default', async () => {
    await mountSection({ directory: ['openai', 'anthropic'] })
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).getByRole('button', { name: 'openai' }).getAttribute('aria-current')).toBe('true')
    expect(within(rail).queryByRole('button', { name: 'anthropic' })).toBeNull()
    const detail = screen.getByRole('main')
    expect(within(detail).getByRole('heading', { name: 'openai' })).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: en.add }))
    const choice = within(detail).getByRole('combobox', { name: en.provider }) as HTMLSelectElement
    expect(choice.value).toBe('anthropic')
    expect(within(detail).getByLabelText(en.keyInput)).toBeTruthy()
    expect(within(detail).getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(within(detail).getByRole('region', { name: en.models })).toBeTruthy()
  })

  it('shows configured channels in the rail and switches the persistent detail', async () => {
    await mountSection({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
        'acme-gateway': { apiKeyEnv: 'ACME_GATEWAY_API_KEY', baseURL: 'https://acme.test/v1' },
      },
      declaredRoutes: ['acme-gateway'],
    })

    const rail = screen.getByRole('complementary', { name: en.provider })
    const search = within(rail).getByRole('textbox', { name: en.searchProviders })
    expect(within(rail).getByRole('button', { name: 'openai' }).getAttribute('aria-current')).toBe('true')
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: 'openai' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'ACME' } })
    expect(within(rail).queryByRole('button', { name: 'openai' })).toBeNull()
    openEditor('acme-gateway')
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toHaveProperty('value', 'https://acme.test/v1')
    expect(screen.getByRole('textbox', { name: en.customDisplayName })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.customApi })).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    openEditor('openai')
    expect(screen.queryByRole('textbox', { name: en.customDisplayName })).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.customApi })).toBeNull()
  })

  it('does not claim a hand-declared identity when the adapter reports no distinction', async () => {
    const scripted = scriptedFace({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    scripted.face.llm.providers = vi.fn(() => Promise.resolve(ok({
      providers: [{
        provider: 'openai',
        displayName: 'openai',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        active: true,
      }],
    }))) as never
    const controller = new ModelsSettingsStore(
      scripted.face as unknown as WireFace, settingsSchema, new SettingsDescribeMirror(scripted.face as never))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={scripted.face as never}
      schema={settingsSchema}
      t={t}
    />)

    openEditor('openai')
    expect(screen.queryByRole('textbox', { name: en.customDisplayName })).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.customApi })).toBeNull()
  })
})

describe('hand-declared providers', () => {
  function mountCard(
    overrides: Partial<Parameters<typeof CustomProviderCard>[0]> = {},
    wire: Parameters<typeof scriptedFace>[0] = {},
  ) {
    const scripted = scriptedFace(wire)
    const onClose = vi.fn()
    render(
      <CustomProviderCard
        taken={['openai']}
        protocols={PROTOCOLS}
        revision={7}
        api={scripted.face as never}
        t={t}
        readOnly={false}
        onClose={onClose}
        {...overrides}
      />,
    )
    return { ...scripted, onClose }
  }

  it('writes the whole profile and the key under the derived reference', async () => {
    const { mutate, set, onClose } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'Acme Gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '65536' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [piAiModel({ id: 'acme-large', contextWindow: 65_536 })],
        },
      }],
      // 草稿基于 revision 7；另一标签页同时声明路由时须报冲突而非覆写。
      expectedRevision: 7,
    })
    expect(set).toHaveBeenCalledWith({ ref: 'ACME_GATEWAY_API_KEY', value: 'gw-key' })
  })

  it('scopes each card to fields a provider can actually own', async () => {
    // 推理档位属于模型能力。同一渠道的模型可能支持不同档位，所以不提供渠道级覆盖。
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    expect(screen.getByRole('textbox', { name: en.customRoute })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.customDisplayName })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.customApi })).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    cleanup()

    // 内置路由由目录模型定义协议，详情不暴露渠道级协议覆盖。
    await mountSection({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    openEditor('openai')
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en.customDisplayName })).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.customApi })).toBeNull()
    cleanup()

    // 手工声明路由创建时选择协议，详情仍可编辑该字段。
    await mountSection({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.customDisplayName })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.customApi })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en.customRoute })).toBeNull()
  })

  it('renames a declared route and falls back to its id when the name is cleared', async () => {
    const { mutate } = await mountSection({
      providers: {
        'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.test/v1' },
      },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const name = screen.getByLabelText<HTMLInputElement>(en.customDisplayName)
    expect(name.value).toBe('Acme Gateway')
    // The route id, not the stored name: it is what the route will be called
    // the moment the field is cleared.
    expect(name.placeholder).toBe('acme-gateway')
    fireEvent.change(name, { target: { value: 'Acme 网关' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops)
      .toEqual([{ op: 'set', path: ['providers', 'acme-gateway', 'displayName'], value: 'Acme 网关' }])
  })

  it('offers the composition name as what a cleared field falls back to', async () => {
    // A `cordis.yml` can pin a route the catalog does not ship, so a declared
    // route's profile is not always the page's own. The field edits the user
    // layer alone, and clearing it restores the layer beneath — the
    // composition name here, not the route id — so that is what it offers.
    await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme (pinned)', api: 'openai-completions' } },
      baseProviders: { 'acme-gateway': { displayName: 'Acme (pinned)', api: 'openai-completions' } },
      userProviders: {},
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const name = screen.getByLabelText<HTMLInputElement>(en.customDisplayName)
    expect(name.value).toBe('')
    expect(name.placeholder).toBe('Acme (pinned)')
  })

  it('names the provider as the refreshed directory reports it after a rename', async () => {
    // The status line used to echo the target captured when the card opened,
    // which never lied while the name could not change. It can now.
    const { face } = await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions' } },
      declaredRoutes: ['acme-gateway'],
    })
    // The reload after the write answers with the renamed route, exactly as
    // the adapter re-registers it.
    face.llm.providers = vi.fn(() => Promise.resolve(ok({
      providers: [{
        provider: 'acme-gateway',
        displayName: 'Acme 网关',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'acme-gateway'],
        active: true,
        declared: true,
      }],
    })))
    openEditor('acme-gateway')

    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: 'Acme 网关' } })
    fireEvent.click(screen.getByText(en.apply))

    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe(providerCopy(en.savedProvider, {
      provider: 'acme-gateway',
      displayName: 'Acme 网关',
    }))
  })

  it('drops the stored name rather than storing an empty one the adapter refuses', async () => {
    // `llm-pi-ai` rejects an empty displayName outright, so clearing the field
    // must unset it — which is also what the user means: use the route id.
    const { mutate } = await mountSection({
      providers: { 'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    fireEvent.change(screen.getByLabelText(en.customDisplayName), { target: { value: '   ' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops)
      .toEqual([{ op: 'unset', path: ['providers', 'acme-gateway', 'displayName'] }])
  })

  it('edits the protocol a declared route was created with', async () => {
    const { mutate } = await mountSection({
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: 'acme-large' }],
        },
      },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    const protocol = screen.getByLabelText<HTMLSelectElement>(en.customApi)
    expect(protocol.value).toBe('openai-completions')
    fireEvent.change(protocol, { target: { value: 'anthropic-messages' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the protocol travels: every other stored field is unchanged, so no
    // op restates it.
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'acme-gateway', 'api'], value: 'anthropic-messages' }],
      expectedRevision: 3,
    })
  })

  it('selects nothing for a declared route whose profile names no protocol', async () => {
    // A route hand-written into settings.yaml with no model needs no protocol
    // to resolve, so the card can be opened over one. The select must not read
    // as if that route had picked its first choice.
    await mountSection({
      providers: { 'acme-gateway': { baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')

    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).value).toBe('')
  })

  it('retries only the key after the profile landed, and reports the provider on cancel', async () => {
    const set = vi.fn()
      .mockResolvedValueOnce(fail('credential store is read-only', 'credential-rejected'))
      .mockResolvedValueOnce(ok({}))
    const { mutate, onClose } = mountCard({}, { set })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  gw-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    // The profile landed; only the key failed. The card says so and stays open.
    await waitFor(() => { expect(screen.getByText('credential store is read-only')).toBeTruthy() })
    expect(onClose).not.toHaveBeenCalled()
    expect(mutate).toHaveBeenCalledTimes(1)
    // The key is stored trimmed, matching the editor.
    expect(set).toHaveBeenNthCalledWith(1, { ref: 'ACME_API_KEY', value: 'gw-key' })

    // The provider exists now, so the fields describing it are settled and
    // only the key can still be corrected.
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key-2' } })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    // Re-running the profile write would carry the revision this card's own
    // first write superseded, so the Host would answer settings-conflict and
    // the key could never be stored from here at all.
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenNthCalledWith(2, { ref: 'ACME_API_KEY', value: 'gw-key-2' })
  })

  it('reports the created provider when cancelled after its profile landed', async () => {
    const set = vi.fn().mockResolvedValue(fail('nope', 'credential-rejected'))
    const { onClose } = mountCard({}, { set })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))
    await waitFor(() => { expect(screen.getByText('nope')).toBeTruthy() })

    // Walking away leaves a real provider behind; reporting no change would
    // leave the page without the row it now has.
    fireEvent.click(screen.getByText(en.cancel))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('never contradicts a filled-in field with the next gate\u2019s copy', () => {
    mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    fireEvent.change(routeField, { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })

    // The route field explains itself right under the input; the shared line
    // must stay silent rather than falling through to "no models yet" while
    // the list above plainly has one.
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()

    // Fixing the route hands the line back to the gate that is actually unmet.
    fireEvent.change(routeField, { target: { value: 'acme' } })
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(buttonNamed(en.create).disabled).toBe(false)
  })

  it('refuses a route id whose derived credential reference would be illegal', () => {
    mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    fireEvent.change(routeField, { target: { value: 'https://acme.test/v1' } })

    // Without this check a digit-leading id passes the card and fails at the
    // credential seam with a raw regular expression: the
    // reference derives as `123_API_KEY`, and a credential reference is a
    // POSIX shell identifier, which cannot start with a digit.
    fireEvent.change(routeField, { target: { value: '123' } })
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)

    fireEvent.change(routeField, { target: { value: 'a1' } })
    expect(screen.queryByText(en.customRouteInvalid)).toBeNull()
  })

  it('styles a rejected route id as a fault and its guidance as a hint', () => {
    mountCard()
    const routeField = screen.getByLabelText(en.customRoute)
    // Same split the key field makes: what the user got wrong reads as a
    // fault, what they have yet to do reads as guidance.
    expect(screen.getByText(en.customRouteHint).className).toMatch(/advancedHint/)

    fireEvent.change(routeField, { target: { value: '2' } })
    expect(screen.getByText(en.customRouteInvalid).className).toMatch(/error/)

    fireEvent.change(routeField, { target: { value: 'openai' } })
    expect(screen.getByText(en.customRouteTaken).className).toMatch(/error/)
  })

  it('derives a reference the credential seam accepts for every id it admits', () => {
    // The two rules have to stay in step; this is the relation, checked
    // directly rather than through the DOM.
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const id of ['a', 'ds', 'a1', 'acme-gateway', 'x-1-y', 'zz9']) {
      expect(CREDENTIAL_REF.test(deriveKeyRef(id))).toBe(true)
    }
  })

  it('names the blocked gate under the form, and nothing once it is satisfied', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })

    // Endpoint first: the gate names the one thing standing in the way.
    expect(screen.getByText(en.customNeedsBaseUrl)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()

    // Satisfied: the shared line disappears rather than rendering empty.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(buttonNamed(en.create).disabled).toBe(false)
  })

  it('refuses to create while a capacity is unreadable', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '64 KiB' } })

    expect(screen.getByText(`${en.model} 1: ${en.modelContextInvalid}`)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)
  })

  it('keeps each half-typed capacity with its own row across a removal', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    for (const [at, id] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
      fireEvent.click(screen.getByRole('button', { name: en.addModel }))
      fireEvent.change(screen.getByLabelText(`${en.modelId} ${String(at)}`), { target: { value: id } })
      expandModel(at)
      // Deliberately mid-word: the buffer exists so text like this survives.
      fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} ${String(at)}`),
        { target: { value: `${String(at)}.` } })
    }

    // Removing the middle row: the one before keeps its position and text, the
    // one after moves down carrying its own, and the removed row's text goes.
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('first')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelContextWindow} 1`).value).toBe('1.')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('third')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelContextWindow} 2`).value).toBe('3.')
  })

  it('refuses two models sharing one id', () => {
    mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'same' } })
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'same' } })

    // The adapter refuses a duplicate outright, so the form must not offer to
    // write one.
    expect(screen.getByText(`${en.model} 2: ${en.modelIdDuplicate}`)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'other' } })
    expect(buttonNamed(en.create).disabled).toBe(false)
  })

  it('creates a model with no capacities, which the route\u2019s fallbacks size', async () => {
    const { mutate, onClose } = mountCard()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'bare' } })

    // A listing that discloses nothing but ids is enough to create a working
    // provider; the adapter sizes what configuration leaves out.
    expect(buttonNamed(en.create).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ models: [{ id: 'bare' }] })
  })

  it('refuses to create until the route, endpoint, and a model are usable', () => {
    mountCard()
    expect(buttonNamed(en.create).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'Acme Gateway' } })
    expect(screen.getByText(en.customRouteInvalid)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'openai' } })
    expect(screen.getByText(en.customRouteTaken)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    expect(screen.getByText(en.customNeedsBaseUrl)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)

    // A model row with no id is not a model.
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(buttonNamed(en.create).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expect(buttonNamed(en.create).disabled).toBe(false)
  })

  it('surfaces a refused write and a rejected transport without closing', async () => {
    const refused = vi.fn(() => Promise.resolve(fail('read-only settings', 'settings-rejected')))
    const { onClose } = mountCard({ api: { ...scriptedFace({ mutate: refused }).face } as never })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText('read-only settings')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('surfaces a rejected transport during create', async () => {
    const rejecting = vi.fn(() => Promise.reject(new Error('carrier down')))
    const { onClose } = mountCard({ api: { ...scriptedFace({ mutate: rejecting }).face } as never })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText('carrier down')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports a stored profile whose key write was refused', async () => {
    const set = vi.fn(() => Promise.resolve(fail('credential is read-only', 'credential-rejected')))
    const { onClose } = mountCard({ api: { ...scriptedFace({ set }).face } as never })

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'k' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await screen.findByText('credential is read-only')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('creates with the chosen protocol and no display name', async () => {
    const { mutate, onClose } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'anthropic-messages' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    // No display name configured means none stored; the route id is the name.
    // No key typed means no reference either, matching the editor: the route
    // keeps its provider-native auth path instead of resolving a reference
    // nothing ever sets. The with-key case is covered above.
    expect(firstMutate(mutate).ops[0]?.value).toEqual({
      api: 'anthropic-messages',
      baseURL: 'https://acme.test/v1',
      models: [piAiModel({ id: 'm' })],
    })
  })

  it('offers no protocol when the namespace declares none', () => {
    mountCard({ protocols: [] })
    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).value).toBe('')
  })

  it('closes without writing on cancel, and honors a read-only deployment', () => {
    const { onClose, mutate } = mountCard()
    fireEvent.click(screen.getByText(en.cancel))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(mutate).not.toHaveBeenCalled()
    cleanup()

    mountCard({ readOnly: true })
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).disabled).toBe(true)
    expect(buttonNamed(en.create).disabled).toBe(true)
  })

  it('closes the create card when an existing row is opened for editing', async () => {
    await mountSection({ providers: { openai: { baseURL: 'https://proxy.example/v1' } } })

    fireEvent.click(screen.getByRole('button', { name: en.customAdd }))
    expect(screen.getByText(en.customTitle)).toBeTruthy()

    // Two cards at once would each be closable by the other: whichever one is
    // dismissed clears the shared state and discards the other's draft.
    openEditor('openai')
    expect(screen.queryByText(en.customTitle)).toBeNull()
  })

  it('reaches the card from the section and returns to the button on cancel', async () => {
    await mountSection()

    fireEvent.click(screen.getByRole('button', { name: en.customAdd }))
    expect(screen.getByText(en.customTitle)).toBeTruthy()

    fireEvent.click(screen.getByText(en.cancel))
    await waitFor(() => { expect(screen.queryByText(en.customTitle)).toBeNull() })
    expect(screen.getByRole('button', { name: en.customAdd })).toBeTruthy()
  })

  it('opens the custom-provider form from the models rail', async () => {
    await mountSection()
    expect(screen.queryByRole('button', { name: en.visionFallback })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.customAdd }))
    expect(screen.getByText(en.customTitle)).toBeTruthy()
  })

  it('refuses an unusable key on the field and blocks creation', () => {
    const { mutate, set } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    // A hand-declared route reaches the same judgement as an edited one, so a
    // key that no header can carry never becomes a profile plus a bad secret.
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('stays silent about the other gates when only the key is refused', () => {
    mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    // Route, endpoint, and models are all satisfied, so answering with the
    // next unmet gate would print a second, false fault beside the real one.
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
  })

  it('tells a whitespace-only key what a blank field means on a create card', () => {
    const { mutate } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })

    // There is no stored key to keep here, so the blank case says the thing
    // that is true of a route being declared: it may authenticate elsewhere.
    expect(screen.getByText(en.keyBlankNew)).toBeTruthy()
    expect(screen.queryByText(en.keyBlank)).toBeNull()
    expect(buttonNamed(en.fetchModels).title).toBe(en.keyBlankNew)
    expect(buttonNamed(en.create).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('creates without a key when the route authenticates some other way', async () => {
    const { set, onClose } = mountCard()

    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'ambient-gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.acme.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'acme-large' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('API key field', () => {
  it('stores a replacement secret through credentials without echoing it into settings', async () => {
    const { mutate, set } = await mountSection()
    openEditor('openai')
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.type).toBe('password')
    expect(key.value).toBe('')
    fireEvent.change(key, { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))

    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'OPENAI_API_KEY', value: 'new-secret' }) })
    expect(mutate).not.toHaveBeenCalled()
    expect(screen.queryByText('new-secret')).toBeNull()
  })

  it('reports a revision conflict and does not store a key for the rejected settings edit', async () => {
    const mutate = vi.fn(() => Promise.resolve(fail('stale revision', 'settings-conflict')))
    const { set } = await mountSection({ mutate })
    openEditor('openai')
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://changed.example/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))

    await screen.findByText(en.conflict)
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai', expectedRevision: 3,
      ops: [{ op: 'set', path: ['providers', 'openai', 'baseURL'], value: 'https://changed.example/v1' }],
    })
    expect(set).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toHaveProperty('value', 'https://changed.example/v1')
  })

  it('submits with a blank key field without writing a credential', async () => {
    const { mutate, set } = await mountSection()
    openEditor('openai')

    // The field opens empty even for a provider whose key is stored, where it
    // means "keep that one" — so editing anything else must not require it.
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://moved.example/v1' } })
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(set).not.toHaveBeenCalled()
  })

  it('clears a whitespace-only base URL instead of writing the spaces', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    // The field renders this as empty, so the draft must agree: storing the
    // spaces would hand both adapters a non-empty string they accept as a URL.
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: '   ' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
    const ops = firstMutate(mutate).ops
    expect(ops.some(op => op.op === 'set' && op.path.includes('baseURL'))).toBe(false)
    expect(ops.some(op => op.op === 'unset' && op.path.includes('baseURL'))).toBe(true)
  })

  it('blocks submit and names the field when the key holds only whitespace', async () => {
    const { mutate, set } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '   ' } })

    expect(screen.getByText(en.keyBlank)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('blocks submit when the key contains characters no header can carry', async () => {
    const { set } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('blocks submit when a whole NAME=value line was pasted', async () => {
    await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'OPENAI_API_KEY=sk-abc' } })

    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
  })

  it('trims a padded key before storing it', async () => {
    const { set } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  sk-abc  ' } })
    expect(buttonNamed(en.apply).disabled).toBe(false)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(set).toHaveBeenCalled() })
    expect((set.mock.calls[0]?.[0] as { value: string }).value).toBe('sk-abc')
  })

  it('blocks the interrogation too, rather than spending a round trip on a refused key', async () => {
    const { discover } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })

    // The host would refuse this before building the header anyway; asking is
    // a round trip to be told what the field already says.
    expect(buttonNamed(en.fetchModels).disabled).toBe(true)
    expect(buttonNamed(en.fetchModels).title).toBe(en.keyIllegalCharacters)
    expect(discover).not.toHaveBeenCalled()
  })

  it('carries the trimmed key into an interrogation, not the padded draft', async () => {
    const { discover } = await mountSection()
    openEditor('openai')

    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  sk-abc  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))

    await waitFor(() => { expect(discover).toHaveBeenCalled() })
    expect(firstProbe(discover)).toMatchObject({ apiKey: 'sk-abc' })
  })

  it('reloads the section after creating a hand-declared provider', async () => {
    const { controller, mutate } = await mountSection()
    const load = vi.spyOn(controller, 'load')

    fireEvent.click(screen.getByRole('button', { name: en.customAdd }))
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(screen.queryByText(en.customTitle)).toBeNull()
  })
})
