/**
 * Free 渠道的真实上游 e2e：这条渠道的凭据就是空 Bearer，端点与目录都是包内事实，
 * 因此它不需要任何密钥。它是 `pnpm run test:e2e` 里唯一默认会真的发出模型请求的
 * 套件；需要凭据的提供方套件仍各自按自己的密钥自跳过。
 *
 * 上游是匿名免费层，按出口 IP 限流；探活失败（离线、地区封锁）时整组跳过，
 * 不让无网络的环境变红。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from 'coding-llm'
import { FREE_UPSTREAMS, FreeChannelAdapter, PROVIDER_ID } from 'coding-llm-opencode'

/** 目录里响应最快的小模型：e2e 只验证空凭据能真的换回一份回复。 */
const MODEL = 'Qwen3.5-9B'

/** 取一条上游的探活端点；目录第一条是 OVHcloud AI Endpoints。 */
const PROBE_BASE_URL = FREE_UPSTREAMS[0]?.baseURL
if (PROBE_BASE_URL === undefined) throw new Error('the Free channel declares no upstream to probe')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * 探测匿名免费通道此刻是否可用。空 Bearer 是免费层的标识，探活请求与真实请求
 * 用同一形状，因此它验证的是「这条线路能不能用」，而不只是域名解析。
 * @returns 上游目录端点是否返回成功。
 */
async function freeLaneReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${PROBE_BASE_URL}/models`, {
      headers: { authorization: 'Bearer ' },
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok
  } catch {
    return false
  }
}

const REACHABLE = await freeLaneReachable()

/** Register the real adapter behind the LLM seam. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER_ID], new FreeChannelAdapter({}))
  return ctx
}

describe.skipIf(!REACHABLE)('Free channel e2e (real keyless upstream)', () => {
  it('reports the channel catalog without any credential', async () => {
    const ctx = await harness()

    const catalog = await ctx.llm.listModels(PROVIDER_ID)

    expect(catalog.map(entry => entry.id)).toContain('auto')
    expect(catalog.map(entry => entry.id)).toContain(MODEL)
  })

  it('streams a real completion with an empty bearer', async () => {
    const ctx = await harness()
    const assembler = new BlockAssembler()

    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER_ID,
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly the word OK and nothing else.' }],
        source: { kind: 'user' },
      })],
      maxTokens: 32,
      signal: AbortSignal.timeout(60_000),
    })) assembler.push(chunk)

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`the keyless lane failed: ${finish.failure.message} (${finish.failure.code})`)
    }
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    expect(text.length).toBeGreaterThan(0)
  }, 90_000)
})
