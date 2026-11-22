/** 出站配置的拒绝边界以及实际 SDK 发起的 HTTP 请求。 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from 'coding-llm'
import * as LlmPiAi from 'coding-llm-pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockProxy, mockServer } from './mock-server.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function harness(profile: LlmPiAi.PiAiProviderProfile): Promise<Context> {
  vi.stubEnv('PI_OUTBOUND_KEY', 'test-key')
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {
    gateway: { models: [{ id: 'model' }], apiKeyEnv: 'PI_OUTBOUND_KEY', ...profile },
  } })
  return ctx
}

it('拒绝无效代理地址、非 SSE 传输及原生 SDK 未受控的协议', () => {
  expect(() => resolveProfiles({ deepseek: { outbound: { mode: 'custom', customUrl: 'http://' } } }))
    .toThrow(/deepseek.*outbound.customUrl/)
  for (const transport of ['auto', 'websocket', 'websocket-cached'] as const) {
    expect(() => resolveProfiles({ deepseek: { outbound: { mode: 'pool' }, transport } }))
      .toThrow(/deepseek.*requires transport "sse"/)
  }
  expect(() => resolveProfiles({ google: { outbound: { mode: 'pool' } } }))
    .toThrow(/google.*google-generative-ai.*cannot use outbound proxies/)
})

it('代理池未装配时不向端点发出对话或探测', async () => {
  const upstream = await mockServer([])
  const ctx = await harness({ baseURL: upstream.url, outbound: { mode: 'pool' } })
  await expect(assemble(ctx, { provider: 'gateway', model: 'model', messages: [] }))
    .resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'gateway' }))
    .rejects.toThrow(/selected an unavailable proxy pool/)
  expect(upstream.paths).toEqual([])
})

it.each([
  ['openai-completions', '/v1/chat/completions', 'authorization'],
  ['openai-responses', '/v1/responses', 'authorization'],
  ['anthropic-messages', '/v1/messages', 'x-api-key'],
] as const)('直连 %s 不向跨源重定向目标发送密钥', async (api, path, credentialHeader) => {
  const target = await mockServer([])
  const redirect = await mockServer([{ status: 307, headers: { location: `${target.url}/redirected` } }])
  const ctx = await harness({ api, baseURL: api === 'anthropic-messages' ? redirect.url : `${redirect.url}/v1` })
  const result = await assemble(ctx, { provider: 'gateway', model: 'model', messages: [] })
  expect(result.finish).toMatchObject({ kind: 'error' })
  expect(redirect.paths).toEqual([path])
  expect(redirect.headers[0]?.[credentialHeader]).toContain('test-key')
  expect(target.paths).toEqual([])
})

it.each([
  ['openai-completions', '/v1/chat/completions'],
  ['openai-responses', '/v1/responses'],
  ['anthropic-messages', '/v1/messages'],
] as const)('代理 %s 通过 HTTP 代理发送请求，不跟随重定向', async (api, path) => {
  const target = await mockServer([])
  const redirect = await mockServer([{ status: 307, headers: { location: `${target.url}/redirected` } }])
  const proxy = await mockProxy('gateway.invalid:80', redirect.url)
  try {
    const ctx = await harness({
      api,
      baseURL: api === 'anthropic-messages' ? 'http://gateway.invalid' : 'http://gateway.invalid/v1',
      outbound: { mode: 'custom', customUrl: proxy.url },
    })
    const result = await assemble(ctx, { provider: 'gateway', model: 'model', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error' })
    expect(redirect.paths).toEqual([path])
    expect(proxy.targets).toEqual(['gateway.invalid:80'])
    expect(target.paths).toEqual([])
  } finally {
    await proxy.close()
  }
})
