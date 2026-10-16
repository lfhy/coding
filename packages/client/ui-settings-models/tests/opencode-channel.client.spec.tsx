// @vitest-environment jsdom
/**
 * 内置 OpenCode Zen 渠道在模型设置页的契约：它自带默认端点、匿名凭据与目录，
 * 因此无需先写 `settings.yaml` 分节就出现在渠道列表里，并能像其他渠道一样
 * 改名称、改端点、换密钥与增删模型。
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelListEditor, modelCapabilities } from '../src/client/ModelListEditor.tsx'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** `llm-opencode` 分节的 schema 形态：整节即 profile，密钥是只写字段。 */
const OpencodeConfig = Schema.object({
  channelName: Schema.string(),
  apiKey: Schema.string().role('secret'),
  baseURL: Schema.string(),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    contextWindow: Schema.number(),
    maxTokens: Schema.number(),
    inputModalities: Schema.array(Schema.union(['text', 'image'])),
    reasoning: Schema.boolean(),
    reasoningEfforts: Schema.array(Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
  })),
})

/** 内置目录的形态与插件默认值一致：两个多模态模型 + 一个纯文本模型。 */
const BUILT_IN_MODELS = [
  {
    id: 'mimo-v2.6-flash-free', name: 'Mimo V2.6 Flash', contextWindow: 1_048_576, maxTokens: 32_768,
    inputModalities: ['text', 'image'], reasoning: true,
  },
  {
    id: 'deepseek-v4.1-flash-free', name: 'Deepseek V4.1 Flash', contextWindow: 262_144, maxTokens: 32_768,
    inputModalities: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', contextWindow: 262_144, maxTokens: 32_768,
    inputModalities: ['text'], reasoning: true,
  },
]

/** 宿主描述出来的一份分节视图：`apiKey` 是 secret，因此值从不出现。 */
function opencodeNamespace(user: Record<string, unknown> = {}, revision = 0): SettingsNamespaceView {
  return {
    ns: 'llm-opencode',
    schema: JSON.parse(JSON.stringify(OpencodeConfig.toJSON())) as unknown,
    value: { channelName: 'OpenCode Zen', baseURL: 'https://opencode.ai/zen/v1', models: BUILT_IN_MODELS, ...user },
    base: { models: BUILT_IN_MODELS },
    user,
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: true }],
    revision,
  }
}

function ok<T>(value: T): { rpcId: never; result: { ok: true; value: T } } {
  return { rpcId: 'r' as never, result: { ok: true, value } }
}

/** 把一次路径操作应用到用户层，模拟宿主接受的写入。 */
function applyOps(user: Record<string, unknown>, ops: readonly SettingsPathOpView[]): Record<string, unknown> {
  const next = structuredClone(user)
  for (const op of ops) {
    const [head, ...rest] = op.path
    /* v8 ignore next -- the card never addresses the section root */
    if (head === undefined) continue
    if (op.op === 'unset') {
      Reflect.deleteProperty(next, head)
      continue
    }
    if (rest.length === 0) {
      next[head] = op.value
      continue
    }
    const child = typeof next[head] === 'object' && next[head] !== null
      ? next[head] as Record<string, unknown>
      : {}
    next[head] = applyOps(child, [{ ...op, path: rest }])
  }
  return next
}

interface Mounted {
  mutate: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  namespace: () => SettingsNamespaceView
}

/** 只挂内置渠道一条目录项的模型设置页。 */
async function mountCard(): Promise<Mounted> {
  let current = opencodeNamespace()
  const mutate = vi.fn((request: { ns: string; ops: SettingsPathOpView[] }) => {
    const user = applyOps(current.user as Record<string, unknown>, request.ops)
    current = { ...opencodeNamespace(user, current.revision + 1), user }
    return Promise.resolve(ok(current))
  })
  const set = vi.fn(() => Promise.resolve(ok({})))
  const face = {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: [{
          provider: 'opencode-zen',
          displayName: 'OpenCode Zen',
          settingsNs: 'llm-opencode',
          settingsPath: [],
          active: true,
        }],
      }))),
      models: vi.fn(() => Promise.resolve(ok({
        groups: [{
          id: 'opencode-zen',
          name: 'OpenCode Zen',
          models: BUILT_IN_MODELS.map(model => ({ id: model.id, name: model.name })),
        }],
        failures: [],
      }))),
      discoverModels: vi.fn(() => Promise.resolve(ok({ models: [] }))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({ writable: true, namespaces: [current] }))),
      update: vi.fn(),
      replace: vi.fn(),
      mutate,
    },
    credentials: {
      describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))),
      set,
      unset: vi.fn(),
    },
  }
  const controller = new ModelsSettingsStore(
    face as never, settingsSchema, new SettingsDescribeMirror(face as never))
  await controller.load()
  render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
    api={face as never} schema={settingsSchema} t={t} />)
  return { mutate, set, namespace: () => current }
}

describe('内置 OpenCode Zen 渠道', () => {
  it('无需任何用户分节就出现在渠道列表，并展示它自带的端点与继承目录', async () => {
    await mountCard()
    const rail = screen.getByRole('complementary', { name: en.provider })
    expect(within(rail).getByRole('button', { name: 'OpenCode Zen' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'OpenCode Zen' })).toBeTruthy()
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(baseURL.value).toBe('')
    expect(baseURL.placeholder).toBe('https://opencode.ai/zen/v1')
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    const table = screen.getAllByRole('region', { name: en.models }).find(node => node.hasAttribute('tabindex'))
    expect(table).toBeDefined()
    for (const id of ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'nemotron-3.5-lightning-free']) {
      expect(within(table!).getByDisplayValue(id)).toBeTruthy()
    }
    // 内置目录声明的能力就在行上：三者都会推理，两个多模态模型接受图片，Nemotron 只接受文本。
    expect(within(table!).getAllByRole('img', { name: en.reasoningSupport })).toHaveLength(3)
    expect(within(table!).getAllByRole('img', { name: en.visionSupport })).toHaveLength(2)
    expect(within(table!).getAllByRole('img', { name: en.visionUnsupported })).toHaveLength(1)
  })

  it('密钥字段只写不回显，写入落在自己的分节而不是凭据服务', async () => {
    const mounted = await mountCard()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.value).toBe('')
    expect(key.placeholder).toBe(en.keyPlaceholderPublic)
    fireEvent.change(key, { target: { value: 'sk-own-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await vi.waitFor(() => { expect(mounted.mutate).toHaveBeenCalledTimes(1) })
    expect(mounted.mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-opencode',
      expectedRevision: 0,
      ops: [{ op: 'set', path: ['apiKey'], value: 'sk-own-key' }],
    })
    expect(mounted.set).not.toHaveBeenCalled()
    expect(mounted.namespace().user).toEqual({ apiKey: 'sk-own-key' })
    // 已写入的密钥不留在草稿里：字段被清空，再次提交也不会重写它。
    await vi.waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).value).toBe('') })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await vi.waitFor(() => { expect(screen.queryByText(en.applying)).toBeNull() })
    expect(mounted.mutate).toHaveBeenCalledTimes(1)
  })

  it('渠道名称与端点按路径写入，名称非法时不提交', async () => {
    const mounted = await mountCard()
    const name = screen.getByLabelText<HTMLInputElement>(en.channelName)
    expect(name.value).toBe('OpenCode Zen')
    fireEvent.change(name, { target: { value: '   ' } })
    expect(screen.getByText(en.channelNameInvalid)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(name, { target: { value: '团队 Zen' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await vi.waitFor(() => { expect(mounted.mutate).toHaveBeenCalledTimes(1) })
    expect(mounted.mutate.mock.calls[0]?.[0]).toEqual({
      ns: 'llm-opencode',
      expectedRevision: 0,
      ops: [
        { op: 'set', path: ['baseURL'], value: 'https://gateway.example/v1' },
        { op: 'set', path: ['channelName'], value: '团队 Zen' },
      ],
    })
  })
})

describe('opencode 家族的模型行', () => {
  it('按声明读能力：模态字段决定视觉，能力标记与档位各自独立', () => {
    expect(modelCapabilities({
      id: 'vision', inputModalities: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'],
    }, 'llm-opencode')).toEqual({ vision: 'supported', reasoning: 'supported' })
    expect(modelCapabilities({ id: 'text-only', inputModalities: ['text'], reasoning: true }, 'llm-opencode'))
      .toEqual({ vision: 'unsupported', reasoning: 'supported' })
    expect(modelCapabilities({ id: 'silent' }, 'llm-opencode')).toEqual({ vision: 'unknown', reasoning: 'unknown' })
    expect(modelCapabilities({ id: 'disabled', reasoning: false }, 'llm-opencode').reasoning).toBe('unsupported')
    // pi-ai 的档位映射对象不是 opencode 的声明形态，不能据此推断模态。
    expect(modelCapabilities({ id: 'foreign', input: ['text', 'image'] }, 'llm-opencode').vision).toBe('unknown')
  })

  it('模型设置窗口声明模态与推理，关掉推理时撤掉档位', () => {
    const onChange = vi.fn()
    function Fixture(): ReturnType<typeof ModelListEditor> {
      const [models, setModels] = useState<ModelDraft[]>([{
        id: 'deepseek-v4.1-flash-free', inputModalities: ['text'], reasoning: true,
      }])
      return <ModelListEditor models={models} onChange={(next) => { onChange(next); setModels(next) }}
        probe={{ settingsNs: 'llm-opencode', provider: 'opencode-zen' }} api={{ llm: {} } as never}
        t={t} disabled={false} />
    }
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    const card = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    const vision = within(card).getByRole('button', { name: en.visionSupport })
    const reasoning = within(card).getByRole('button', { name: en.reasoningSupport })
    expect(vision.getAttribute('aria-pressed')).toBe('false')
    expect(reasoning.getAttribute('aria-pressed')).toBe('true')
    // 声明了推理能力但没有档位的行：菜单里没有任何已选档位。
    // 没有已选档位时可访问名只有标签本身（尾部空格被规范化掉），因此按标签前缀匹配。
    fireEvent.click(within(card).getByRole('button', { name: name => name.startsWith(en.reasoningLevels) }))
    for (const level of [en.reasoningNone, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const item = within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: level })
      expect(item.getAttribute('aria-checked')).toBe('false')
    }
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'high' }))
    fireEvent.click(vision)
    fireEvent.click(reasoning)
    expect(reasoning.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(card).getByRole('button', { name: en.save }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{
      id: 'deepseek-v4.1-flash-free',
      inputModalities: ['text', 'image'],
      reasoning: false,
    }])
  })

  it('重新打开行时按已声明的档位回显', () => {
    const noop = vi.fn()
    render(<ModelListEditor models={[{ id: 'deepseek-v4.1-flash-free', reasoning: true, reasoningEfforts: ['low', 'high'] }]}
      onChange={noop} probe={{ settingsNs: 'llm-opencode', provider: 'opencode-zen' }} api={{ llm: {} } as never}
      t={t} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    const card = screen.getByRole('dialog', { name: `${en.modelAdvanced} 1` })
    const levels = within(card).getByRole('button', { name: name => name.startsWith(en.reasoningLevels) })
    expect(levels.textContent).toContain('low')
    fireEvent.click(levels)
    expect(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'high' }).getAttribute('aria-checked'))
      .toBe('true')
    expect(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'medium' }).getAttribute('aria-checked'))
      .toBe('false')
  })

  it('新增行的行内 ID 与名称是唯一写入的字段', () => {
    const onChange = vi.fn()
    const noop: unknown = { llm: {} }
    render(<ModelListEditor models={[]} onChange={onChange} probe={{ settingsNs: 'llm-opencode', provider: 'opencode-zen' }}
      api={noop as never} t={t} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ id: '' }])
  })
})
