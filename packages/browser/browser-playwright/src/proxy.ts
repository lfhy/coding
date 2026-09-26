/** 每个浏览器会话独占的环回 HTTP 代理；每次出站固定经校验的 IP。 @module @deepseek-ai/dsh-browser-playwright/proxy */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { resolveRequestUrl } from './policy.ts'
import type { ResolveAddresses } from './policy.ts'

const TIMEOUT = 30_000
const MAX_INFLIGHT = 32
const HOP_HEADERS = ['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization'] as const

function withoutHopHeaders(headers: Record<string, string | string[] | number | undefined>): Record<string,
  string | string[] | number | undefined> {
  const excluded = new Set<string>(HOP_HEADERS)
  const connection = headers.connection
  for (const token of (Array.isArray(connection) ? connection.join(',') : String(connection ?? '')).split(',')) {
    const name = token.trim().toLowerCase()
    if (name) excluded.add(name)
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())))
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(407, { 'proxy-authenticate': 'Basic realm="browser"', 'content-length': '0', connection: 'close' })
  res.end()
}

function unauthorizedTunnel(client: Duplex): void {
  client.end('HTTP/1.1 407 Proxy Authentication Required\r\n' +
    'Proxy-Authenticate: Basic realm="browser"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
}

function reject(res: ServerResponse, status = 403): void {
  if (status === 403) { res.destroy(); return }
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  res.end('browser proxy unavailable')
}

function authorityMatches(raw: string | undefined, url: URL): boolean {
  if (!raw) return false
  try {
    const parsed = new URL(`${url.protocol}//${raw}`)
    return parsed.host === url.host && parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && !parsed.search && !parsed.hash
  } catch { return false }
}

/** 返回单会话代理；关闭会销毁包括 CONNECT 隧道在内的全部 socket。 */
export async function createBrowserProxy(allowedOrigins: ReadonlySet<string>,
  resolve?: ResolveAddresses): Promise<{ server: string; username: string; password: string; close: () => Promise<void> }> {
  const username = randomBytes(16).toString('hex')
  const password = randomBytes(32).toString('hex')
  const expected = createHash('sha256').update(`${username}:${password}`).digest()
  const authenticated = (header: string | undefined): boolean => {
    if (!header?.startsWith('Basic ')) return false
    const encoded = header.slice(6)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 256) return false
    const provided = Buffer.from(encoded, 'base64')
    const digest = createHash('sha256').update(provided).digest()
    return timingSafeEqual(digest, expected)
  }
  const sockets = new Set<Socket>()
  let closing = false
  const isClosed = (): boolean => closing
  let inflight = 0
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.setTimeout(TIMEOUT, () => { socket.destroy() })
    socket.on('close', () => { sockets.delete(socket) })
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void forward(req, res) })
  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) { reject(res, 503); return }
    if (++inflight > MAX_INFLIGHT) { inflight--; reject(res, 503); return }
    res.once('close', () => { inflight-- })
    try {
      if (!authenticated(req.headers['proxy-authorization'])) { unauthorized(res); return }
      // 代理只接受绝对形式；Host 必须与目的地一致，不能借 header 发往另一处。
      if (req.headers.upgrade || !req.url || !/^http:\/\/[^/]+(?:\/|$)/i.test(req.url)) {
        reject(res); return
      }
      const { url, address } = await resolveRequestUrl(req.url, allowedOrigins, resolve)
      if (isClosed() || res.destroyed || !authorityMatches(req.headers.host, url)) { reject(res); return }
      const headers = withoutHopHeaders({ ...req.headers, host: url.host })
      const upstream = httpRequest({ hostname: address, family: address.includes(':') ? 6 : 4,
        port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`,
        headers, agent: false, timeout: TIMEOUT }, (response) => {
        if (res.destroyed) { response.destroy(); return }
        res.writeHead(response.statusCode ?? 502, withoutHopHeaders(response.headers))
        response.pipe(res)
      })
      res.once('close', () => { upstream.destroy() })
      upstream.on('socket', track)
      upstream.on('timeout', () => { upstream.destroy() })
      upstream.on('error', () => { reject(res, 502) })
      req.on('aborted', () => { upstream.destroy() })
      req.pipe(upstream)
    } catch { reject(res) }
  }
  server.on('connection', track)
  server.on('upgrade', (_req, socket) => { socket.destroy() })
  server.on('connect', (req, client, head) => { void tunnel(req, client, head) })
  async function tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (closing) { client.destroy(); return }
    if (++inflight > MAX_INFLIGHT) { inflight--; client.destroy(); return }
    client.once('close', () => { inflight-- })
    try {
      if (!authenticated(req.headers['proxy-authorization'])) { unauthorizedTunnel(client); return }
      const authority = req.url ?? ''
      if (!authority || authority.includes('/') || authority.includes('@') ||
        !/:(?:[1-9][0-9]{0,4})$/.test(authority) ||
        !authorityMatches(authority, new URL(`https://${authority}/`))) { client.destroy(); return }
      const { address, url } = await resolveRequestUrl(`https://${authority}/`, allowedOrigins, resolve)
      if (isClosed() || client.destroyed || !authorityMatches(req.headers.host, url)) { client.destroy(); return }
      const upstream = connect({ host: address, port: Number(url.port || 443),
        family: address.includes(':') ? 6 : 4 })
      track(upstream)
      upstream.once('connect', () => {
        if (closing || client.destroyed) { upstream.destroy(); return }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => { client.destroy() })
      client.on('error', () => { upstream.destroy() })
      client.on('close', () => { upstream.destroy() })
    } catch { client.destroy() }
  }
  server.on('clientError', (_error, socket) => { socket.destroy() })
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
    })
  } catch (error) { server.close(); throw error }
  const port = (server.address() as AddressInfo).port
  return {
    server: `http://127.0.0.1:${port}`,
    username, password,
    close: async () => {
      if (closing) return
      closing = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => { server.close(() => { done() }) })
    },
  }
}
