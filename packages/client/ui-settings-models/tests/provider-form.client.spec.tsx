// @vitest-environment jsdom
/** 模型目录编辑、端点发现，以及手工声明渠道的交互契约。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const UUID = '11111111-1111-4111-8111-111111111111'
const GENERATED_ROUTE = `channel-${UUID}`

let randomUuid = vi.fn<() => ReturnType<Crypto['randomUUID']>>(() => UUID)
beforeEach(() => {
  randomUuid = vi.fn<() => ReturnType<Crypto['randomUUID']>>(() => UUID)
  vi.spyOn(crypto, 'randomUUID').mockImplementation(randomUuid)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

/** 让模拟目录在自定义 profile 写入后按新设置联接该渠道。 */
async function mountSectionWithCreatedRoute(set?: ReturnType<typeof vi.fn>) {
  let providers: Record<string, unknown> = { openai: { baseURL: 'https://proxy.example/v1' } }
  const directory = ['openai']
  const mutate = vi.fn((request: MutateCall) => {
    const operation = request.ops[0]
    const route = operation?.path[1]
    if (operation?.op !== 'set' || operation.path[0] !== 'providers' || route === undefined) {
      throw new Error('expected a new provider profile')
    }
    providers = { ...providers, [route]: operation.value }
    directory.push(route)
    return Promise.resolve(ok(piAiNamespace(providers)))
  })
  const mounted = await mountSection({ providers, directory, declaredRoutes: [GENERATED_ROUTE], mutate,
    ...set === undefined ? {} : { set } })
  mounted.face.llm.providers = vi.fn(() => Promise.resolve(ok({
    providers: directory.map(provider => ({
      provider,
      displayName: (providers[provider] as { displayName?: string }).displayName ?? provider,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', provider],
      active: true,
      declared: provider === GENERATED_ROUTE,
    })),
  })))
  return mounted
}

/** 渠道目录选中后，详情始终展示凭据、端点和模型目录。 */
function openEditor(provider: string): void {
  const rail = screen.getByRole('complementary', { name: en.provider })
  fireEvent.click(within(rail).getByRole('button', { name: provider }))
  expect(within(screen.getByRole('main')).getByRole('heading', { level: 2, name: provider })).toBeTruthy()
}

/** 添加渠道直接打开居中的自定义渠道表单，右侧保留原详情。 */
function openCustomModal(): HTMLElement {
  const rail = screen.getByRole('complementary', { name: en.provider })
  fireEvent.click(within(rail).getByRole('button', { name: en.add }))
  const dialog = screen.getByRole('dialog', { name: en.add })
  expect(within(dialog).getByLabelText(en.channelName)).toBeTruthy()
  return dialog
}

/** 填写第一步草稿；此 helper 不切换步骤或发起写入。 */
function fillCustomChannel(
  name = 'Acme Gateway', baseURL = 'https://acme.test/v1', key = '',
): void {
  const form = within(screen.queryByRole('dialog', { name: en.add }) ?? document.body)
  fireEvent.change(form.getByLabelText(en.channelName), { target: { value: name } })
  fireEvent.change(form.getByLabelText(en.baseUrl), { target: { value: baseURL } })
  fireEvent.change(form.getByLabelText(en.keyInput), { target: { value: key } })
}

/** 通过下一步按钮切换到模型草稿，不替代被测字段校验。 */
function nextCustomStep(): void {
  const next = buttonNamed(en.customNext)
  expect(next.disabled).toBe(false)
  fireEvent.click(next)
}

/** 新建模型行仍只编辑本地草稿。 */
function addCustomModel(id = 'm', index = 1): void {
  const form = within(screen.queryByRole('dialog', { name: en.add }) ?? document.body)
  fireEvent.click(form.getByRole('button', { name: en.addModel }))
  fireEvent.change(form.getByLabelText(`${en.modelId} ${String(index)}`), { target: { value: id } })
}

/** 打开指定模型行的设置浮层。 */
function expandModel(index: number): void {
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} ${index}` }))
}

/** 浮层保存只提交到提供方草稿，持久化仍由提供方表单负责。 */
function saveModel(index: number): void {
  const dialog = screen.getByRole('dialog', { name: `${en.modelAdvanced} ${index}` })
  fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
  expect(screen.queryByRole('dialog', { name: `${en.modelAdvanced} ${index}` })).toBeNull()
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
    // 清空可选名称时不得存入空字符串。
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: '' } })
    expect(mutate).not.toHaveBeenCalled()
    saveModel(1)
    expect(mutate).not.toHaveBeenCalled()
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

    saveModel(1)
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
    const card = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    expect(main.contains(card)).toBe(false)
    const vision = within(card).getByRole('button', { name: en.visionSupport })
    const reasoning = within(card).getByRole('button', { name: en.reasoningSupport })
    expect(vision.getAttribute('aria-pressed')).toBe('true')
    expect(reasoning.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(vision)
    expect(vision.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(card).getByRole('button', { name: /Reasoning levels:/ }))
    const high = screen.getByRole('menuitemcheckbox', { name: 'high' })
    expect(high.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(high)
    expect(high.getAttribute('aria-checked')).toBe('false')
    expect(mutate).not.toHaveBeenCalled()
    saveModel(1)
    fireEvent.click(within(main).getByRole('button', { name: en.apply }))

    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'set', path: ['providers', 'openai', 'models'], value: [
      { id: 'first', customField: 'kept', input: ['text'], reasoningEfforts: { off: null, low: 'low', max: 'max' } },
      piAiModel({ id: 'second' }),
    ] }])
  })

  it('cancels a model popup without changing the provider draft', async () => {
    const { mutate } = await mountSection({ providers: { openai: {
      baseURL: 'https://proxy.example/v1',
      models: [piAiModel({ id: 'kept', contextWindow: 65_536, customField: 'kept' })],
    } } })
    openEditor('openai')
    expandModel(1)
    const dialog = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    fireEvent.click(within(dialog).getByRole('button', { name: en.visionSupport }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: `${en.modelContextWindow} 1` }),
      { target: { value: '1M' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))

    expandModel(1)
    const reopened = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    expect(within(reopened).getByRole('button', { name: en.visionSupport }).getAttribute('aria-pressed')).toBe('true')
    expect(within(reopened).getByRole<HTMLInputElement>('textbox', { name: `${en.modelContextWindow} 1` }).value)
      .toBe('65536')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses to save an unreadable capacity into the provider draft', async () => {
    const { mutate } = await mountSection()
    openEditor('openai')

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelMaxTokens} 1`), { target: { value: 'abc' } })

    // 无效输入必须留在浮层并阻断本行保存，不能悄悄丢弃后持久化。
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelMaxTokens} 1`).value).toBe('abc')
    const dialog = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    expect(within(dialog).getByRole('alert').textContent).toBe(en.modelMaxTokensInvalid)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
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
    // 清空容量时丢弃字段，不存入零。
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 2`), { target: { value: '' } })
    saveModel(2)
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

  it('interrogates the latest unpersisted channel information after returning from the model step', async () => {
    const scripted = scriptedFace({
      discover: vi.fn(() => Promise.resolve(ok({ models: [{ id: 'candidate' }] }))),
    })
    render(
      <CustomProviderCard
        taken={[]} protocols={PROTOCOLS} revision={7} api={scripted.face as never}
        t={t} readOnly={false} onClose={vi.fn()}
      />,
    )
    fillCustomChannel()
    nextCustomStep()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
    fireEvent.click(screen.getByRole('button', { name: en.customBack }))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://edited.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  typed-key  ' } })
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'openai-responses' } })
    nextCustomStep()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await waitFor(() => { expect(scripted.discover).toHaveBeenCalledTimes(2) })
    expect(scripted.discover).toHaveBeenLastCalledWith({
      settingsNs: 'llm-pi-ai', baseURL: 'https://edited.test/v1',
      api: 'openai-responses', apiKey: 'typed-key',
    })
    expect(scripted.mutate).not.toHaveBeenCalled()
    expect(scripted.set).not.toHaveBeenCalled()
    expect(randomUuid).toHaveBeenCalledOnce()
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
  it('keeps dormant catalog routes out of Add while the configured detail remains visible', async () => {
    await mountSection({ directory: ['openai', 'anthropic'] })
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).getByRole('button', { name: 'openai' }).getAttribute('aria-current')).toBe('true')
    expect(within(rail).queryByRole('button', { name: 'anthropic' })).toBeNull()
    const detail = screen.getByRole('main')
    expect(within(detail).getByRole('heading', { name: 'openai' })).toBeTruthy()
    const dialog = openCustomModal()
    expect(within(detail).getByRole('heading', { name: 'openai' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'anthropic' })).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: en.provider })).toBeNull()
    expect(within(dialog).queryByRole('textbox', { name: en.searchProviders })).toBeNull()
    expect(within(dialog).getByLabelText(en.keyInput)).toBeTruthy()
    expect(within(dialog).getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(within(dialog).queryByRole('region', { name: en.models })).toBeNull()
    fillCustomChannel()
    nextCustomStep()
    expect(within(dialog).getByRole('region', { name: en.models })).toBeTruthy()
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
    const view = render(
      <CustomProviderCard
        taken={['openai']} protocols={PROTOCOLS} revision={7}
        api={scripted.face as never} t={t} readOnly={false} onClose={onClose}
        {...overrides}
      />,
    )
    return { ...scripted, onClose, view }
  }

  it('associates all visible channel labels with native controls and hides the generated ID', () => {
    mountCard()
    for (const label of [en.channelName, en.baseUrl, en.customApi, en.keyInput]) {
      const field = screen.getByLabelText(label)
      const visibleLabel = screen.getByText<HTMLLabelElement>(label, { selector: 'label' })
      expect(visibleLabel.control).toBe(field)
      expect(field.id).toBe(visibleLabel.htmlFor)
    }
    expect(screen.queryByRole('textbox', { name: 'Provider ID' })).toBeNull()
    expect(screen.queryByDisplayValue(GENERATED_ROUTE)).toBeNull()
    expect(screen.queryByText(GENERATED_ROUTE)).toBeNull()
    expect(screen.queryByRole('button', { name: en.addModel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.create })).toBeNull()
  })

  it('requires meaningful channel information before Next or the model tab can advance', () => {
    const { mutate, set } = mountCard()
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: en.customModelsStep }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.channelName), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.channelName), { target: { value: 'x'.repeat(65) } })
    expect(screen.getByText(en.channelNameInvalid)).toBeTruthy()
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.channelName), { target: { value: 'Acme Gateway' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: '   ' } })
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://acme.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: '' } })
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'openai-completions' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-\u{1F600}' } })
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '' } })
    nextCustomStep()
    expect(screen.getByRole('tab', { name: en.customModelsStep }).getAttribute('aria-selected')).toBe('true')
    expect(buttonNamed(en.create).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('uses accessible keyboard tabs and keeps both steps as an unpersisted draft', () => {
    const { mutate, set } = mountCard()
    const information = screen.getByRole('tab', { name: en.customChannelInfo })
    const models = screen.getByRole('tab', { name: en.customModelsStep })
    information.focus()
    fireEvent.keyDown(information, { key: 'ArrowRight' })
    expect(information.getAttribute('aria-selected')).toBe('true')
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'anthropic-messages' } })
    fireEvent.keyDown(information, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(models)
    expect(models.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(models, { key: 'x' })
    expect(document.activeElement).toBe(models)
    expect(models.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(information, { key: 'End' })
    expect(document.activeElement).toBe(models)
    expect(models.getAttribute('aria-selected')).toBe('true')
    expect(information.getAttribute('tabindex')).toBe('-1')
    expect(models.getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(models.id)
    expect(screen.getByRole('tabpanel').id).toBe(models.getAttribute('aria-controls'))
    expect(screen.queryByLabelText(en.channelName)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl)).toBeNull()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.queryByLabelText(en.customApi)).toBeNull()
    addCustomModel('m')
    fireEvent.keyDown(models, { key: 'Home' })
    expect(document.activeElement).toBe(information)
    expect(information.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText(en.channelName)).toHaveProperty('value', 'Acme Gateway')
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('value', 'https://acme.test/v1')
    expect(screen.getByLabelText(en.keyInput)).toHaveProperty('value', 'gw-key')
    expect(screen.getByLabelText(en.customApi)).toHaveProperty('value', 'anthropic-messages')
    nextCustomStep()
    expect(screen.getByLabelText(`${en.modelId} 1`)).toHaveProperty('value', 'm')
    fireEvent.click(screen.getByRole('button', { name: en.customBack }))
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('value', 'https://acme.test/v1')
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('writes one full profile at the stable generated route with the opening revision and derived key', async () => {
    const { mutate, set, onClose, discover } = mountCard({}, {
      discover: vi.fn(() => Promise.resolve(ok({ models: [{ id: 'candidate' }] }))),
    })
    fillCustomChannel('  Acme Gateway  ', 'https://gateway.acme.example/v1', '  gw-key  ')
    nextCustomStep()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await waitFor(() => { expect(discover).toHaveBeenCalledOnce() })
    expect(firstProbe(discover)).toEqual({
      settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.acme.example/v1',
      api: 'openai-completions', apiKey: 'gw-key',
    })
    const picker = await screen.findByRole('dialog')
    fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
    addCustomModel('acme-large')
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '65536' } })
    saveModel(1)
    fireEvent.click(screen.getByRole('button', { name: en.customBack }))
    fireEvent.change(screen.getByLabelText(en.channelName), { target: { value: '  Renamed Gateway  ' } })
    nextCustomStep()
    expect(randomUuid).toHaveBeenCalledOnce()
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-pi-ai', expectedRevision: 7,
      ops: [{
        op: 'set', path: ['providers', GENERATED_ROUTE], value: {
          displayName: 'Renamed Gateway', apiKeyEnv: deriveKeyRef(GENERATED_ROUTE),
          api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1',
          models: [piAiModel({ id: 'acme-large', contextWindow: 65_536 })],
        },
      }],
    })
    expect(GENERATED_ROUTE).toMatch(/^channel-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(deriveKeyRef(GENERATED_ROUTE)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    expect(set).toHaveBeenCalledWith({ ref: deriveKeyRef(GENERATED_ROUTE), value: 'gw-key' })
  })

  it('skips taken generated IDs without exposing an ID editing control', async () => {
    const secondUuid = '22222222-2222-4222-8222-222222222222'
    randomUuid.mockReturnValueOnce(UUID).mockReturnValueOnce(secondUuid)
    const { mutate, onClose } = mountCard({ taken: [GENERATED_ROUTE] })
    fillCustomChannel()
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    const route = `channel-${secondUuid}`
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true, route) })
    expect(firstMutate(mutate).ops[0]?.path).toEqual(['providers', route])
    expect(randomUuid).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('textbox', { name: 'Provider ID' })).toBeNull()
  })

  it('blocks a generated route occupied after opening without replacing its ID or revision', async () => {
    const { face, mutate, set, onClose, view } = mountCard()
    fillCustomChannel()
    nextCustomStep()
    addCustomModel()
    const rerenderTaken = (taken: readonly string[]): void => {
      view.rerender(<CustomProviderCard taken={taken} protocols={PROTOCOLS} revision={8}
        api={face as never} t={t} readOnly={false} onClose={onClose} />)
    }
    rerenderTaken(['openai', GENERATED_ROUTE])
    expect(buttonNamed(en.create).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.customBack }))
    expect(screen.getByRole('alert').textContent).toBe(en.customRouteTaken)
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    expect(screen.getByLabelText(en.channelName)).toHaveProperty('value', 'Acme Gateway')
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(randomUuid).toHaveBeenCalledOnce()

    rerenderTaken(['openai'])
    expect(screen.queryByText(en.customRouteTaken)).toBeNull()
    nextCustomStep()
    expect(screen.getByLabelText(`${en.modelId} 1`)).toHaveProperty('value', 'm')
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE) })
    expect(firstMutate(mutate)).toMatchObject({ expectedRevision: 7,
      ops: [{ op: 'set', path: ['providers', GENERATED_ROUTE] }] })
    expect(randomUuid).toHaveBeenCalledOnce()
  })

  it('coalesces final confirmation clicks before the pending write disables the button', async () => {
    let finishWrite!: (response: RpcResponse<SettingsNamespaceView>) => void
    const mutate = vi.fn(() => new Promise<RpcResponse<SettingsNamespaceView>>((resolve) => { finishWrite = resolve }))
    const onBusyChange = vi.fn()
    const { set, onClose, namespace } = mountCard({ onBusyChange }, { mutate })
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    nextCustomStep()
    addCustomModel()
    const create = buttonNamed(en.create)
    // 原生点击共用一次 React 批次，第二次确认不能依赖下一次渲染的 disabled。
    act(() => {
      create.click()
      create.click()
    })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(onBusyChange).toHaveBeenCalledTimes(1)
    expect(onBusyChange).toHaveBeenCalledWith(true)
    expect(buttonNamed(en.creating).disabled).toBe(true)

    await act(async () => { finishWrite(ok(namespace)) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledWith({ ref: deriveKeyRef(GENERATED_ROUTE), value: 'gw-key' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE)
    expect(onBusyChange).toHaveBeenNthCalledWith(2, false)
  })

  it('checks both live directory routes and persisted profiles omitted from the rail', async () => {
    const persistedUuid = '22222222-2222-4222-8222-222222222222'
    const freeUuid = '33333333-3333-4333-8333-333333333333'
    randomUuid
      .mockReturnValueOnce(UUID).mockReturnValueOnce(persistedUuid).mockReturnValueOnce(freeUuid)
    const { mutate } = await mountSection({
      directory: [GENERATED_ROUTE],
      providers: { [`channel-${persistedUuid}`]: { baseURL: 'https://persisted.test/v1' } },
    })
    const dialog = openCustomModal()
    fillCustomChannel()
    nextCustomStep()
    addCustomModel()
    fireEvent.click(within(dialog).getByRole('button', { name: en.create }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops[0]?.path).toEqual(['providers', `channel-${freeUuid}`])
    expect(randomUuid).toHaveBeenCalledTimes(3)
  })

  it('generates distinct IDs for separate drafts and never persists a cancelled draft', async () => {
    const secondUuid = '22222222-2222-4222-8222-222222222222'
    randomUuid.mockReturnValueOnce(UUID).mockReturnValueOnce(secondUuid)
    const { mutate, set } = await mountSection()
    const first = openCustomModal()
    fillCustomChannel('Cancelled draft')
    nextCustomStep()
    addCustomModel('discarded')
    fireEvent.click(within(first).getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    const second = openCustomModal()
    fillCustomChannel('Second draft')
    nextCustomStep()
    addCustomModel('kept')
    fireEvent.click(within(second).getByRole('button', { name: en.create }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops[0]?.path).toEqual(['providers', `channel-${secondUuid}`])
    expect(firstMutate(mutate).ops[0]?.value).toMatchObject({ models: [{ id: 'kept' }] })
    expect(randomUuid).toHaveBeenCalledTimes(2)
  })

  it('creates separate routes for two completed drafts with the same display name', async () => {
    const secondUuid = '22222222-2222-4222-8222-222222222222'
    randomUuid.mockReturnValueOnce(UUID).mockReturnValueOnce(secondUuid)
    const first = mountCard()
    fillCustomChannel('Same display name')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(first.onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE) })
    cleanup()
    const secondRoute = `channel-${secondUuid}`
    const second = mountCard({ taken: [GENERATED_ROUTE] })
    fillCustomChannel('Same display name')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(second.onClose).toHaveBeenCalledWith(true, secondRoute) })
    expect(firstMutate(first.mutate).ops[0]?.path).toEqual(['providers', GENERATED_ROUTE])
    expect(firstMutate(second.mutate).ops[0]?.path).toEqual(['providers', secondRoute])
    expect(secondRoute).not.toBe(GENERATED_ROUTE)
    expect(randomUuid).toHaveBeenCalledTimes(2)
  })

  it('scopes each card to fields a provider can actually own', async () => {
    mountCard()
    expect(screen.queryByRole('textbox', { name: 'Provider ID' })).toBeNull()
    expect(screen.getByRole('textbox', { name: en.channelName })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.customApi })).toBeTruthy()
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    cleanup()
    await mountSection({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
    openEditor('openai')
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.baseUrl })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en.customDisplayName })).toBeNull()
    expect(screen.queryByRole('combobox', { name: en.customApi })).toBeNull()
    cleanup()
    await mountSection({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1' } },
      declaredRoutes: ['acme-gateway'],
    })
    openEditor('acme-gateway')
    expect(screen.getByRole('textbox', { name: en.customDisplayName })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.customApi })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Provider ID' })).toBeNull()
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

  it('retries only the key after the profile landed and keeps the generated ID stable', async () => {
    const set = vi.fn()
      .mockResolvedValueOnce(fail('credential store is read-only', 'credential-rejected'))
      .mockResolvedValueOnce(ok({}))
    const { mutate, onClose } = mountCard({}, { set })
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', '  gw-key  ')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await screen.findByText('credential store is read-only')
    expect(onClose).not.toHaveBeenCalled()
    expect(mutate).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLInputElement>(en.channelName).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(false)
    expect(set).toHaveBeenNthCalledWith(1, { ref: deriveKeyRef(GENERATED_ROUTE), value: 'gw-key' })
    fireEvent.click(screen.getByRole('tab', { name: en.customModelsStep }))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).disabled).toBe(true)
    expect(buttonNamed(en.addModel).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.customBack }))
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '' } })
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(buttonNamed(en.retry).disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key-2' } })
    expect(screen.queryByRole('button', { name: en.customNext })).toBeNull()
    expect(screen.queryByRole('button', { name: en.create })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE) })
    // 重试已提交 profile 会使用失效 revision，因而只能重试凭据。
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenNthCalledWith(2, { ref: deriveKeyRef(GENERATED_ROUTE), value: 'gw-key-2' })
    expect(randomUuid).toHaveBeenCalledOnce()
  })

  it('reports the created route when cancelled after the profile landed', async () => {
    const set = vi.fn().mockResolvedValue(fail('nope', 'credential-rejected'))
    const { onClose } = mountCard({}, { set })
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await screen.findByText('nope')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE)
  })

  it('retries close after native-auth profile creation without inventing a credential requirement', async () => {
    const onClose = vi.fn()
      .mockRejectedValueOnce(new Error('directory refresh failed'))
      .mockResolvedValueOnce(undefined)
    const { mutate, set } = mountCard({ onClose })
    fillCustomChannel('Native Gateway')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await screen.findByText('directory refresh failed')
    expect(firstMutate(mutate).ops[0]?.value).not.toHaveProperty('apiKeyEnv')
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(true)
    expect(buttonNamed(en.retry).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(2) })
    expect(onClose).toHaveBeenNthCalledWith(1, true, GENERATED_ROUTE)
    expect(onClose).toHaveBeenNthCalledWith(2, true, GENERATED_ROUTE)
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()
    expect(randomUuid).toHaveBeenCalledOnce()
  })

  it('names the missing model gate only on step two and clears it after a valid row', () => {
    const { mutate, set } = mountCard()
    fillCustomChannel()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    nextCustomStep()
    expect(screen.getByText(en.customNeedsModels)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(buttonNamed(en.create).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(buttonNamed(en.create).disabled).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses an unreadable capacity in a new provider model popup', () => {
    mountCard()
    fillCustomChannel()
    nextCustomStep()
    addCustomModel('acme-large')
    expandModel(1)
    fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} 1`), { target: { value: '64 KiB' } })
    const dialog = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    expect(within(dialog).getByRole('alert').textContent).toBe(en.modelContextInvalid)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  })

  it('discards unsaved capacity edits on model changes and removal', () => {
    mountCard()
    fillCustomChannel()
    nextCustomStep()
    for (const [at, id] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
      addCustomModel(id, at)
      expandModel(at)
      fireEvent.change(screen.getByLabelText(`${en.modelContextWindow} ${String(at)}`),
        { target: { value: `${String(at)}.` } })
    }
    fireEvent.click(screen.getByLabelText(`${en.removeModel} 2`))
    expect(screen.getByLabelText(`${en.modelId} 1`)).toHaveProperty('value', 'first')
    expect(screen.queryByLabelText(`${en.modelContextWindow} 1`)).toBeNull()
    expandModel(1)
    expect(screen.getByLabelText(`${en.modelContextWindow} 1`)).toHaveProperty('value', '')
    expect(screen.getByLabelText(`${en.modelId} 2`)).toHaveProperty('value', 'third')
    expandModel(2)
    expect(screen.getByLabelText(`${en.modelContextWindow} 2`)).toHaveProperty('value', '')
  })

  it('refuses duplicate model IDs and accepts a repaired row', () => {
    const { mutate } = mountCard()
    fillCustomChannel()
    nextCustomStep()
    addCustomModel('same')
    addCustomModel('same', 2)
    expect(screen.getByText(`${en.model} 2: ${en.modelIdDuplicate}`)).toBeTruthy()
    expect(buttonNamed(en.create).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.modelId} 2`), { target: { value: 'other' } })
    expect(buttonNamed(en.create).disabled).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('creates without capacities or a key while retaining the chosen protocol and required name', async () => {
    const { mutate, set, onClose } = mountCard()
    fillCustomChannel('  Native Gateway  ')
    fireEvent.change(screen.getByLabelText(en.customApi), { target: { value: 'anthropic-messages' } })
    nextCustomStep()
    addCustomModel('bare')
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true, GENERATED_ROUTE) })
    expect(firstMutate(mutate).ops[0]?.value).toEqual({
      displayName: 'Native Gateway', api: 'anthropic-messages',
      baseURL: 'https://acme.test/v1', models: [piAiModel({ id: 'bare' })],
    })
    expect(set).not.toHaveBeenCalled()
  })

  it.each([
    ['refused write', () => Promise.resolve(fail('read-only settings', 'settings-rejected')), 'read-only settings'],
    ['rejected transport', () => Promise.reject(new Error('carrier down')), 'carrier down'],
  ])('surfaces a %s without closing or storing a key', async (_label, answer, message) => {
    const mutate = vi.fn(answer)
    const { set, onClose } = mountCard({}, { mutate })
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await screen.findByText(message)
    expect(onClose).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps the generated route and opening revision after a conflict without storing the key', async () => {
    const mutate = vi.fn().mockResolvedValue(fail('stale revision', 'settings-conflict'))
    const { set, onClose } = mountCard({}, { mutate })
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await screen.findByText('stale revision')
    expect(set).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en.channelName), { target: { value: 'Corrected Name' } })
    nextCustomStep()
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    for (const [request] of mutate.mock.calls as unknown as [MutateCall][]) {
      expect(request.expectedRevision).toBe(7)
      expect(request.ops[0]?.path).toEqual(['providers', GENERATED_ROUTE])
    }
    expect(randomUuid).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()
  })

  it('offers no protocol when the namespace declares none and cannot advance', () => {
    mountCard({ protocols: [] })
    fillCustomChannel()
    expect(screen.getByLabelText<HTMLSelectElement>(en.customApi).value).toBe('')
    expect(buttonNamed(en.customNext).disabled).toBe(true)
  })

  it('closes without writes on cancel and honors a read-only deployment', () => {
    const { onClose, mutate, set } = mountCard()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    cleanup()
    mountCard({ readOnly: true })
    expect(screen.getByLabelText<HTMLInputElement>(en.channelName).disabled).toBe(true)
    expect(buttonNamed(en.customNext).disabled).toBe(true)
  })

  it('keeps the current right-side detail and returns to Add after cancelling a model draft', async () => {
    await mountSection()
    const rail = screen.getByRole('complementary', { name: en.provider })
    const dialog = openCustomModal()
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'openai' })).toBeTruthy()
    fillCustomChannel()
    nextCustomStep()
    addCustomModel()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
    expect(screen.getByRole('button', { name: en.add })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: 'openai' }).getAttribute('aria-current')).toBe('true')
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'openai' })).toBeTruthy()
    expect(within(rail).queryByRole('button', { name: GENERATED_ROUTE })).toBeNull()
  })

  it('selects the new channel and displays its detail after final creation', async () => {
    const { mutate } = await mountSectionWithCreatedRoute()
    const dialog = openCustomModal()
    fillCustomChannel('Acme Gateway')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(within(dialog).getByRole('button', { name: en.create }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(firstMutate(mutate).ops[0]?.path).toEqual(['providers', GENERATED_ROUTE])
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en.add })).toBeNull() })
    const rail = screen.getByRole('complementary', { name: en.provider })
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Acme Gateway' }).getAttribute('aria-current')).toBe('true')
      expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Acme Gateway' })).toBeTruthy()
    })
  })

  it('selects the created channel when cancelling after its credential write fails', async () => {
    const set = vi.fn(() => Promise.resolve(fail('credential is read-only', 'credential-rejected')))
    const { mutate } = await mountSectionWithCreatedRoute(set)
    const dialog = openCustomModal()
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', 'gw-key')
    nextCustomStep()
    addCustomModel()
    fireEvent.click(within(dialog).getByRole('button', { name: en.create }))
    await within(dialog).findByText('credential is read-only')
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    const rail = screen.getByRole('complementary', { name: en.provider })
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Acme Gateway' }).getAttribute('aria-current')).toBe('true')
      expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Acme Gateway' })).toBeTruthy()
    })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenCalledOnce()
  })

  it('opens channel information directly from the single rail action without a built-in selector', async () => {
    await mountSection({ directory: ['openai', 'cerebras'] })
    expect(screen.queryByRole('button', { name: en.visionFallback })).toBeNull()
    expect(screen.getAllByRole('button', { name: en.add })).toHaveLength(1)
    const dialog = openCustomModal()
    expect(within(dialog).getAllByRole('tab')).toHaveLength(2)
    expect(within(dialog).getByRole('textbox', { name: en.channelName })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'cerebras' })).toBeNull()
    expect(within(dialog).queryByRole('textbox', { name: en.searchProviders })).toBeNull()
  })

  it.each([
    ['sk-\u{1F600}', en.keyIllegalCharacters],
    ['OPENAI_API_KEY=sk-abc', en.keyIllegalCharacters],
    ['   ', en.keyBlankNew],
  ])('blocks a refused key %j before advancing or making any writes', (key, message) => {
    const { mutate, set, discover } = mountCard()
    fillCustomChannel('Acme Gateway', 'https://acme.test/v1', key)
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByText(en.customNeedsModels)).toBeNull()
    expect(screen.queryByText(en.customNeedsBaseUrl)).toBeNull()
    expect(buttonNamed(en.customNext).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
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

    const dialog = openCustomModal()
    fillCustomChannel()
    nextCustomStep()
    fireEvent.click(within(dialog).getByRole('button', { name: en.addModel }))
    fireEvent.change(within(dialog).getByLabelText(`${en.modelId} 1`), { target: { value: 'm' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.create }))

    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('dialog', { name: en.add })).toBeNull()
  })
})
