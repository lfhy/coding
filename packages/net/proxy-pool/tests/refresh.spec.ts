/**
 * 订阅刷新测试：feed 解析、镜像回退与增量替换语义（用假 fetch/假池隔离网络）。
 */

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEEDS, fetchFeed, refreshPoolNodes } from '../src/refresh.ts'
import type { ProxyFeed, RefreshOptions } from '../src/refresh.ts'
import type { ProxyNode } from '../src/types.ts'
import { parseProxyLink } from '../src/links.ts'

/** 程序化 fetch 桩：按 URL 前缀返回文本或抛错。 */
function fakeFetch(routes: { match: string; body?: string; status?: number; error?: Error }[], calls: string[] = []) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    for (const route of routes) {
      if (!url.includes(route.match)) continue
      if (route.error !== undefined) throw route.error
      return new Response(route.body ?? '', { status: route.status ?? 200 })
    }
    return new Response('', { status: 404 })
  }
}

/** 假池：内存注册表 + 可编程探测结果。 */
function fakePool(alive: (node: ProxyNode) => boolean) {
  const nodes = new Map<string, ProxyNode>()
  const events: string[] = []
  return {
    nodes,
    events,
    listNodes: () => [...nodes.values()],
    registerNode: (node: ProxyNode) => {
      nodes.set(node.id, node)
      events.push(`+${node.name}`)
      return () => { nodes.delete(node.id); events.push(`-${node.name}`) }
    },
    unregisterNode: (id: string) => {
      const node = nodes.get(id)
      if (node === undefined) return false
      nodes.delete(id)
      events.push(`-${node.name}`)
      return true
    },
    renameNode: (id: string, name: string) => {
      const node = nodes.get(id)
      if (node === undefined) return
      nodes.set(id, { ...node, name })
    },
    checkNode: vi.fn(async (id: string) => {
      const node = nodes.get(id)
      if (node === undefined) return undefined
      return { alive: alive(node) }
    }),
  }
}

describe('fetchFeed', () => {
  it('直连失败时降级到镜像前缀', async () => {
    const calls: string[] = []
    const feed: ProxyFeed = { id: 't', url: 'https://raw.githubusercontent.com/x/y/main/z', kind: 'links' }
    const stub = fakeFetch([
      { match: 'gh-proxy.com', body: 'ok-body' },
      { match: 'raw.githubusercontent.com', error: new Error('direct blocked') },
    ], calls)
    const original = globalThis.fetch
    globalThis.fetch = stub
    try {
      const body = await fetchFeed(feed)
      expect(body).toBe('ok-body')
      expect(calls[0]?.startsWith('https://raw.githubusercontent.com')).toBe(true)
      expect(calls[1]?.startsWith('https://gh-proxy.com/')).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('全部形态失败时抛出最后一个错误', async () => {
    const feed: ProxyFeed = { id: 't', url: 'https://raw.githubusercontent.com/x/y/main/z', kind: 'links' }
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch([{ match: '', error: new Error('all down') }])
    try {
      await expect(fetchFeed(feed)).rejects.toThrow('all down')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('refreshPoolNodes', () => {
  const options: RefreshOptions = { targetCount: 2, concurrency: 2, probeTimeoutMs: 50 }

  it('订阅候选探测通过者入池、手工节点不动', async () => {
    const feed: ProxyFeed = { id: 'f', url: 'https://raw.githubusercontent.com/f', kind: 'links' }
    const body = ['1.1.1.1:8080', '2.2.2.2:8080', '3.3.3.3:8080'].join('\n')
    const original = globalThis.fetch
    const feedModule = await import('../src/refresh.ts')
    const spy = vi.spyOn(feedModule as unknown as { DEFAULT_FEEDS: ProxyFeed[] }, 'DEFAULT_FEEDS', 'get')
    spy.mockReturnValue([feed])
    globalThis.fetch = fakeFetch([{ match: 'raw.githubusercontent.com', body }])
    try {
      const pool = fakePool(node => !node.address.startsWith('3'))
      const manual = parseProxyLink('socks5://9.9.9.9:1080#我的节点')
      pool.registerNode(manual)
      const result = await refreshPoolNodes(pool, options)
      expect(result.admitted.map(node => node.address).sort()).toEqual(['1.1.1.1', '2.2.2.2'])
      // 池里保留：手工节点 + 两个 feed 节点（feed: 前缀）。
      const names = pool.listNodes().map(node => node.name).sort()
      expect(names).toEqual(['feed:1.1.1.1', 'feed:2.2.2.2', '我的节点'])
    } finally {
      globalThis.fetch = original
      spy.mockRestore()
    }
  })

  it('上一轮的 feed 节点在新一轮候选消失时被移除', async () => {
    const feed: ProxyFeed = { id: 'f', url: 'https://raw.githubusercontent.com/f', kind: 'links' }
    const original = globalThis.fetch
    const feedModule = await import('../src/refresh.ts')
    const spy = vi.spyOn(feedModule as unknown as { DEFAULT_FEEDS: ProxyFeed[] }, 'DEFAULT_FEEDS', 'get')
    spy.mockReturnValue([feed])
    const pool = fakePool(() => true)
    try {
      globalThis.fetch = fakeFetch([{ match: 'raw', body: '1.1.1.1:8080' }])
      await refreshPoolNodes(pool, options)
      expect(pool.listNodes().map(node => node.name)).toEqual(['feed:1.1.1.1'])
      // 下一轮换地址：旧 feed 地址不再出现，应被移除。
      globalThis.fetch = fakeFetch([{ match: 'raw', body: '5.5.5.5:8080' }])
      const second = await refreshPoolNodes(pool, options)
      expect(second.evicted).toHaveLength(1)
      expect(pool.listNodes().map(node => node.name)).toEqual(['feed:5.5.5.5'])
    } finally {
      globalThis.fetch = original
      spy.mockRestore()
    }
  })

  it('全部源失败时返回失败摘要且不动池', async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch([{ match: '', error: new Error('network down') }])
    try {
      const pool = fakePool(() => true)
      const manual = parseProxyLink('socks5://9.9.9.9:1080#我的节点')
      pool.registerNode(manual)
      const result = await refreshPoolNodes(pool, options)
      expect(result.admitted).toEqual([])
      expect(result.failures.some(message => message.includes('network down'))).toBe(true)
      expect(pool.listNodes()).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('内置源清单非空且都指向 raw 目录', () => {
    expect(DEFAULT_FEEDS.length).toBeGreaterThan(0)
    for (const feed of DEFAULT_FEEDS) {
      expect(feed.url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
    }
  })
})
