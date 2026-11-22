import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  responseClosed: Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  events?: string[]
  body?: string
  delayMs?: number
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.on('close', () => {
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body ?? '{}')
        return
      }
      if (behavior.body !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) { response.end(); return }
        response.write(`data: ${event}\n\n`)
        if (behavior.delayMs === undefined) writeNext()
        else setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}

/** 将指定虚拟域名的代理请求转至本地模拟服务；该域名不能直连。 */
export async function mockProxy(authority: string, upstream: string): Promise<{
  url: string
  targets: string[]
  close: () => Promise<void>
}> {
  const target = new URL(upstream)
  const targets: string[] = []
  const sockets = new Set<Socket>()
  const proxy = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '')
    } catch {
      response.writeHead(400).end()
      return
    }
    const address = `${url.hostname}:${url.port || '80'}`
    targets.push(address)
    if (address !== authority) {
      response.writeHead(502).end()
      return
    }
    const outgoing = httpRequest(new URL(url.pathname + url.search, target), {
      method: request.method,
      headers: request.headers,
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 500, upstream.headers)
      upstream.pipe(response)
    })
    outgoing.on('error', () => { response.destroy() })
    response.on('close', () => { outgoing.destroy() })
    request.pipe(outgoing)
  })
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  proxy.on('connect', (request, downstream, head) => {
    const address = request.url ?? ''
    targets.push(address)
    if (address !== authority) {
      downstream.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const remote = connect(Number(target.port), target.hostname, () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) remote.write(head)
      remote.pipe(downstream)
      downstream.pipe(remote)
    })
    downstream.on('error', () => { remote.destroy() })
    downstream.on('close', () => { remote.destroy() })
    remote.on('error', () => { downstream.destroy() })
    remote.on('close', () => { downstream.destroy() })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    targets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => proxy.close(() => { resolve() }))
    },
  }
}
