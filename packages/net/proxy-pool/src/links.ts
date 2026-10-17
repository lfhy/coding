/**
 * 分享链接解析：把 `vless://`/`vmess://`/`hy2://`/`ss://`/`http(s)-proxy` 形态的
 * URI 解析成 {@link ProxyNode} 描述符。
 *
 * 语法以各客户端通用约定为准（v2rayN、Clash 订阅导出的链接形状）；解析在
 * 本模块失败并给出具体诊断，不猜测缺失字段。VMess 的 base64 JSON 形态与
 * 查询参数形态都接受。
 *
 * @module coding-proxy-pool/links
 */

import { randomUUID } from 'node:crypto'
import type { ProxyNode, ProxyProtocol, ProxyTransport, ProxyTls } from './types.ts'
import { ProxyPoolError } from './types.ts'

/** 生成一个池内唯一的节点 id。 */
function newNodeId(): string {
  return randomUUID()
}

/** 查询参数里的整数端口。 */
function portOf(value: string | undefined, source: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyPoolError(`invalid port in proxy link: ${source}`, 'PROXY_LINK_INVALID')
  }
  return port
}

/** 查询参数里的布尔值（`1`/`true` 视为真）。 */
function flagOf(params: URLSearchParams, key: string): boolean {
  const value = params.get(key)
  return value === '1' || value === 'true'
}

/** TLS 字段：仅当链接声明了 tls/insecure/sni 时出现。 */
function tlsOf(params: URLSearchParams, address: string): ProxyTls | undefined {
  const serverName = params.get('sni') ?? params.get('peer') ?? undefined
  const allowInsecure = flagOf(params, 'allowInsecure') || flagOf(params, 'insecure')
  return serverName !== undefined || allowInsecure
    ? { serverName: serverName ?? address, ...allowInsecure ? { allowInsecure } : {} }
    : undefined
}

/** WebSocket 传输：路径与可选自定义头。 */
function wsOf(params: URLSearchParams): ProxyTransport {
  const headers: Record<string, string> = {}
  const host = params.get('host')
  if (host !== null) headers.Host = host
  return { type: 'ws', ws: { path: params.get('path') ?? '/', ...Object.keys(headers).length > 0 ? { headers } : {} } }
}

/**
 * 解析一条分享链接为节点描述符。
 * @param raw - 链接原文；首尾空白会被去除。
 * @returns 新铸造的节点描述符（id 已生成）。
 * @throws ProxyPoolError `PROXY_LINK_INVALID` 链接形态不合法或不支持。
 */
export function parseProxyLink(raw: string): ProxyNode {
  const source = raw.trim()
  if (source.length === 0) {
    throw new ProxyPoolError('proxy link is empty', 'PROXY_LINK_INVALID')
  }
  if (source.startsWith('vless://')) return parseVless(source)
  if (source.startsWith('vmess://')) return parseVmess(source)
  if (source.startsWith('hy2://') || source.startsWith('hysteria2://')) return parseHysteria2(source)
  if (source.startsWith('socks5://') || source.startsWith('http://') || source.startsWith('https://')) {
    return parseClassic(source)
  }
  throw new ProxyPoolError(`unsupported proxy link scheme: ${source.slice(0, 24)}`, 'PROXY_LINK_INVALID')
}

/** `vless://uuid@host:port?tls=1&type=ws&path=/p&sni=h#name` */
function parseVless(source: string): ProxyNode {
  const url = new URL(source)
  const secret = decodeURIComponent(url.username)
  if (secret.length === 0) {
    throw new ProxyPoolError(`vless link is missing its user id: ${source.slice(0, 32)}`, 'PROXY_LINK_INVALID')
  }
  const params = url.searchParams
  const transport = (params.get('type') ?? 'tcp') === 'ws' ? wsOf(params) : { type: 'tcp' } as const
  return {
    id: newNodeId(),
    name: decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
    protocol: 'vless',
    address: url.hostname,
    port: portOf(url.port || undefined, source),
    secret,
    ...tlsOf(params, url.hostname) !== undefined || flagOf(params, 'tls') || flagOf(params, 'security')
      ? { tls: tlsOf(params, url.hostname) ?? { serverName: url.hostname } }
      : {},
    transport,
  }
}

/** `vmess://` 的 base64 JSON 形态（v2rayN 导出）。 */
function parseVmess(source: string): ProxyNode {
  const encoded = source.slice('vmess://'.length)
  let decoded: string
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    throw new ProxyPoolError(`vmess link is not valid base64: ${source.slice(0, 32)}`, 'PROXY_LINK_INVALID')
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(decoded) as Record<string, unknown>
  } catch {
    throw new ProxyPoolError(`vmess link payload is not JSON: ${decoded.slice(0, 32)}`, 'PROXY_LINK_INVALID')
  }
  const address = typeof json.add === 'string' ? json.add : undefined
  const secret = typeof json.id === 'string' ? json.id : undefined
  if (address === undefined || secret === undefined) {
    throw new ProxyPoolError('vmess link payload is missing add/id', 'PROXY_LINK_INVALID')
  }
  const port = Number(json.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyPoolError(`vmess link payload has an invalid port: ${String(json.port)}`, 'PROXY_LINK_INVALID')
  }
  const tlsOn = json.tls === 'tls' || json.tls === true
  const transport = json.net === 'ws'
    ? ({ type: 'ws', ws: { path: typeof json.path === 'string' && json.path.length > 0 ? json.path : '/' } } as ProxyTransport)
    : ({ type: 'tcp' } as const)
  return {
    id: newNodeId(),
    name: typeof json.ps === 'string' && json.ps.length > 0 ? json.ps : `${address}:${port}`,
    protocol: 'vmess',
    address,
    port,
    secret,
    ...Number.isInteger(json.aid) ? { alterId: json.aid as number } : { alterId: 0 },
    ...tlsOn ? { tls: { serverName: typeof json.sni === 'string' && json.sni.length > 0 ? json.sni : address } } : {},
    transport,
  }
}

/** `hy2://[auth@]host:port?sni=h&insecure=1#name` */
function parseHysteria2(source: string): ProxyNode {
  const url = new URL(source)
  const secret = url.username.length > 0 ? decodeURIComponent(url.username) : undefined
  const params = url.searchParams
  const sni = params.get('sni') ?? undefined
  const allowInsecure = flagOf(params, 'insecure')
  return {
    id: newNodeId(),
    name: decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
    protocol: 'hysteria2',
    address: url.hostname,
    port: portOf(url.port || undefined, source),
    ...(secret !== undefined ? { secret } : {}),
    tls: { serverName: sni ?? url.hostname, ...allowInsecure ? { allowInsecure } : {} },
  }
}

/** `socks5://user:pass@host:port` 与 `http(s)://user:pass@host:port`。 */
function parseClassic(source: string): ProxyNode {
  const url = new URL(source)
  const protocol: ProxyProtocol = source.startsWith('socks5://') ? 'socks5' : 'http'
  return {
    id: newNodeId(),
    name: decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
    protocol,
    address: url.hostname,
    port: portOf(url.port || undefined, source),
    ...url.username.length > 0 ? { username: decodeURIComponent(url.username) } : {},
    ...url.password.length > 0 ? { secret: decodeURIComponent(url.password) } : {},
  }
}

/**
 * 解析一段多行文本里的全部链接；无法解析的行跳过并计入返回的失败数。
 * @param text - 订阅文本或逐行链接。
 * @returns 成功解析的节点与被跳过的行数。
 */
export function parseProxyLinks(text: string): { nodes: ProxyNode[]; skipped: number } {
  const nodes: ProxyNode[] = []
  let skipped = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      nodes.push(parseProxyLink(trimmed))
    } catch {
      skipped += 1
    }
  }
  return { nodes, skipped }
}
