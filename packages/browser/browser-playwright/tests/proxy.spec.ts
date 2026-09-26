import { createServer, request } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createBrowserProxy } from '../src/proxy.ts'

describe('browser IP-pinned proxy', () => {
  it('forwards to the selected IP without resolving the hostname again and keeps Host', async () => {
    let hits = 0
    let receivedHeaders: Record<string, unknown> = {}
    const target = createServer((req, res) => {
      hits++
      receivedHeaders = req.headers
      res.setHeader('connection', 'X-Response')
      res.setHeader('x-response', 'secret')
      res.setHeader('te', 'trailers')
      res.end(req.headers.host)
    })
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve) })
    const port = (target.address() as AddressInfo).port
    const origin = `http://no-dns-record.invalid:${port}`
    let resolutions = 0
    const proxy = await createBrowserProxy(new Set([origin]), async () => {
      resolutions++
      return [{ address: '127.0.0.1' }]
    })
    try {
      const send = (authorization?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> =>
        new Promise((resolve, reject) => {
          const req = request(proxy.server, { path: `${origin}/test`, headers: {
            host: `no-dns-record.invalid:${port}`, connection: 'X-Request', 'x-request': 'secret',
            te: 'trailers', 'proxy-connection': 'keep-alive',
            ...(authorization ? { 'proxy-authorization': authorization } : {}),
          } },
          (res) => {
            let body = ''
            res.on('data', (chunk: Buffer) => { body += chunk.toString() })
            res.on('end', () => { resolve({ status: res.statusCode ?? 0, body, headers: res.headers }) })
          })
          req.on('error', reject)
          req.end()
        })
      expect((await send()).status).toBe(407)
      expect((await send('Basic Zm9vOmJhcg==')).status).toBe(407)
      expect(hits).toBe(0)
      const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
      const result = await send(auth)
      expect(result).toMatchObject({ status: 200, body: `no-dns-record.invalid:${port}` })
      expect(result.headers['x-response']).toBeUndefined()
      expect(result.headers.te).toBeUndefined()
      expect(receivedHeaders['x-request']).toBeUndefined()
      expect(receivedHeaders.te).toBeUndefined()
      expect(receivedHeaders['proxy-authorization']).toBeUndefined()
      expect(receivedHeaders.host).toBe(`no-dns-record.invalid:${port}`)
      expect(resolutions).toBe(1)
      expect(hits).toBe(1)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
    }
  })

  it('requires credentials for CONNECT and closes an authenticated IP-pinned tunnel', async () => {
    let hits = 0
    const target = createTcpServer((socket) => {
      hits++
      socket.on('data', (chunk: Buffer) => { socket.write(chunk) })
    })
    await new Promise<void>((resolve) => { target.listen(0, '127.0.0.1', resolve) })
    const port = (target.address() as AddressInfo).port
    const authority = `no-dns-record.invalid:${port}`
    const proxy = await createBrowserProxy(new Set([`https://${authority}`]), async () => [{ address: '127.0.0.1' }])
    try {
      const connect = (authorization?: string): Promise<number> => new Promise((resolve, reject) => {
        const req = request(proxy.server, { method: 'CONNECT', path: authority,
          headers: { host: authority, ...(authorization ? { 'proxy-authorization': authorization } : {}) } })
        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) { socket.destroy(); resolve(res.statusCode ?? 0); return }
          socket.once('data', (data: Buffer) => {
            expect(data.toString()).toBe('hello')
            socket.destroy()
            resolve(200)
          })
          socket.write('hello')
          socket.once('error', reject)
        })
        req.on('error', reject)
        req.end()
      })
      expect(await connect()).toBe(407)
      expect(await connect('Basic Zm9vOmJhcg==')).toBe(407)
      expect(hits).toBe(0)
      const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
      expect(await connect(auth)).toBe(200)
      expect(hits).toBe(1)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => { target.close(() => { resolve() }) })
    }
  })
})
