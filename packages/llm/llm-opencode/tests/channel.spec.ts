/**
 * Free 渠道内置事实的回归测试：目录、连接事实与注册形状都是包内代码事实，
 * 因此这里既锁定渠道对外的名称与模型，也锁定上游表本身的完整性。
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from 'coding-llm'
import { describe, expect, it } from 'vitest'
import * as LlmOpencode from 'coding-llm-opencode'
import { CHANNEL_NAME, FREE_CHANNEL_MODELS, FREE_UPSTREAMS, freeChannelModel, PROVIDER_ID } from '../src/channel.ts'

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
      'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'nemotron-3.5-lightning-free',
    ])
    expect(FREE_CHANNEL_MODELS.map(model => model.name)).toEqual([
      'Mimo V2.6 Flash', 'Deepseek V4.1 Flash', 'Nemotron 3.5 Lightning',
    ])
    // 每个模型都记得自己属于哪条上游记录，端点与凭据由它携带。
    expect(FREE_CHANNEL_MODELS.every(model => FREE_UPSTREAMS.includes(model.upstream))).toBe(true)
  })

  it('内置模型声明上游元数据里的模态与推理能力', () => {
    const models = new Map(FREE_CHANNEL_MODELS.map(model => [model.id, model]))
    // MiMo 与 DeepSeek V4.1 Flash 接受图片；Nemotron 3.5 Lightning 只接受文本。
    expect(models.get('mimo-v2.6-flash-free')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('deepseek-v4.1-flash-free')?.inputModalities).toEqual(['text', 'image'])
    expect(models.get('nemotron-3.5-lightning-free')?.inputModalities).toEqual(['text'])
    // 三者都会推理，但只有 DeepSeek V4.1 Flash 暴露可选档位。
    expect([...models.values()].map(model => model.reasoning)).toEqual([true, true, true])
    expect(models.get('deepseek-v4.1-flash-free')?.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(models.get('mimo-v2.6-flash-free')?.reasoningEfforts).toEqual([])
  })

  it('上游表自身完整：端点可用、凭据非空、模型 id 全局唯一', () => {
    for (const upstream of FREE_UPSTREAMS) {
      const baseURL = new URL(upstream.baseURL)
      expect(baseURL.protocol).toBe('https:')
      // 适配器直接拼 `{baseURL}/chat/completions`，尾斜杠会拼出双斜杠地址。
      expect(upstream.baseURL.endsWith('/')).toBe(false)
      expect(upstream.apiKey.length).toBeGreaterThan(0)
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
    expect(freeChannelModel('mimo-v2.6-flash-free')?.upstream.id).toBe('opencode-zen')
    expect(freeChannelModel('not-a-free-model')).toBeUndefined()
  })
})

describe('plugin apply', () => {
  it('挂载后立即注册 Free 路由，无需任何设置分节', async () => {
    const ctx = await mounted()
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER_ID, name: CHANNEL_NAME }])
    const models = await ctx.llm.listModels(PROVIDER_ID)
    expect(models.map(model => model.id)).toEqual(FREE_CHANNEL_MODELS.map(model => model.id))
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
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'mimo-v2.6-flash-free')).toMatchObject({
      name: 'Mimo V2.6 Flash',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 32_768,
    })
    expect(await ctx.llm.resolveModelInfo(PROVIDER_ID, 'deepseek-v4.1-flash-free')).toMatchObject({
      name: 'Deepseek V4.1 Flash',
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
