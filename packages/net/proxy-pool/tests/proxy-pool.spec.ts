/**
 * 代理池链接解析与出站拨号测试：链接形态、SOCKS5/HTTP 握手用本地假服务器
 * 回环验证；VLESS/VMess/Hysteria2 校验请求头形状与稳定拒绝。
 *
 * @module coding-proxy-pool
 */

import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { SettingsProvider } from 'coding-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProxyPoolService, {
  parseProxyLink,
  parseProxyLinks,
  PROXY_POOL_SETTINGS_NAMESPACE,
} from '../src/index.ts'
import { dialThrough } from '../src/dialer.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** 挂一个默认配置的代理池，等待入站监听就绪。 */
async function mounted(): Promise<ProxyPoolService> {
  const ctx = new Context()
  contexts.push(ctx)
  const pool = new ProxyPoolService(ctx)
  await pool.ready()
  return pool
}

/** 无盘设置提供方：池规则与节点分节的读写都留在内存里。 */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean { return true }

  override get documentPath(): string | undefined { return '/tmp/proxy-pool-settings.yaml' }

  override prepareDocument(): Promise<string | undefined> { return Promise.resolve(this.documentPath) }

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }

  protected persist(ns: import('coding-settings').SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** 挂一个带设置服务的代理池，池规则可经设置改写。 */
async function mountedWithSettings(): Promise<{ pool: ProxyPoolService; settings: MemorySettings }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  const pool = new ProxyPoolService(ctx)
  await pool.ready()
  const settings = ctx.get('settings') as MemorySettings
  return { pool, settings }
}

describe('parseProxyLink', () => {
  it('解析 vless WebSocket 链接的全部字段', () => {
    const node = parseProxyLink('vless://5783a3e7-e373-51cd-8642-c83782b807c5@example.com:443?tls=1&type=ws&path=%2Fvl&sni=cdn.example.com#节点A')
    expect(node).toMatchObject({
      protocol: 'vless',
      address: 'example.com',
      port: 443,
      secret: '5783a3e7-e373-51cd-8642-c83782b807c5',
      tls: { serverName: 'cdn.example.com' },
      transport: { type: 'ws', ws: { path: '/vl' } },
      name: '节点A',
    })
    expect(node.id).toHaveLength(36)
  })

  it('解析 vmess base64 JSON 链接并默认 AEAD', () => {
    const payload = { v: '2', ps: 'vm节点', add: 'vm.example.com', port: '8443', id: '0233d11c-15a4-47d3-ade3-48ffca0ce119', aid: '0', net: 'tcp', tls: 'tls', sni: 's.example.com' }
    const link = `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`
    const node = parseProxyLink(link)
    expect(node).toMatchObject({
      protocol: 'vmess',
      address: 'vm.example.com',
      port: 8443,
      secret: '0233d11c-15a4-47d3-ade3-48ffca0ce119',
      alterId: 0,
      tls: { serverName: 's.example.com' },
      transport: { type: 'tcp' },
      name: 'vm节点',
    })
  })

  it('解析 hy2 与 socks5 链接', () => {
    const hy2 = parseProxyLink('hy2://authkey@hy.example.com:8443?sni=h.example.com&insecure=1#hy')
    expect(hy2).toMatchObject({ protocol: 'hysteria2', address: 'hy.example.com', port: 8443, secret: 'authkey', tls: { serverName: 'h.example.com', allowInsecure: true } })
    const socks = parseProxyLink('socks5://user:pass@1.2.3.4:1080#sk')
    expect(socks).toMatchObject({ protocol: 'socks5', address: '1.2.3.4', port: 1080, username: 'user', secret: 'pass', name: 'sk' })
  })

  it('无法解析的链接给出稳定诊断；批量解析跳过坏行', () => {
    expect(() => parseProxyLink('trojan://x@y:443')).toThrow(/unsupported proxy link scheme/)
    const { nodes, skipped } = parseProxyLinks('socks5://1.2.3.4:1080\n\nnot-a-link\nhttp://5.6.7.8:8080')
    expect(nodes).toHaveLength(2)
    expect(skipped).toBe(1)
  })
})

describe('dialThrough', () => {
  /** 起一个本地 HTTP CONNECT 假代理，记录收到的权威串。 */
  function fakeHttpProxy(onConnect: (authority: string) => void): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer()
      server.on('connect', (req, socket) => {
        onConnect(req.url ?? '')
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
      })
    })
  }

  it('HTTP 节点发出 CONNECT 并透传双向数据', async () => {
    let saw: string | undefined
    const { server, port } = await fakeHttpProxy(authority => (saw = authority))
    const node = parseProxyLink(`http://127.0.0.1:${port}#local`)
    const stream = await dialThrough(node, { host: 'opencode.ai', port: 443 })
    expect(saw).toBe('opencode.ai:443')
    // 写一段数据应原样回到本地（假代理不转发，但流保持可写不报错）。
    stream.write('ping')
    stream.destroy()
    server.close()
  })

  it('HTTP 代理拒绝 CONNECT 时以 PROXY_DIAL_FAILED 失败', async () => {
    const server = createServer()
    server.on('connect', (_req, socket) => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    const node = parseProxyLink(`http://127.0.0.1:${port}#denied`)
    await expect(dialThrough(node, { host: 'x.example', port: 443 })).rejects.toThrow(/403/)
    server.close()
  })

  it('Hysteria2 节点给出明确的不支持错误而不是静默直连', async () => {
    const node = parseProxyLink('hy2://k@1.2.3.4:443')
    await expect(dialThrough(node, { host: 'x.example', port: 443 })).rejects.toThrow(/hysteria2 transport is not available/)
  })

  it('连不上的节点以 PROXY_DIAL_FAILED 快速失败', async () => {
    const node = parseProxyLink('http://127.0.0.1:1#dead')
    await expect(dialThrough(node, { host: 'x.example', port: 80 })).rejects.toThrow(/cannot reach proxy node/)
  })
})

describe('forward proxy frontend', () => {
  /** 起一个 CONNECT 型假节点 + 一个本地目标站，回环打满整条正向代理链路。 */
  async function fakeWorld(): Promise<{ targetPort: number; nodePort: number; server: Server; node: Server }> {
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok-body')
    })
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', () => { resolve() }) })
    const targetPort = (target.address() as { port: number }).port
    const node = createServer()
    node.on('connect', (req, socket) => {
      const index = req.url?.lastIndexOf(':') ?? -1
      const host = req.url?.slice(0, index) ?? ''
      const port = Number(req.url?.slice((index ?? 0) + 1))
      const upstream = tcpConnect(port, host)
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      socket.once('error', () => { upstream.destroy() })
      upstream.once('error', () => { socket.destroy() })
    })
    await new Promise<void>((resolve) => { node.listen(0, '127.0.0.1', () => { resolve() }) })
    return { targetPort, nodePort: (node.address() as { port: number }).port, server: target, node }
  }

  it('明文 http 目标的正向代理请求经节点隧道到达目标并带回响应', async () => {
    const world = await fakeWorld()
    const pool = await mounted()
    pool.registerNode(parseProxyLink(`http://127.0.0.1:${world.nodePort}#fw`))
    const client = tcpConnect({ port: pool.port, host: '127.0.0.1' })
    const timeout = setTimeout(() => { throw new Error('forward proxy roundtrip timed out') }, 8000)
    let received = ''
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => {
        client.write(`GET http://127.0.0.1:${world.targetPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${world.targetPort}\r\nConnection: close\r\n\r\n`)
      })
      client.on('data', (chunk) => {
        received += chunk.toString('latin1')
        if (received.includes('ok-body')) { resolve() }
      })
      client.once('error', (error) => { reject(error) })
    })
    clearTimeout(timeout)
    expect(received.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(received).toContain('ok-body')
    client.destroy()
    world.server.close()
    world.node.close()
    await contexts[0]!.fiber.dispose()
  })

  it('相对路径请求（非代理形态）被入站以 400 拒绝', async () => {
    const pool = await mounted()
    const client = tcpConnect({ port: pool.port, host: '127.0.0.1' })
    const firstLine = await new Promise<string>((resolve, reject) => {
      client.once('connect', () => {
        client.write('GET /relative HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      })
      client.once('data', (chunk) => { resolve(chunk.toString('latin1').split('\r\n')[0]!) })
      client.once('error', (error) => { reject(error) })
    })
    expect(firstLine).toBe('HTTP/1.1 400 Bad Request')
    client.destroy()
    await contexts[0]!.fiber.dispose()
  })
})

describe('ProxyPoolService', () => {
  it('伴随上下文启动本地入站并在释放后停止监听', async () => {
    const pool = await mounted()
    const ctx = contexts[0]!
    expect(pool.port).toBeGreaterThan(0)
    // 缺省出站为直连：池地址不对外提供，消费方因此回落直连。
    expect(pool.outbound).toEqual({ mode: 'direct' })
    expect(pool.proxyURL({ kind: 'pool' })).toBeUndefined()
    expect(pool.proxyURL({ kind: 'direct' })).toBeUndefined()
    expect(pool.proxyURL({ kind: 'custom', url: 'http://10.0.0.1:8080' })).toBe('http://10.0.0.1:8080')
    // 没有节点时 CONNECT 返回 502。
    const probe = tcpConnect({ port: pool.port, host: '127.0.0.1' })
    const head = await new Promise<string>((resolve) => {
      probe.once('connect', () => {
        probe.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
      })
      probe.once('data', (chunk) => { resolve(chunk.toString('latin1').split('\r\n')[0]!) })
    })
    expect(head).toBe('HTTP/1.1 502 Bad Gateway')
    probe.destroy()
    await ctx.fiber.dispose()
    expect(pool.port).toBe(0)
  })

  it('池的出站为直连时不排期刷新，切到代理池后才开始拉取订阅', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      const { pool, settings } = await mountedWithSettings()
      expect(pool.outbound).toEqual({ mode: 'direct' })
      await vi.advanceTimersByTimeAsync(300_000)
      expect(fetchStub).not.toHaveBeenCalled()
      await settings.update(PROXY_POOL_SETTINGS_NAMESPACE, { mode: 'pool' })
      expect(pool.outbound).toEqual({ mode: 'pool' })
      expect(pool.proxyURL({ kind: 'pool' })).toBe(`http://127.0.0.1:${pool.port}`)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(fetchStub).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('池的出站为自定义代理时，选内置代理池的渠道使用池配置的地址', async () => {
    const { pool, settings } = await mountedWithSettings()
    await settings.update(PROXY_POOL_SETTINGS_NAMESPACE, { mode: 'custom', customUrl: 'http://10.0.0.1:8080' })
    expect(pool.outbound).toEqual({ mode: 'custom', customUrl: 'http://10.0.0.1:8080' })
    expect(pool.proxyURL({ kind: 'pool' })).toBe('http://10.0.0.1:8080')
  })

  it('节点注册事件按序发布，重复 id 被拒', async () => {
    const pool = await mounted()
    const ctx = contexts[0]!
    const events: string[] = []
    ctx.on('proxy-pool/node', event => events.push(event.kind))
    const dispose = pool.registerNode(parseProxyLink('socks5://1.2.3.4:1080#a'))
    expect(() => pool.registerNode({ ...parseProxyLink('socks5://5.6.7.8:1080#b'), id: pool.listNodes()[0]!.id })).toThrow(/already exists/)
    dispose()
    expect(events).toEqual(['node-added', 'node-removed'])
    expect(pool.listNodes()).toHaveLength(0)
  })

  it('fallback 组优先返回健康节点；无健康信息时回落首位', async () => {
    const { pool, settings } = await mountedWithSettings()
    await settings.update(PROXY_POOL_SETTINGS_NAMESPACE, { mode: 'pool' })
    const a = parseProxyLink('socks5://1.2.3.4:1080#a')
    const b = parseProxyLink('socks5://5.6.7.8:1080#b')
    const disposeA = pool.registerNode(a)
    const disposeB = pool.registerNode(b)
    pool.registerGroup({ id: 'g', name: 'g', members: [a.id, b.id], strategy: 'fallback' })
    pool.useGroup('g')
    expect(pool.proxyURL({ kind: 'pool', groupId: 'g' })).toBe(`http://127.0.0.1:${pool.port}`)
    disposeA()
    disposeB()
    expect(pool.listNodes()).toHaveLength(0)
  })

  it('健康探测对不可达节点给出失败记录并发布事件', async () => {
    const pool = await mounted()
    const ctx = contexts[0]!
    const events: string[] = []
    ctx.on('proxy-pool/node', event => events.push(event.kind))
    const dispose = pool.registerNode(parseProxyLink('http://127.0.0.1:1#dead'))
    const health = await pool.checkNode(pool.listNodes()[0]!.id)
    expect(health).toMatchObject({ alive: false })
    expect(health?.failure).toMatch(/cannot reach proxy node/)
    expect(events).toContain('node-health')
    dispose()
  })
})
