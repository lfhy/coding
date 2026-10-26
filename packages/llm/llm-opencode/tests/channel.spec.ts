/**
 * Free 渠道内置事实的回归测试：目录、连接事实与注册形状都是包内代码事实，
 * 因此这里既锁定渠道对外的名称与模型，也锁定上游表本身的完整性。
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from 'coding-llm'
import { describe, expect, it } from 'vitest'
import * as LlmOpencode from 'coding-llm-opencode'
import { AUTO_MODEL_CANDIDATES, AUTO_MODEL_ID, CHANNEL_NAME, FREE_CHANNEL_MODELS, FREE_UPSTREAMS, freeChannelModel, PROVIDER_ID } from '../src/channel.ts'

/** 挂载只带 LLM 服务的上下文，再装上本插件。 */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpencode)
  return ctx
}

describe('built-in catalog', () => {
  it('渠道名与路由固定，模型按上游表展开', () => {
    expect(PROVIDER_ID).toBe('free')
    expect(CHANNEL_NAME).toBe('Free')
    expect(FREE_CHANNEL_MODELS.map(model => model.id)).toEqual([
      'Qwen3.5-397B-A17B', 'Qwen3.8-27B', 'Qwen3.5-9B', 'gpt-oss-120b', 'gpt-oss-20b',
      'Mistral-Small-3.2-24B-Instruct-2506',
      'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-lightning:free',
      'cohere/north-mini-code:free', 'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'recursive/flint-v1.0:free',
      'reflection/beam-free', 'poolside/laguna-s-2.1:free', 'kilo-auto/free',
    ])
    expect(FREE_CHANNEL_MODELS.map(model => model.name)).toEqual([
      'Qwen3.5 397B A17B (OVH)', 'Qwen3.8 27B (OVH)', 'Qwen3.5 9B (OVH)', 'GPT-OSS 120B (OVH)',
      'GPT-OSS 20B (OVH)', 'Mistral Small 3.2 24B (OVH)',
      'Nemotron 3 Ultra 550B (Kilo)', 'Nemotron 3.5 Lightning (Kilo)', 'North Mini Code (Kilo)',
      'Dots3 Note Preview (Kilo)', 'Nemotron 3 Nano Omni (Kilo)', 'Flint 1.0 (Kilo)',
      'Beam 1.0 (Kilo)', 'Laguna S 2.1 (Kilo)', 'Auto Free (Kilo)',
    ])
    // 每个模型都记得自己属于哪条上游记录，端点与凭据由它携带。
    expect(FREE_CHANNEL_MODELS.every(model => FREE_UPSTREAMS.includes(model.upstream))).toBe(true)
  })

  it('两条上游都是匿名免费层：端点固定、凭据为空串', () => {
    const upstreams = new Map(FREE_UPSTREAMS.map(upstream => [upstream.id, upstream]))
    expect(upstreams.get('ovh-ai-endpoints')).toMatchObject({
      baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      apiKey: '',
    })
    expect(upstreams.get('kilo-free-pool')).toMatchObject({
      baseURL: 'https://api.kilo.ai/api/gateway',
      apiKey: '',
    })
  })

  it('内置模型声明实测得到的模态与推理能力', () => {
    const models = new Map(FREE_CHANNEL_MODELS.map(model => [model.id, model]))
    // OVH：红色方块实测被 Qwen3.x 与 Mistral Small 读出，gpt-oss 两个模型答错，
    // 因此只有前者与 Mistral 声明图片输入。
    expect(models.get('Qwen3.5-397B-A17B')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('Qwen3.8-27B')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('Qwen3.5-9B')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('Mistral-Small-3.2-24B-Instruct-2506')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('Mistral-Small-3.2-24B-Instruct-2506')?.reasoning).toBe(false)
    expect(models.get('gpt-oss-120b')?.inputModalities).toEqual(['text'])
    expect(models.get('gpt-oss-20b')?.inputModalities).toEqual(['text'])
    // Kilo：图片只给实测读图的条目。
    expect(models.get('dots-studio/dots-3-note-preview:free')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('reflection/beam-free')?.inputModalities).toEqual(['text'])
    // Laguna S 2.1 不产出推理增量。
    expect(models.get('poolside/laguna-s-2.1:free')?.reasoning).toBe(false)
    // 档位只在实测接受过的模型上声明：Qwen3.x 认 none 到 xhigh，gpt-oss 120B 不认 none，
    // Kilo 侧未逐个实测，因此不给档位。
    expect(models.get('Qwen3.5-397B-A17B')?.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(models.get('Qwen3.8-27B')?.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high'])
    expect(models.get('Qwen3.5-9B')?.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(models.get('gpt-oss-120b')?.reasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(models.get('gpt-oss-20b')?.reasoningEfforts).toEqual([])
    expect(models.get('kilo-auto/free')?.reasoningEfforts).toEqual([])
  })

  it('Auto 候选表非空、按序展开且都指向已收录目录条目', () => {
    expect(AUTO_MODEL_ID).toBe('auto')
    expect(AUTO_MODEL_CANDIDATES.map(model => model.id)).toEqual([
      'Qwen3.5-397B-A17B',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'gpt-oss-120b',
      'nvidia/nemotron-3.5-lightning:free',
      'Mistral-Small-3.2-24B-Instruct-2506',
      'kilo-auto/free',
    ])
    // 候选跨两条上游交替：单上游整段限流时尽快切到另一家。
    expect(AUTO_MODEL_CANDIDATES.map(model => model.upstream.id)).toEqual([
      'ovh-ai-endpoints',
      'kilo-free-pool',
      'ovh-ai-endpoints',
      'kilo-free-pool',
      'ovh-ai-endpoints',
      'kilo-free-pool',
    ])
  })

  it('上游表自身完整：端点可用、凭据形状合法、模型 id 全局唯一', () => {
    for (const upstream of FREE_UPSTREAMS) {
      const baseURL = new URL(upstream.baseURL)
      expect(baseURL.protocol).toBe('https:')
      // 适配器直接拼 `{baseURL}/chat/completions`，尾斜杠会拼出双斜杠地址。
      expect(upstream.baseURL.endsWith('/')).toBe(false)
      // 两条上游都用空 Bearer 表达匿名免费层，凭据因此是空串。
      expect(upstream.apiKey).toBe('')
      expect(upstream.models.length).toBeGreaterThan(0)
    }
    const ids = FREE_CHANNEL_MODELS.map(model => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('模型的容量与显示名都是可用值', () => {
    for (const model of FREE_CHANNEL_MODELS) {
      expect(model.name.length).toBeGreaterThan(0)
      expect(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0).toBe(true)
      expect(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0).toBe(true)
      // 声明了档位却不具备推理能力是自相矛盾的条目：选择器会给出无法转发的档位。
      if (!model.reasoning) expect(model.reasoningEfforts).toEqual([])
    }
  })

  it('按 id 查找目录条目', () => {
    expect(freeChannelModel('Qwen3.5-397B-A17B')?.upstream.id).toBe('ovh-ai-endpoints')
    expect(freeChannelModel('kilo-auto/free')?.upstream.id).toBe('kilo-free-pool')
    expect(freeChannelModel('not-a-free-model')).toBeUndefined()
  })
})

describe('plugin apply', () => {
  it('挂载后立即注册 Free 路由，无需任何设置分节', async () => {
    const ctx = await mounted()
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER_ID, name: CHANNEL_NAME }])
    const models = await ctx.llm.listModels(PROVIDER_ID)
    // Auto 是目录首位：它是渠道的默认推荐选择。
    expect(models.map(model => model.id)).toEqual(['auto', ...FREE_CHANNEL_MODELS.map(model => model.id)])
    await ctx.fiber.dispose()
  })

  it('不声明可配置提供方目录：连接事实与目录都不是用户设置', async () => {
    const ctx = await mounted()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('卸载插件时撤销路由（HMR 安全）', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmOpencode)
    expect(ctx.llm.listProviders().map(entry => entry.id)).toEqual([PROVIDER_ID])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('描述内置模型时给出显示名、容量与请求默认值', async () => {
    const ctx = await mounted()
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'Qwen3.5-397B-A17B')).toMatchObject({
      name: 'Qwen3.5 397B A17B (OVH)',
      context: { contextWindow: 262_144 },
      defaultMaxTokens: 32_768,
    })
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'nvidia/nemotron-3.5-lightning:free')).toMatchObject({
      name: 'Nemotron 3.5 Lightning (Kilo)',
      context: { contextWindow: 1_000_000 },
    })
    // 未收录的模型按纯文本处理，不把未经验证的能力写进会话。
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'unlisted')).toMatchObject({
      name: 'unlisted',
      inputModalities: ['text'],
    })
    await ctx.fiber.dispose()
  })

  it('提供宿主可直接执行的重试策略', async () => {
    const ctx = await mounted()
    expect(ctx.llm.providerRetryPolicy(PROVIDER_ID).mode).toBe('normal')
    await ctx.fiber.dispose()
  })
})
