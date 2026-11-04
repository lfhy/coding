import { createServer } from 'node:http'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { requestImage, imageEndpoint } from '../src/openai.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => { resolve() }))
})

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.destroy() }) })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  return `http://127.0.0.1:${address.port}/v1`
}
const signal = new AbortController().signal

const makeRequest = (endpoint: string, sources: Parameters<typeof requestImage>[0]['sources'] = [], key?: string) => requestImage({
  endpoint, model: 'mock-image', prompt: 'Draw a lighthouse', sources, maxBytes: 1024, signal,
  ...key === undefined ? {} : { key },
})

describe('OpenAI-compatible image requests', () => {
  it('rejects insecure network endpoints and credentials in configured URLs', () => {
    for (const endpoint of ['http://192.168.1.10/v1', 'http://example.org/v1',
      'https://10.0.0.1/v1', 'https://localhost.evil.invalid/v1?apiKey=secret',
      'https://user:secret@example.org/v1', 'file:///etc/passwd']) {
      expect(() => imageEndpoint(endpoint, 'generations')).toThrow(TypeError)
    }
    expect(imageEndpoint('http://127.0.0.1:9999/v1', 'edits')).toBe('http://127.0.0.1:9999/v1/images/edits')
    expect(imageEndpoint('https://images.example.org/v1', 'generations')).toBe('https://images.example.org/v1/images/generations')
  })

  it('generates and edits using JSON/multipart, keeping credential out of anonymous requests', async () => {
    const calls: { url: string; auth: string | null; type: string; body: string }[] = []
    const endpoint = await serve(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += Buffer.from(chunk as Uint8Array).toString()
      calls.push({ url: req.url ?? '', auth: req.headers.authorization ?? null,
        type: req.headers['content-type'] ?? '', body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    })
    expect(await makeRequest(endpoint)).toEqual({ data: PNG, mediaType: 'image/png' })
    expect(await makeRequest(endpoint, [{ data: PNG, mediaType: 'image/png' }], 'test-token'))
      .toEqual({ data: PNG, mediaType: 'image/png' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ url: '/v1/images/generations', auth: null, type: 'application/json' })
    expect(JSON.parse(calls[0]!.body)).toEqual({ model: 'mock-image', prompt: 'Draw a lighthouse', n: 1, response_format: 'b64_json' })
    expect(calls[1]).toMatchObject({ url: '/v1/images/edits', auth: 'Bearer test-token' })
    expect(calls[1]!.type).toContain('multipart/form-data')
    expect(calls[1]!.body).toContain('name="image"')
  })

  it('does not follow redirect carrying a bearer secret or prompt', async () => {
    let forwarded = 0
    const target = await serve((_req, res) => { forwarded++; res.end('not allowed') })
    const source = await serve((_req, res) => { res.writeHead(302, { location: `${target}/capture` }); res.end() })
    await expect(makeRequest(source, [], 'secret-should-not-travel')).rejects.toThrow()
    expect(forwarded).toBe(0)
  })

  it('rejects cross-origin image links and excessive encoded output', async () => {
    const foreign = await serve((_req, res) => { res.end(PNG) })
    const endpoint = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ url: `${foreign}/image` }] }))
    })
    await expect(makeRequest(endpoint)).rejects.toThrow(/不受信任/)
    const tooLarge = await serve((_req, res) => { res.end(JSON.stringify({ data: [{ b64_json: 'A'.repeat(4_000) }] })) })
    await expect(makeRequest(tooLarge)).rejects.toThrow(/过大/)
  })
})
