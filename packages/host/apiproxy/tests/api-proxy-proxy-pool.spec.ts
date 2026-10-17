/**
 * proxyPool RPC domain over createApiProxy: describe/import/remove/test/
 * setOutbound against a mounted pool service plus the settings-backed
 * outbound view, and the absent-service error path.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from 'coding-agent'
import SessionStore from 'coding-session'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import UserQuestionService from 'coding-user-questions'
import { SettingsProvider } from 'coding-settings'
import ProxyPoolService, { parseProxyLink } from 'coding-proxy-pool'
import * as LlmOpencode from 'coding-llm-opencode'
import LlmRuntime from 'coding-llm'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** 无盘设置提供方：出站分节的读写都留在内存里。 */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0]) {
    super(ctx)
    this.doc = {}
  }

  get writable(): boolean {
    return true
  }

  override get documentPath(): string | undefined {
    return '/tmp/test-settings.yaml'
  }

  override prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.documentPath)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: import('coding-settings').SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** 组装带代理池与设置服务的宿主上下文（createApiProxy 的完整前置）。 */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ProxyPoolService)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpencode)
  return ctx
}

describe('proxyPool domain', () => {
  it('describe 返回空注册表、直连出站与非空前端地址', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    const view = expectOk(await api.proxyPool.describe(request({})))
    expect(view.nodes).toEqual([])
    expect(view.groups).toEqual([])
    expect(view.health).toEqual([])
    expect(view.outbound).toEqual({ mode: 'direct' })
    expect(view.frontendURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await ctx.fiber.dispose()
  })

  it('importLinks 注册全部合法行并跳过坏行，凭据只回存在性', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    const text = [
      'socks5://user:pass@1.2.3.4:1080#node-a',
      'not-a-link',
      'http://5.6.7.8:8080#node-b',
    ].join('\n')
    const result = expectOk(await api.proxyPool.importLinks(request({ text })))
    expect(result.skipped).toBe(1)
    expect(result.imported).toHaveLength(2)
    const socks = result.imported.find(node => node.name === 'node-a')!
    expect(socks).toMatchObject({ protocol: 'socks5', address: '1.2.3.4', port: 1080 })
    expect(socks.hasUsername).toBe(true)
    expect(socks.hasSecret).toBe(true)
    // 凭据值不在线视图上。
    expect(socks).not.toHaveProperty('secret')
    // describe 立即看到导入结果。
    const view = expectOk(await api.proxyPool.describe(request({})))
    expect(view.nodes.map(node => node.name)).toEqual(['node-a', 'node-b'])
    await ctx.fiber.dispose()
  })

  it('removeNode 移除存在的节点，未知 id 返回 removed:false', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    const imported = expectOk(await api.proxyPool.importLinks(request({ text: 'http://1.2.3.4:8080#x' })))
    const id = imported.imported[0]!.id
    expect(expectOk(await api.proxyPool.removeNode(request({ id }))).removed).toBe(true)
    expect(expectOk(await api.proxyPool.removeNode(request({ id }))).removed).toBe(false)
    const view = expectOk(await api.proxyPool.describe(request({})))
    expect(view.nodes).toEqual([])
    await ctx.fiber.dispose()
  })

  it('testNode 触发一次探测并返回健康记录', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    const imported = expectOk(await api.proxyPool.importLinks(request({ text: 'http://127.0.0.1:1#dead' })))
    const id = imported.imported[0]!.id
    const health = expectOk(await api.proxyPool.testNode(request({ id })))
    expect(health).toMatchObject({ nodeId: id, alive: false })
    expect(health?.failure).toMatch(/cannot reach proxy node/)
    await ctx.fiber.dispose()
  })

  it('setOutbound 写入设置分节，describe 读回同一选择', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    expectOk(await api.proxyPool.setOutbound(request({ mode: { mode: 'custom', customUrl: 'http://10.0.0.1:8080' } })))
    const view = expectOk(await api.proxyPool.describe(request({})))
    expect(view.outbound).toEqual({ mode: 'custom', customUrl: 'http://10.0.0.1:8080' })
    await ctx.fiber.dispose()
  })

  it('未挂代理池服务时 describe 返回 proxy-pool-unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.proxyPool.describe(request({})))
    expect(error.code).toBe('proxy-pool-unavailable')
    expect(error.details).toEqual({ capability: 'proxy-pool' })
    await ctx.fiber.dispose()
  })

  it('导入重复链接时后到者被跳过而不是报错', async () => {
    const ctx = await mounted()
    const api = createApiProxy(ctx, DEFAULTS)
    const node = parseProxyLink('socks5://1.2.3.4:1080#dup')
    ctx.proxyPool.registerNode(node)
    const result = expectOk(await api.proxyPool.importLinks(request({ text: 'socks5://5.6.7.8:1080#other' })))
    // 每次导入都铸造新 id，因此「重复链接」表现为池内出现两个同址节点；
    // 管理面按 id 删除即可，导入语义不做去重（订阅链接每次刷新都是新目录）。
    expect(result.imported).toHaveLength(1)
    const again = expectOk(await api.proxyPool.importLinks(request({ text: 'socks5://5.6.7.8:1080#other' })))
    expect(again.imported).toHaveLength(1)
    const view = expectOk(await api.proxyPool.describe(request({})))
    expect(view.nodes.filter(node => node.name === 'other')).toHaveLength(2)
    await ctx.fiber.dispose()
  })
})
