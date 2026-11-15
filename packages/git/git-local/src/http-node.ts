/**
 * isomorphic-git 的 Node HTTP 适配器：直接用 `node:http(s)` 传输，不经过第三方请求库。
 * 这样克隆可以按调用方的信号中止，也不受通用请求库对长连接与空闲超时的默认策略影响；
 * 需要代理时经 `coding-proxy-pool` 的拨号器建立隧道，支持 HTTP(S) 与 SOCKS5 前向代理。
 * @module coding-git-local/http-node
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git'
import { dialThrough, parseProxyLink } from 'coding-proxy-pool'

export type { GitHttpRequest, GitHttpResponse, HttpClient }

/** 一次克隆使用的代理配置；地址在每次请求时解析。 */
export interface GitHttpProxy {
  /** 代理地址：`http://`、`https://` 或 `socks5://`，可带用户名与密码。 */
  url: string
}

/** 把响应头压平成单值字符串表；同名多值按逗号连接，与 fetch 的语义一致。 */
function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    flat[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return flat
}

/** 按块产出响应体；调用方中途停止读取时销毁连接。 */
async function* readBody(response: IncomingMessage): AsyncGenerator<Uint8Array> {
  for await (const chunk of response) yield chunk as Uint8Array
}

/**
 * 读环境里为该目标协议配置的代理地址。
 * @param protocol - 目标连接的协议。
 * @returns `HTTPS_PROXY`／`HTTP_PROXY`／`ALL_PROXY`（含小写拼写）中的第一个非空值。
 */
export function proxyFromEnv(protocol: string): string | undefined {
  const names = protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * `NO_PROXY` 是否排除了该主机。
 * @param hostname - 目标主机名。
 * @param noProxy - 环境变量原文；支持 `*`、域名后缀与可选的 `:port` 后缀。
 * @returns 匹配时返回 true，表示这次连接应当直连。
 */
export function bypassedByNoProxy(hostname: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false
  const host = hostname.toLowerCase()
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const name = entry.replace(/:\d+$/u, '')
    const bare = name.startsWith('.') ? name.slice(1) : name
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

/**
 * 把 https 目标套上 TLS：代理只提供到目标的裸 TCP，握手仍由本进程完成。
 * @param socket - 已建立的隧道套接字。
 * @param servername - 证书校验与 SNI 使用的主机名。
 * @returns 完成握手后的 TLS 套接字。
 */
function secureTunnel(socket: Duplex, servername: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername })
    secure.once('secureConnect', () => { secure.removeAllListeners('error'); resolve(secure) })
    secure.once('error', reject)
  })
}

/**
 * 创建面向 isomorphic-git 的 HTTP 客户端。
 * @param options - `timeoutMs` 是单次请求的空闲超时（小于等于 0 表示只依赖调用方信号），
 * `proxy` 给出时所有请求都经该前向代理；省略时代理仍可来自 `HTTPS_PROXY`／`ALL_PROXY` 环境变量。
 * @returns 可传给 `git.clone({ http })` 的客户端。
 */
export function createNodeHttpClient(options: { timeoutMs?: number; proxy?: GitHttpProxy } = {}): HttpClient {
  const timeoutMs = options.timeoutMs ?? 0
  return {
    request: async (request) => {
      const { protocol, hostname, port, pathname, search } = new URL(request.url)
      const proxyUrl = options.proxy?.url ?? proxyFromEnv(protocol)
      const proxy = proxyUrl !== undefined && !bypassedByNoProxy(hostname, process.env.NO_PROXY ?? process.env.no_proxy)
        ? proxyUrl
        : undefined
      // 走代理时先建立到目标的隧道，再把这条套接字交给 http(s) 客户端；目标为
      // https 时 TLS 由本进程完成，代理只看到密文。
      const tunnel = proxy === undefined
        ? undefined
        : await (async () => {
          const dialed = await dialThrough(parseProxyLink(proxy), {
            host: hostname,
            port: Number(port === '' ? (protocol === 'https:' ? 443 : 80) : port),
            ...request.signal === undefined ? {} : { signal: request.signal },
          })
          return protocol === 'https:' ? secureTunnel(dialed, hostname) : dialed
        })()
      // 隧道套接字交给一次性 Agent：`options.createConnection` 只在没有 Agent 时生效，
      // 而直连路径仍走默认 Agent 的连接复用。https 目标此时已是 TLS 流，明文请求写进去即可。
      const tunnelAgent = tunnel === undefined ? undefined : (() => {
        const created = new HttpAgent({ keepAlive: false })
        created.createConnection = () => tunnel
        return created
      })()
      const transport = tunnelAgent === undefined && protocol === 'https:' ? httpsRequest : httpRequest
      const requestOptions: RequestOptions = {
        hostname,
        ...port === '' ? {} : { port: Number(port) },
        path: `${pathname}${search}`,
        method: request.method ?? 'GET',
        headers: { 'user-agent': 'git/coding', ...request.headers },
        ...tunnelAgent === undefined ? {} : { agent: tunnelAgent },
      }
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = transport(requestOptions, resolve)
        outgoing.once('error', reject)
        if (timeoutMs > 0) outgoing.setTimeout(timeoutMs, () => { outgoing.destroy(new Error('Git HTTP request timed out')) })
        request.signal?.addEventListener('abort', () => { outgoing.destroy(new Error('Git HTTP request was cancelled')) }, { once: true })
        // 请求体按块写入：克隆的上传请求会带上 wants 列表，可能由多个分片组成。
        void (async () => {
          const body = request.body
          if (body === undefined) { outgoing.end(); return }
          try {
            for await (const chunk of body as AsyncIterable<Uint8Array>) outgoing.write(chunk)
            outgoing.end()
          } catch (error: unknown) {
            outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      })
      return {
        url: request.url,
        ...request.method === undefined ? {} : { method: request.method },
        headers: flattenHeaders(response.headers),
        body: readBody(response),
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
      }
    },
  }
}
