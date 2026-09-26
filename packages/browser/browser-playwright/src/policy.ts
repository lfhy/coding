/** 页面导航及所有网络请求的公共地址策略。 @module @deepseek-ai/dsh-browser-playwright/policy */

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { BrowserUseError } from '@deepseek-ai/dsh-browser'

function denied(message: string): BrowserUseError {
  return new BrowserUseError(message, 'BROWSER_DENIED')
}

const blockedV6 = new BlockList()
blockedV6.addSubnet('2001::', 23, 'ipv6') // 特殊用途块：Teredo、基准测试及协议分配。
blockedV6.addSubnet('2001:db8::', 32, 'ipv6')
blockedV6.addSubnet('2002::', 16, 'ipv6') // 6to4
blockedV6.addSubnet('3fff::', 20, 'ipv6') // 文档地址。

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number)
    const [a, b, c] = octets
    if (a === undefined || b === undefined || c === undefined) return false
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && c === 0) ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
      a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 ||
      a === 203 && b === 0 && c === 113)
  }
  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(':', 1)[0] ?? '', 16)
    return first >= 0x2000 && first <= 0x3fff && !blockedV6.check(address, 'ipv6')
  }
  return false
}

/** 校验部署显式授予的精确 HTTP(S) origin；不接受凭据、路径或通配符。 */
export function validateAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const accepted = new Set<string>()
  for (const raw of origins) {
    let parsed: URL
    try { parsed = new URL(raw) } catch { throw denied(`invalid allowed origin: ${raw}`) }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== raw || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) throw denied(`invalid allowed origin: ${raw}`)
    accepted.add(raw)
  }
  return accepted
}

/** DNS 必须全部解析为公网地址；任一失败或非公网答案均拒绝。 */
export type ResolveAddresses = (hostname: string) => Promise<readonly { address: string }[]>
const resolveAddresses: ResolveAddresses = hostname => lookup(hostname, { all: true, order: 'verbatim' })

/** 返回经过一次 DNS 校验的 IP；调用方必须直接连接该 IP，不能再以主机名拨号。 */
export async function resolveRequestUrl(raw: string, allowedOrigins: ReadonlySet<string>,
  resolve: ResolveAddresses = resolveAddresses): Promise<{ url: URL; address: string }> {
  let url: URL
  try { url = new URL(raw) } catch { throw new BrowserUseError(`invalid browser URL: ${raw}`, 'BROWSER_INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied(`browser URL denied: ${raw}`)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) {
    if (!allowedOrigins.has(url.origin) && !publicAddress(hostname)) throw denied(`browser address denied: ${hostname}`)
    return { url, address: hostname }
  }
  if (!allowedOrigins.has(url.origin) && (!hostname || hostname === 'localhost' ||
    hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    throw denied(`browser host denied: ${hostname}`)
  }
  let addresses: readonly { address: string }[]
  try { addresses = await resolve(hostname) }
  catch (error) { throw new BrowserUseError(`browser DNS validation unavailable: ${hostname}`, 'BROWSER_DENIED', { cause: error }) }
  if (!addresses.length || addresses.some(item => !isIP(item.address) ||
    !allowedOrigins.has(url.origin) && !publicAddress(item.address))) throw denied(`browser host denied: ${hostname}`)
  return { url, address: addresses[0]?.address ?? '' }
}

/** 提前拒绝无效导航；实际出站校验以代理逐次解析、固定 IP 的结果为准。 */
export async function validateRequestUrl(raw: string, allowedOrigins: ReadonlySet<string>): Promise<URL> {
  return (await resolveRequestUrl(raw, allowedOrigins)).url
}
