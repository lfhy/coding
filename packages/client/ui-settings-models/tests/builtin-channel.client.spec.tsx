// @vitest-environment jsdom
/**
 * 内置渠道在模型设置页的契约：它由提供方插件注册，没有设置分节，因此页面
 * 只读展示 Host 当前服务的模型与能力，不出现端点、密钥、名称或目录的编辑入口。
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from 'coding-api-remotes/client'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { SettingsDescribeMirror } from 'coding-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** 内置渠道当前服务的目录，形态与 `llm.models` 的应答一致。 */
const FREE_MODELS = [
  {
    id: 'mimo-v2.6-flash-free', name: 'Mimo V2.6 Flash',
    inputModalities: ['text', 'image'],
  },
  {
    id: 'deepseek-v4.1-flash-free', name: 'Deepseek V4.1 Flash',
    inputModalities: ['text', 'image'],
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
  },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', inputModalities: ['text'] },
]

const piAiSchema = Schema.object({ providers: Schema.dict(Schema.object({
  baseURL: Schema.string(),
  models: Schema.array(Schema.object({ id: Schema.string().required() })),
})) })

/** 一条已配置的 pi-ai 渠道，用来说明内置渠道与用户渠道并存时页面仍然可编辑。 */
function configuredChannel(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(piAiSchema.toJSON())) as unknown,
    value: { providers: { mine: { baseURL: 'https://gateway.example/v1', models: [{ id: 'mine-1', name: 'Mine 1' }] } } },
    user: { providers: { mine: { baseURL: 'https://gateway.example/v1' } } },
    base: {},
    revision: 0,
    applies: 'live',
    secrets: [],
  }
}

interface FixtureOptions {
  /** 目录读取失败的渠道 id 与诊断；给出时不返回该渠道的分组。 */
  failure?: { id: string; name: string; message: string }
}

async function mount(options: FixtureOptions = {}) {
  const namespace = configuredChannel()
  const groups = [{ id: 'free', name: 'Free', models: FREE_MODELS }]
  const api = {
    llm: {
      providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
        { provider: 'mine', displayName: 'My gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mine'], active: true },
        { provider: 'free', displayName: 'Free', settingsNs: '', settingsPath: [], active: true },
      ] } } })),
      models: vi.fn(async () => ({ result: { ok: true, value: {
        groups: options.failure === undefined ? groups : [],
        failures: options.failure === undefined ? [] : [options.failure],
      } } })),
      discoverModels: vi.fn(),
    },
    settings: {
      describe: vi.fn(async () => ({ result: { ok: true, value: {
        writable: true, hasDocument: true, namespaces: [namespace],
      } } })),
      mutate: vi.fn(),
    },
    credentials: { describe: vi.fn(async () => ({ result: { ok: true, value: { credentials: {} } } })) },
  }
  const controller = new ModelsSettingsStore(
    api as never, settingsSchema, new SettingsDescribeMirror(api as never))
  await controller.load()
  render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
    api={api as never} schema={settingsSchema} t={t} />)
  return controller
}

describe('内置渠道的只读卡片', () => {
  it('排在用户渠道之前并默认选中，目录按 Host 当前服务的模型展示', async () => {
    await mount()
    const rail = screen.getByRole('complementary', { name: en.provider })
    // 内置渠道排在用户渠道之前并默认选中；列表末尾才是「添加渠道」。
    const railButtons = within(rail).getAllByRole('button')
    expect(railButtons[0]?.getAttribute('aria-current')).toBe('true')
    expect(within(railButtons[0]!).getByText('Free')).toBeTruthy()
    expect(railButtons[1]?.textContent).toContain('My gateway')
    expect(railButtons.at(-1)?.textContent).toContain(en.add)
    // 详情不再重复渠道名，改用详情区域的名称标识当前渠道。
    expect(screen.getByRole('main', { name: 'Free' })).toBeTruthy()
    const detail = screen.getByRole('main')
    const outbound = within(detail).getByRole('group', { name: en.channelOutbound })
    // 只读目录与用户渠道共用「模型目录」标题，出站位于它上方。
    const catalog = within(detail).getAllByRole('region', { name: en.models })[0]!
    expect(outbound.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(catalog).getByText(en.models)).toBeTruthy()

    const table = screen.getAllByRole('region', { name: en.models }).find(node => node.hasAttribute('tabindex'))
    expect(table).toBeDefined()
    for (const model of FREE_MODELS) {
      expect(within(table!).getByText(model.id)).toBeTruthy()
      expect(within(table!).getByText(model.name)).toBeTruthy()
    }
    // 能力取自目录应答：MiMo 与 DeepSeek V4.1 Flash 接受图片，Nemotron 只接受文本。
    expect(within(table!).getAllByRole('img', { name: en.visionSupport })).toHaveLength(2)
    expect(within(table!).getAllByRole('img', { name: en.visionUnsupported })).toHaveLength(1)
    // 只有 DeepSeek V4.1 Flash 提供档位；没有档位的模型按提供方默认推理，不报成不支持。
    expect(within(table!).getAllByText('Low')).toHaveLength(1)
    expect(within(table!).getAllByText('Max')).toHaveLength(1)
    expect(within(table!).getAllByText(en.reasoningProviderDefault)).toHaveLength(2)
  })

  it('不提供端点、密钥、名称、目录或删除的写入入口', async () => {
    const controller = await mount()
    // 出站是唯一可写字段；只读卡片不再用说明段落占位。
    expect(screen.getByRole('group', { name: en.channelOutbound })).toBeTruthy()
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl)).toBeNull()
    expect(screen.queryByLabelText(en.channelName)).toBeNull()
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
    expect(screen.queryByRole('button', { name: en.addModel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.removeModel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.remove })).toBeNull()
    expect(screen.queryByRole('button', { name: en.fetchModels })).toBeNull()
    // 只读卡片不写设置：任何交互都不会发出写入。
    expect(controller.store.getSnapshot().catalog.get('free')).toEqual(FREE_MODELS)
  })

  it('目录读取失败时给出该渠道的诊断，而不是空目录', async () => {
    await mount({ failure: { id: 'free', name: 'Free', message: 'upstream unavailable' } })
    expect(screen.getByText(`${en.builtinChannelCatalogFailed}: upstream unavailable`)).toBeTruthy()
    expect(screen.queryByText(en.builtinChannelEmpty)).toBeNull()
  })
})

describe('内置渠道与用户渠道并存', () => {
  it('选中用户渠道时仍是原来的可编辑卡片', async () => {
    await mount()
    const rail = screen.getByRole('complementary', { name: en.provider })
    fireEvent.click(within(rail).getByRole('button', { name: 'My gateway' }))
    expect(screen.getByRole('main', { name: 'My gateway' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).value).toBe('https://gateway.example/v1')
    expect(screen.getByRole('button', { name: en.apply })).toBeTruthy()
    // 内置渠道的只读目录不再出现。
    expect(screen.queryByText('mimo-v2.6-flash-free')).toBeNull()
  })
})
