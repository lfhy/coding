/** 经真实 webServer 和 Loader 引导图像路由，模拟附件/凭据与上游服务。 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from 'coding-host-webserver'
import SessionStore from 'coding-session'
import { SessionId } from 'coding-session/types'
import ImageGeneration from '../src/index.ts'
import type { ImageAttachmentRef } from 'coding-attachment'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const contexts: Context[] = []
const servers: ReturnType<typeof createServer>[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => { resolve() }))
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function upstream(): Promise<{ url: string; calls: { path: string; auth: string | undefined }[] }> {
  const calls: { path: string; auth: string | undefined }[] = []
  const server = createServer((req, res) => {
    calls.push({ path: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  return { url: `http://127.0.0.1:${address.port}/v1`, calls }
}

async function boot(config?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'coding-image-gen-'))
  dirs.push(dir)
  const path = join(dir, 'cordis.yml')
  await writeFile(path, [
    '- name: coding-host-webserver', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- name: coding-image-gen', ...config === undefined ? [] : [`  config: ${JSON.stringify(config)}`], '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  const sessions = new SessionStore(ctx)
  const one = sessions.create(SessionId('one'))
  const two = sessions.create(SessionId('two'))
  const refs = new Map<string, Buffer>()
  let saved = 0
  const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string }): Promise<ImageAttachmentRef> => {
    const id = `attachment-${++saved}`
    refs.set(id, Buffer.from(input.data))
    return { attachmentId: id as never, mediaType: input.mediaType as 'image/png', bytes: input.data.byteLength, width: 1, height: 1 }
  })
  const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: refs.get(ref.attachmentId) ?? PNG }))
  ctx.provide('attachments', { saveImage, readImage, imageLimits: { maxSourceImageBytes: 1024,
    maxImageBytes: 1024, maxImagesPerMessage: 5, maxMessageImageBytes: 5120,
    maxSourceMessageImageBytes: 5120, mediaTypes: ['image/png'] } } as never)
  const keys = new Map<string, string>()
  const resolveCredential = vi.fn(async (ref: string) => keys.has(ref) ? { value: keys.get(ref)!, source: 'test' } : undefined)
  ctx.provide('credentials', { resolve: resolveCredential } as never)
  let rejected = false
  ctx.provide('connection', { requestRejection: () => rejected ? 403 : undefined } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['coding-host-webserver', WebServer], ['coding-image-gen', ImageGeneration]])
  ctx.loader.internal = { version: 'v2', import: async (name: string) => {
    if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${ctx.webServer.port}/api/image-gen`
  const get = (route: string, session = 'one', extras = '') => fetch(`${base}/${route}?sessionId=${session}${extras}`)
  const post = (route: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  })
  const put = (revision: number, state: unknown, session = 'one') => fetch(`${base}/canvas?sessionId=${session}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, state }),
  })
  return { ctx, base, get, post, put, keys, resolveCredential, one, two, readImage, saveImage,
    setRejected: (value: boolean) => { rejected = value } }
}

describe('image generation HTTP (real Loader)', () => {
  it('boots with no config and keeps generation disabled by default', async () => {
    const env = await boot()
    expect(await (await env.get('state')).json()).toEqual({ enabled: false, available: false, model: '' })
    expect((await env.post('generate', { sessionId: 'one', prompt: 'test' })).status).toBe(503)
  })

  it('rejects disabled and missing credentials while keeping old gallery readable', async () => {
    const env = await boot({ enabled: false, endpoint: 'http://127.0.0.1:9/v1', model: 'mock' })
    expect(await (await env.get('state')).json()).toEqual({ enabled: false, available: false, model: 'mock' })
    expect((await env.post('generate', { sessionId: 'one', prompt: 'test' })).status).toBe(503)
    env.one.append('image-gen/created', { item: { id: '0', attachmentId: 'attachment-1' as never,
      mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1, prompt: 'old', model: 'mock', createdAt: 0 } })
    expect(await (await env.get('gallery')).json()).toMatchObject({ enabled: false, items: [{ id: '0' }] })
    expect((await env.get('image', 'one', '&id=0')).status).toBe(200)
    expect((await env.get('image', 'two', '&id=0')).status).toBe(404)
    expect(env.readImage).toHaveBeenCalledTimes(1)
    env.keys.set('IMAGE_GEN_API_KEY', 'token')
    expect(await (await env.get('state')).json()).toMatchObject({ available: false })
  })

  it('requires a credential reference to resolve before declaring availability or sending a request', async () => {
    const api = await upstream()
    const env = await boot({ enabled: true, endpoint: api.url, model: 'mock-image' })
    expect(await (await env.get('state')).json()).toEqual({ enabled: true, available: false, model: 'mock-image' })
    expect((await env.post('generate', { sessionId: 'one', prompt: 'draw' })).status).toBe(503)
    expect(api.calls).toEqual([])
    env.keys.set('IMAGE_GEN_API_KEY', 'secret')
    expect(env.resolveCredential).toHaveBeenCalledWith('IMAGE_GEN_API_KEY')
    expect(await env.ctx.imageGeneration.status()).toMatchObject({ available: true })
    expect(await (await env.get('state')).json()).toMatchObject({ available: true })
    expect((await env.post('generate', { sessionId: 'one', prompt: 'draw' })).status).toBe(200)
    expect(api.calls).toEqual([{ path: '/v1/images/generations', auth: 'Bearer secret' }])
  })

  it('generates and edits only this session image, and validates canvas CAS', async () => {
    const api = await upstream()
    const env = await boot({ enabled: true, endpoint: api.url, model: 'mock-image', apiKeyRef: '' })
    expect(await (await env.get('state')).json()).toMatchObject({ enabled: true, available: true })
    const result = await env.post('generate', { sessionId: 'one', prompt: 'draw' })
    expect(result.status).toBe(200)
    const generated = (await result.json() as { item: { id: string } }).item
    expect((await env.get('image', 'two', `&id=${generated.id}`)).status).toBe(404)
    expect((await env.get('image', 'one', `&id=${generated.id}`)).status).toBe(200)
    expect((await env.post('edit', { sessionId: 'two', prompt: 'edit', imageId: generated.id })).status).toBe(400)
    const edited = await env.post('edit', { sessionId: 'one', prompt: 'edit', imageId: generated.id })
    expect(edited.status).toBe(200)
    expect(api.calls.map(call => call.path)).toEqual(['/v1/images/generations', '/v1/images/edits'])
    expect(api.calls.every(call => call.auth === undefined)).toBe(true)
    const state = { version: 1, nodes: [{ id: 'photo', type: 'image', imageId: generated.id, x: 1, y: 1, width: 50, height: 50 },
      { id: 'line', type: 'stroke', points: [{ x: 10, y: 20 }], width: 2, color: 'ink' }] }
    const canvas = await env.put(0, state)
    expect(canvas.status).toBe(200)
    expect(await canvas.json()).toEqual({ revision: 1, state })
    expect((await env.put(0, state)).status).toBe(409)
    expect((await env.put(0, state, 'two')).status).toBe(400)
    expect(await (await env.get('canvas')).json()).toEqual({ revision: 1, state })
    expect(env.one.events.filter(event => event.type === 'image-gen/canvas')).toHaveLength(1)
  })

  it('denies foreign origin, connection rejection and malformed body before any provider call', async () => {
    const api = await upstream()
    const env = await boot({ enabled: true, endpoint: api.url, model: 'mock-image', apiKeyRef: '' })
    const badOrigin = await env.post('generate', { sessionId: 'one', prompt: 'draw' }, { origin: 'http://evil.example' })
    expect(badOrigin.status).toBe(403)
    const rebound = await fetch(`${env.base}/gallery?sessionId=one`, { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })
    expect(rebound.status).toBe(403)
    env.setRejected(true)
    expect((await env.get('gallery')).status).toBe(403)
    env.setRejected(false)
    expect((await env.post('generate', { sessionId: 'one', prompt: 'draw', endpoint: api.url })).status).toBe(400)
    expect(api.calls).toEqual([])
  })
})
