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
  it('accepts HTTP(S) network endpoints with authentication and rejects malformed configured URLs', () => {
    expect(imageEndpoint('http://192.168.1.10/v1', 'generations')).toBe('http://192.168.1.10/v1/images/generations')
    expect(imageEndpoint('http://example.org/v1', 'generations')).toBe('http://example.org/v1/images/generations')
    expect(imageEndpoint('https://10.0.0.1/v1', 'generations')).toBe('https://10.0.0.1/v1/images/generations')
    for (const endpoint of ['https://localhost.evil.invalid/v1?apiKey=secret',
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

  it('forwards selected size and quality to generations JSON and edits multipart', async () => {
    const requests: { path: string; body: string }[] = []
    const endpoint = await serve(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += Buffer.from(chunk as Uint8Array).toString()
      requests.push({ path: req.url ?? '', body })
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    })
    const output = { endpoint, model: 'mock-image', prompt: 'test', maxBytes: 1024, signal,
      size: '1536x1024', quality: 'high' }
    await requestImage({ ...output, sources: [] })
    await requestImage({ ...output, sources: [{ data: PNG, mediaType: 'image/png' }] })
    await requestImage({ ...output, sources: [{ data: PNG, mediaType: 'image/png' }, { data: PNG, mediaType: 'image/png' }] })
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ size: '1536x1024', quality: 'high' })
    expect(requests[1]!.body).toContain('name="size"')
    expect(requests[1]!.body).toContain('1536x1024')
    expect(requests[1]!.body).toContain('name="quality"')
    expect(requests[1]!.body).toContain('high')
    expect(requests[2]!.body.match(/name="image\[\]"/gu)).toHaveLength(2)
  })

  it('does not follow redirect carrying a bearer secret or prompt', async () => {
    let forwarded = 0
    const target = await serve((_req, res) => { forwarded++; res.end('not allowed') })
    const source = await serve((_req, res) => { res.writeHead(302, { location: `${target}/capture` }); res.end() })
    await expect(makeRequest(source, [], 'secret-should-not-travel')).rejects.toThrow()
    expect(forwarded).toBe(0)
  })

  it('accepts cross-origin loopback links but rejects excessive encoded output', async () => {
    let receivedAuth: string | undefined
    const foreign = await serve((req, res) => { receivedAuth = req.headers.authorization; res.end(PNG) })
    const endpoint = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ url: `${foreign}/image` }] }))
    })
    expect(await makeRequest(endpoint, [], 'api-secret')).toEqual({ data: PNG, mediaType: 'image/png' })
    expect(receivedAuth).toBeUndefined()
    const tooLarge = await serve((_req, res) => { res.end(JSON.stringify({ data: [{ b64_json: 'A'.repeat(4_000) }] })) })
    await expect(makeRequest(tooLarge)).rejects.toThrow(/过大/)
  })

  it('downloads signed same-origin URLs and follows cross-origin redirects without bearer credentials', async () => {
    const downloads: { url: string; auth: string | undefined }[] = []
    const endpoint = await serve((req, res) => {
      if (req.method === 'POST') {
        res.end(JSON.stringify({ data: [{ url: `http://${req.headers.host}/v1/picture?token=signed-value` }] }))
        return
      }
      downloads.push({ url: req.url ?? '', auth: req.headers.authorization })
      res.end(PNG)
    })
    expect(await makeRequest(endpoint, [], 'api-secret')).toEqual({ data: PNG, mediaType: 'image/png' })
    expect(downloads).toEqual([{ url: '/v1/picture?token=signed-value', auth: undefined }])

    const redirected: { auth: string | undefined; url: string }[] = []
    const storage = await serve((req, res) => {
      redirected.push({ auth: req.headers.authorization, url: req.url ?? '' })
      res.end(PNG)
    })
    const redirect = await serve((req, res) => {
      if (req.method === 'POST') res.end(JSON.stringify({ data: [{ url: `http://${req.headers.host}/v1/redirect` }] }))
      else { res.writeHead(302, { location: `${storage}/image?token=redirect-signed` }); res.end() }
    })
    expect(await makeRequest(redirect, [], 'api-secret')).toEqual({ data: PNG, mediaType: 'image/png' })
    expect(redirected).toEqual([{ auth: undefined, url: '/v1/image?token=redirect-signed' }])
  })

  it('rejects redirect targets with credentials or non-HTTP schemes', async () => {
    for (const location of ['http://user:password@127.0.0.1/image', 'file:///etc/passwd']) {
      const endpoint = await serve((req, res) => {
        if (req.method === 'POST') res.end(JSON.stringify({ data: [{ url: `http://${req.headers.host}/v1/redirect` }] }))
        else { res.writeHead(302, { location }); res.end() }
      })
      await expect(makeRequest(endpoint, [], 'api-secret')).rejects.toThrow(/不受信任/)
    }
  })

  it('accepts bounded data URLs and JSON with duplicated image fields', async () => {
    const image = Buffer.concat([PNG, Buffer.alloc(1024 - PNG.byteLength)])
    const endpoint = await serve((_req, res) => {
      const encoded = image.toString('base64')
      res.end(JSON.stringify({ data: [{ url: `data:image/png;base64,${encoded}` }], images: [
        { b64_json: encoded }, { b64_json: encoded }, { b64_json: encoded },
      ] }))
    })
    expect(await makeRequest(endpoint)).toEqual({ data: image, mediaType: 'image/png' })
    const tooLarge = await serve((_req, res) => { res.end(JSON.stringify({ data: [{ b64_json: 'A'.repeat(10_000) }] })) })
    await expect(makeRequest(tooLarge)).rejects.toThrow(/超过允许大小/)
  })
})
