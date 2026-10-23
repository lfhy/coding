/**
 * 渠道级出站契约测试：`toProxyMode` 的模式映射与 `resolveOutboundURL` 在池
 * 缺席／直连／自定义／池四种情况下的地址解析。池行为本身（规则切换、入站地址）
 * 由 `proxy-pool.spec.ts` 覆盖。
 *
 * @module coding-proxy-pool
 */

import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import { afterEach, describe, expect, it } from 'vitest'
import ProxyPoolService, { PROXY_POOL_SETTINGS_NAMESPACE } from '../src/index.ts'
import { resolveOutboundURL, toProxyMode } from '../src/outbound.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** 无盘设置提供方：把池出站分节留在内存里，便于切换池自己的规则。 */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean { return true }

  override get documentPath(): string | undefined { return '/tmp/proxy-pool-outbound-settings.yaml' }

  override prepareDocument(): Promise<string | undefined> { return Promise.resolve(this.documentPath) }

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** 挂一个带设置服务的池并等待入站就绪；`outbound` 写进池自己的设置分节。 */
async function poolWithOutbound(outbound: Record<string, unknown>): Promise<ProxyPoolService> {
  const { pool, settings } = await mountedWithSettings()
  await settings.update(PROXY_POOL_SETTINGS_NAMESPACE, outbound)
  return pool
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

describe('toProxyMode', () => {
  it('maps direct and pool without needing an address', () => {
    expect(toProxyMode({ mode: 'direct' })).toEqual({ kind: 'direct' })
    expect(toProxyMode({ mode: 'pool' })).toEqual({ kind: 'pool' })
  })

  it('maps custom together with its http(s) address', () => {
    expect(toProxyMode({ mode: 'custom', customUrl: 'http://10.0.0.1:8080' }))
      .toEqual({ kind: 'custom', url: 'http://10.0.0.1:8080' })
  })

  it('rejects custom without a usable http(s) address', () => {
    expect(() => toProxyMode({ mode: 'custom' })).toThrow(/custom outbound requires an http\(s\) proxy URL/)
    expect(() => toProxyMode({ mode: 'custom', customUrl: 'socks5://127.0.0.1:1080' }))
      .toThrow(/custom outbound requires an http\(s\) proxy URL/)
  })
})

describe('resolveOutboundURL', () => {
  it('falls back to direct whenever the pool service is absent', () => {
    expect(resolveOutboundURL(undefined, { mode: 'direct' })).toBeUndefined()
    expect(resolveOutboundURL(undefined, { mode: 'pool' })).toBeUndefined()
    // custom 不受池规则影响：池缺席也直接返回消费方自己的地址。
    expect(resolveOutboundURL(undefined, { mode: 'custom', customUrl: 'http://10.0.0.1:8080' }))
      .toBe('http://10.0.0.1:8080')
  })

  it('returns undefined for direct even while the pool runs its own outbound', async () => {
    const pool = await poolWithOutbound({ mode: 'custom', customUrl: 'http://10.0.0.1:8080' })
    expect(resolveOutboundURL(pool, { mode: 'direct' })).toBeUndefined()
  })

  it('returns the consumer address for custom regardless of pool rules', async () => {
    const pool = await poolWithOutbound({ mode: 'direct' })
    expect(resolveOutboundURL(pool, { mode: 'custom', customUrl: 'http://10.0.0.2:8080' }))
      .toBe('http://10.0.0.2:8080')
  })

  it('resolves pool selections through the pool\'s own outbound rule', async () => {
    const direct = await poolWithOutbound({ mode: 'direct' })
    expect(resolveOutboundURL(direct, { mode: 'pool' })).toBeUndefined()

    const custom = await poolWithOutbound({ mode: 'custom', customUrl: 'http://10.0.0.3:8080' })
    expect(resolveOutboundURL(custom, { mode: 'pool' })).toBe('http://10.0.0.3:8080')

    const local = await poolWithOutbound({ mode: 'pool' })
    expect(resolveOutboundURL(local, { mode: 'pool' })).toBe(`http://127.0.0.1:${local.port}`)
  })
})
