/**
 * 节点持久化测试：分节镜像、重放追加语义与坏行容错。
 */

import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import { afterEach, describe, expect, it } from 'vitest'
import ProxyPoolService, { parseProxyLink, serializeNodes, PROXY_POOL_NODES_SETTINGS_NAMESPACE } from '../src/index.ts'

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
    // 服务构造时已安装镜像（分节随之注册）；写入保存的链接会再走一次重放。
    // ctx.inject 的回调在设置服务就绪的微任务后注册分节；等它完成再写。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await ctx.settings.update(PROXY_POOL_NODES_SETTINGS_NAMESPACE, { links: ['http://1.2.3.4:8080#a', 'not-a-link'] })
    const nodes = pool.listNodes()
    expect(nodes.map(node => node.name)).toEqual(['a'])
    await ctx.fiber.dispose()
  })

  it('导入与删除经镜像写回设置，重启重放恢复手工节点', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    const settings = ctx.get('settings') as InstanceType<typeof MemorySettings>
    const pool = new ProxyPoolService(ctx, {})
    await pool.ready()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const disposeA = pool.registerNode(parseProxyLink('socks5://u:p@1.2.3.4:1080#a'))
    pool.registerNode(parseProxyLink('http://5.6.7.8:8080#b'))
    // 写回在注册事件的监听器里同步发起、经设置的写队列落盘；等一个宏任务。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const saved = settings.doc[PROXY_POOL_NODES_SETTINGS_NAMESPACE] as { links: string[] }
    expect(saved.links).toHaveLength(2)
    expect(saved.links[0]).toBe('socks5://u:p@1.2.3.4:1080#a')

    // 删除一个：写回只剩存者。
    disposeA()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const afterRemove = settings.doc[PROXY_POOL_NODES_SETTINGS_NAMESPACE] as { links: string[] }
    expect(afterRemove.links).toEqual(['http://5.6.7.8:8080#b'])

    // 重启语义：新池在同一设置文档上重放，存者回归。
    const next = new Context()
    contexts.push(next)
    await next.plugin(class extends MemorySettings {
      constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0]) {
        super(ctx)
        this.doc = structuredClone(settings.doc)
      }
    })
    const rebooted = new ProxyPoolService(next, {})
    await rebooted.ready()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(rebooted.listNodes().map(node => node.name)).toEqual(['b'])
    await next.fiber.dispose()
  })

  it('订阅刷新的 feed 节点不进持久化，手工节点照常落盘', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemorySettings)
    const settings = ctx.get('settings') as InstanceType<typeof MemorySettings>
    const pool = new ProxyPoolService(ctx, {})
    await pool.ready()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    pool.registerNode(parseProxyLink('http://5.6.7.8:8080#手工'))
    // 订阅刷新入池的节点带 feed: 前缀名，模拟一个。
    pool.registerNode({ ...parseProxyLink('http://1.1.1.1:8080#x'), name: 'feed:1.1.1.1' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const saved = settings.doc[PROXY_POOL_NODES_SETTINGS_NAMESPACE] as { links: string[] }
    // 显示名在链接行 fragment 里按 encodeURIComponent 存储。
    expect(saved.links).toEqual([`http://5.6.7.8:8080#${encodeURIComponent('手工')}`])
  })

  it('各协议链接行往返：vless/vmess/hysteria2 字段无损', () => {
    const cases = [
      'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=cdn.example.com&type=ws&path=%2Fws#vl',
      'vmess://eyJ2IjoiMiIsInBzIjoi5Lqk6YeGIiwiYWRkIjoiZXhhbXBsZS5jb20iLCJwb3J0IjoiNDQzIiwiaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJhaWQiOiIwIiwibmV0Ijoid3MiLCJwYXRoIjoiL3dzIiwidGxzIjoidGxzIiwic25pIjoiY2RuLmV4YW1wbGUuY29tIn0=',
      'hy2://letmein@example.com:8443?sni=cdn.example.com&insecure=1#hy',
      'socks5://u:p@1.2.3.4:1080#名字',
      'http://5.6.7.8:8080#plain',
    ]
    for (const link of cases) {
      // id 每次解析都会重铸，往返断言看 id 之外的全部字段。
      const { id: _ignored, ...expected } = parseProxyLink(link)
      const { id: _also, ...restored } = parseProxyLink(serializeNodes([parseProxyLink(link)]).links[0]!)
      expect(restored, link).toEqual(expected)
    }
  })

  it('无设置提供方时 mirror 是 no-op，池照常工作', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const pool = new ProxyPoolService(ctx, {})
    await pool.ready()
    // mirror 的注册分节挂在 inject(['settings']) 上；没有设置服务时它静默
    // 不注册（这正是 no-op 语义），不给 root 留下会被误读的悬空状态。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    pool.registerNode(parseProxyLink('http://5.6.7.8:8080#b'))
    expect(pool.listNodes().map(node => node.name)).toEqual(['b'])
    await ctx.fiber.dispose()
  })
})
