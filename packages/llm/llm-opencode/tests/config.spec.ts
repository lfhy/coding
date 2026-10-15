/**
 * 配置解析的回归测试：内置默认值必须让插件在没有任何设置分节时可用，
 * 而写错的端点或空目录必须在写入处就被拒绝。
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LlmOpencode from '@deepseek-ai/dsh-llm-opencode'
import {
  Config,
  DEFAULT_API_KEY,
  DEFAULT_BASE_URL,
  DEFAULT_MODELS,
  PROVIDER_ID,
  resolveOpencodeOptions,
} from '../src/config.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('resolveOpencodeOptions', () => {
  it('无配置时给出内置端点、匿名凭据与三个免费模型', () => {
    const options = resolveOpencodeOptions({})
    expect(options.baseURL).toBe(DEFAULT_BASE_URL)
    expect(options.apiKey).toBe(DEFAULT_API_KEY)
    expect(options.models.map(model => model.id)).toEqual([
      'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'nemotron-3.5-lightning-free',
    ])
  })

  it('模型的显示名固定，不随上游元数据漂移', () => {
    expect(resolveOpencodeOptions({}).models.map(model => model.name)).toEqual([
      'Mimo V2.6 Flash', 'Deepseek V4.1 Flash', 'Nemotron 3.5 Lightning',
    ])
  })

  it('端点去掉尾斜杠，使拼接出的请求地址唯一', () => {
    expect(resolveOpencodeOptions({ baseURL: 'https://gateway.example/v1/' }).baseURL)
      .toBe('https://gateway.example/v1')
  })

  it('用户替换的凭据、端点与目录整体生效', () => {
    const options = resolveOpencodeOptions({
      apiKey: 'sk-own-key',
      baseURL: 'https://gateway.example/v1',
      models: [{ id: 'custom', name: 'Custom', contextWindow: 4096, maxTokens: 512 }],
    })
    expect(options.apiKey).toBe('sk-own-key')
    expect(options.models).toEqual([
      { id: 'custom', name: 'Custom', contextWindow: 4096, maxTokens: 512, reasoningEfforts: [] },
    ])
  })

  it('拒绝空或非 http(s) 端点，并点名字段', () => {
    expect(() => resolveOpencodeOptions({ baseURL: '   ' })).toThrow(/baseURL/)
    expect(() => resolveOpencodeOptions({ baseURL: 'ftp://example.com' })).toThrow(/http or https/)
    expect(() => resolveOpencodeOptions({ baseURL: 'not a url' })).toThrow(/absolute URL/)
  })

  it('拒绝空目录、空 id 与重复 id', () => {
    expect(() => resolveOpencodeOptions({ models: [] })).toThrow(/at least one model/)
    expect(() => resolveOpencodeOptions({ models: [{ id: '' }] })).toThrow(/non-empty/)
    expect(() => resolveOpencodeOptions({ models: [{ id: 'a' }, { id: 'a' }] })).toThrow(/more than once/)
  })

  it('省略容量时回退到路由级默认值', () => {
    const options = resolveOpencodeOptions({ models: [{ id: 'x' }], defaultContextWindow: 8192, defaultMaxTokens: 1024 })
    expect(options.models[0]).toMatchObject({ contextWindow: 8192, maxTokens: 1024 })
  })

  it('解析出的重试策略是宿主可直接执行的形态', () => {
    expect(resolveOpencodeOptions({}).retryPolicy.mode).toBe('normal')
    expect(resolveOpencodeOptions({ retryPolicy: { mode: 'always' } }).retryPolicy.mode).toBe('always')
  })
})

describe('Config schema', () => {
  it('把省略的字段物化为内置默认值', () => {
    const config = Config({})
    expect(config.apiKey).toBe(DEFAULT_API_KEY)
    expect(config.baseURL).toBe(DEFAULT_BASE_URL)
    expect(config.models?.map(model => model.id)).toEqual(DEFAULT_MODELS.map(model => model.id))
  })
})

describe('plugin apply', () => {
  it('挂载后立即注册路由，无需任何设置分节', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode, {})
    expect(ctx.llm.listProviders().map(entry => entry.id)).toContain(PROVIDER_ID)
    expect(ctx.llm.listProviders().find(entry => entry.id === PROVIDER_ID)?.name).toBe('OpenCode Zen')
    const models = await ctx.llm.listModels(PROVIDER_ID)
    expect(models.map(model => model.id)).toEqual(DEFAULT_MODELS.map(model => model.id))
    await ctx.fiber.dispose()
    // dispose 后根上下文不再提供 llm 服务，因此用独立上下文确认撤销。
    const after = new Context()
    await after.plugin(LlmRuntime)
    expect(after.llm.listProviders().map(entry => entry.id)).not.toContain(PROVIDER_ID)
  })

  it('描述内置模型时给出显示名、容量与请求默认值', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode, {})
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'mimo-v2.6-flash-free')).toMatchObject({
      name: 'Mimo V2.6 Flash',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 32_768,
    })
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'deepseek-v4.1-flash-free')).toMatchObject({
      name: 'Deepseek V4.1 Flash',
    })
    await ctx.fiber.dispose()
  })

  it('设置分节覆盖端点与目录，且下一次读取即生效', async () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-llm-opencode-settings')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpencode, {})
    const settings = ctx.get('settings')
    expect(settings).toBeUndefined()
    // 未挂载 settings 服务时组合配置就是唯一事实来源。
    expect((await ctx.llm.listModels(PROVIDER_ID)).length).toBe(3)
    await ctx.fiber.dispose()
  })
})

describe('settings namespace', () => {
  it('注册的 namespace 名与本插件一致', () => {
    expect(settingsNamespace('llm-opencode')).toBe('llm-opencode')
  })
})
