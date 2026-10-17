/**
 * 节点持久化测试：分节镜像、重放追加语义与坏行容错。
 */

import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import { afterEach, describe, expect, it } from 'vitest'
import ProxyPoolService, { mirrorPoolNodes, parseProxyLink, serializeNodes, PROXY_POOL_NODES_SETTINGS_NAMESPACE } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** 无盘设置提供方。 */
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
    return '/tmp/proxy-pool-settings.yaml'
  }

  override prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.documentPath)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

describe('pool node persistence', () => {
  it('serializeNodes 往返：链接行可再导入为同址节点', () => {
    const original = parseProxyLink('socks5://u:p@1.2.3.4:1080#名字')
    const saved = serializeNodes([original])
    expect(saved.links).toHaveLength(1)
    const restored = parseProxyLink(saved.links[0]!)
    expect(restored).toMatchObject({ protocol: 'socks5', address: '1.2.3.4', port: 1080, username: 'u', secret: 'p', name: '名字' })
  })

  it('mirrorPoolNodes 重放设置里已保存的节点，坏行跳过', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    const pool = new ProxyPoolService(ctx, {})
    await pool.ready()
    // 先装镜像（分节随之注册），再写入保存的链接：安装时一次 onChange、
    // 写入后又一次，两次都会走到追加重放。
    mirrorPoolNodes(ctx, pool, node => pool.registerNode(node))
    // ctx.inject 的回调在设置服务就绪的微任务后注册分节；等它完成再写。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await ctx.settings.update(PROXY_POOL_NODES_SETTINGS_NAMESPACE, { links: ['http://1.2.3.4:8080#a', 'not-a-link'] })
    const nodes = pool.listNodes()
    expect(nodes.map(node => node.name)).toEqual(['a'])
    await ctx.fiber.dispose()
  })

  it('无设置提供方时 mirror 是 no-op，池照常工作', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const pool = new ProxyPoolService(ctx, {})
    await pool.ready()
    // mirror 的注册分节挂在 inject(['settings']) 上；没有设置服务时它静默
    // 不注册（这正是 no-op 语义），不给 root 留下会被误读的悬空状态。
    mirrorPoolNodes(ctx, pool, node => pool.registerNode(node))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    pool.registerNode(parseProxyLink('http://5.6.7.8:8080#b'))
    expect(pool.listNodes().map(node => node.name)).toEqual(['b'])
    await ctx.fiber.dispose()
  })
})
