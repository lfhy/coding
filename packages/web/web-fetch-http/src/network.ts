/**
 * web-fetch-http 的公开网络解析与地址固定 HTTP 传输。Undici 收到请求前先校验
 * 一次完整 DNS 结果，并通过自定义 lookup 固定地址，避免连接再次把 hostname
 * 解析到私有地址。
 *
 * @module @deepseek-ai/dsh-web-fetch-http/network
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch } from 'undici'
import type { Response } from 'undici'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** 已解析并为后续固定连接保留的地址。 */
export interface PublicAddress {
  /** 规范化的 IPv4 或 IPv6 文本地址。 */
  readonly address: string
  /** Node 连接 lookup 回调接受的地址族。 */
  readonly family: 4 | 6
}

/** 一次地址固定请求的结果；关闭时释放该请求的私有连接池。 */
export interface PinnedResponse {
  /** HTTP 响应；调用 close() 前仍可读取其主体。 */
  readonly response: Response
  /** 响应主体消费或取消后释放请求 dispatcher。 */
  close(): Promise<void>
}

/** 用于测试公开地址策略的解析器签名，不修改进程级 DNS。 */
export type AddressResolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** RFC 6052 中可能承载 NAT64 IPv4 目的地址的前缀长度。 */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: typeof RFC6052_PREFIX_LENGTHS[number]
}

/**
 * 判断地址是否为全球可达的单播地址。IPv4-mapped IPv6 按嵌入的 IPv4 地址分类；
 * 无法确定最终 IPv4 目的地的特殊转换前缀由上层 DNS64 检查继续阻断。
 *
 * @param input - IPv4 或 IPv6 文本地址。
 * @returns 仅当地址是公开单播目的地时返回 true。
 */
export function isPublicIpAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input))
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * 只解析一次 hostname；任一目的地址不是公开地址时拒绝完整结果。
 * 返回的地址是传输层唯一可以使用的集合。
 *
 * @param hostname - URL hostname，IPv6 字面量包含方括号。
 * @param signal - 中止等待系统解析；进行中的 OS lookup 可能完成但不会被使用。
 * @param resolver - lookup 实现，仅由聚焦测试覆盖。
 * @returns 通过校验的非空地址集合。
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  resolver: AddressResolver = systemLookup,
): Promise<PublicAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const hasIpv6 = resolved.some(entry => entry.family === 6 && isIP(entry.address) === 6)
  const nat64Prefixes = hasIpv6
    ? await discoverNat64Prefixes(signal, resolver)
    : []

  const addresses: PublicAddress[] = []
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPublicIpAddress(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes)
    if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
      throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
    }
    addresses.push({ address: entry.address, family: entry.family })
  }
  return addresses
}

/** 通过 RFC 7050 保留 hostname 发现当前 DNS64 前缀集合。 */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(
    resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }),
    signal,
  )
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${String(length)}:${prefixBytes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

/** 返回匹配已发现前缀的 IPv6 地址所承载的 RFC 6052 IPv4 地址。 */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
    const embedded = embeddedIpv4Address(bytes, prefix.length)
    if (embedded !== undefined) return embedded
  }
  return undefined
}

/** 从 RFC 6052 IPv6 布局中提取一个 IPv4 地址。 */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix['length']): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = prefixLength / 8
  const beforeReservedOctet = 8 - prefixBytes
  const ipv4 = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
    ...bytes.slice(9, 9 + 4 - beforeReservedOctet),
  ]
  return ipv4.join('.')
}

/**
 * 通过 Undici agent 获取资源，lookup 回调只返回已经校验过的地址集合。
 * URL hostname 保持不变，继续作为 HTTP Host 与 TLS SNI。
 *
 * @param url - 已校验的 HTTP(S) URL。
 * @param addresses - resolvePublicAddresses 返回的公开地址。
 * @param headers - 请求标头。
 * @param signal - 请求和主体读取的取消 signal。
 * @returns 响应及其消费者必须调用的 dispatcher 释放函数。
 */
export async function requestPinned(
  url: URL,
  addresses: readonly PublicAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const dispatcher = new Agent({
    autoSelectFamily: true,
    connect: { lookup: createPinnedLookup(addresses) },
  })
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
    return { response, close: async () => { await dispatcher.close() } }
  } catch (error: unknown) {
    await dispatcher.close()
    throw error
  }
}

/** 将生产网络操作集中为对象，便于提供方测试只替换解析步骤。 */
export const publicHttpNetwork = {
  resolve: resolvePublicAddresses,
  request: requestPinned,
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * 构造只提供固定已校验地址集合的连接器 lookup。
 *
 * @param addresses - 上一步解析后保留的公开地址。
 * @returns 与 Node 兼容且不会再次进行网络解析的 lookup 回调。
 */
export function createPinnedLookup(addresses: readonly PublicAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = typeof options.family === 'number'
      ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family)
    const selected = eligible[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
        code: 'ENOTFOUND',
        hostname,
      })
      callback(error, options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ ...address })))
      return
    }
    callback(null, selected.address, selected.family)
  }
}

/** 与不可取消的 OS lookup 竞速，但不让它拖延工具取消。 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** WHATWG URL 会保留 IPv6 hostname 的方括号，而 IP 解析器不会。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
