/** 真实工具、JSONL 与本地附件共同验证图库归属和重启读取，不依赖 UI 投影。 */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from 'coding-attachment-local'
import FileLibrary from 'coding-file-library'
import WebServer from 'coding-host-webserver'
import ImageGeneration, { type GalleryItem } from 'coding-image-gen'
import { CallId } from 'coding-llm'
import SessionStore, { SessionId, type Session } from 'coding-session'
import JsonlSessionPersistence from 'coding-session-persistence-jsonl'
import Storage from 'coding-storage'
import { DomainFacility } from 'coding-storage-domain'
import { SqliteStorageBackend } from 'coding-storage-sqlite'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const contexts: Context[] = []
const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => { resolve() }))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'coding-tool-image-gallery-'))
  directories.push(directory)
  return directory
}

async function upstream(): Promise<{ endpoint: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((req, res) => {
    const respond = async (): Promise<void> => {
      paths.push(req.url ?? '')
      expect(req.headers.authorization).toBeUndefined()
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part as Uint8Array))
      const body = Buffer.concat(parts).toString('utf8')
      const failed = req.headers['content-type'] === 'application/json'
        && (JSON.parse(body) as { prompt: string }).prompt === 'bad'
      res.writeHead(failed ? 500 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(failed ? { error: 'synthetic upstream failure' } : { data: [{ b64_json: PNG.toString('base64') }] }))
    }
    void respond().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing upstream address')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, paths }
}

async function boot(directory: string, endpoint?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(directory, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 60_000,
  })
  await ctx.plugin(LocalAttachmentStore, { dshHome: directory })
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('sqlite', new SqliteStorageBackend({ path: ':memory:', journalMode: 'delete' }))
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'sqlite' }))
  await ctx.plugin(FileLibrary, { root: join(directory, 'files') })
  await ctx.plugin(ImageGeneration, {
    enabled: endpoint !== undefined, endpoint: endpoint ?? '', model: 'keyless-test', apiKeyRef: '', maxEditReferences: 10,
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const get = (route: string, session: string, extra = '') =>
    fetch(`http://127.0.0.1:${ctx.webServer.port}/api/image-gen/${route}?sessionId=${session}${extra}`)
  return { ctx, get }
}

function execute(ctx: Context, session: Session, name: string, args: object) {
  return ctx.tools.execute({
    name, arguments: args, agent: { session } as never,
    signal: new AbortController().signal, callId: CallId(`call-${session.seq}`),
  })
}

describe('tool images in the durable session gallery', () => {
  it.each(['standard', 'codex'] as const)('reopens %s generated and edited images with their real bytes', async (variant) => {
    const directory = await root()
    const api = await upstream()
    const first = await boot(directory, api.endpoint)
    const session = first.ctx.sessions.create(SessionId(`images-${variant}`))
    await apply(first.ctx, { variant })
    const tool = variant === 'codex' ? 'image_gen' : 'generate_image'
    const generated = await execute(first.ctx, session, tool, { prompt: 'first' })
    expect(generated.isError).toBe(false)
    const initial = generated.value as unknown as GalleryItem
    const edited = await execute(first.ctx, session, variant === 'codex' ? 'image_gen' : 'edit_image', {
      prompt: 'edited', ...(variant === 'codex' ? { num_last_images_to_include: 1 } : { imageId: initial.id }),
    })
    expect(edited.isError).toBe(false)
    expect(edited.value).toMatchObject({ sourceImageId: initial.id })
    const results = [generated, edited]
    if (variant === 'standard') {
      const batch = await execute(first.ctx, session, 'generate_images', { prompts: ['second', 'bad', 'third'] })
      expect(batch.isError).toBe(false)
      expect(batch.value).toMatchObject({ images: [{ index: 0 }, { index: 2 }], failures: [{ index: 1 }] })
      results.push(batch)
    }
    const images = first.ctx.imageGeneration.gallery(session.events)
    expect(images.map(image => image.prompt)).toEqual(variant === 'standard'
      ? ['first', 'edited', 'second', 'third'] : ['first', 'edited'])
    const blocks = results.flatMap(result => result.content.filter(block => block.type === 'image'))
    expect(blocks.map(block => block.attachment)).toEqual(images.map(image => ({
      attachmentId: image.attachmentId, mediaType: image.mediaType,
      bytes: image.bytes, width: image.width, height: image.height,
    })))
    // 在 teardown 可能补刷之前检查实际文件，避免测试依赖关闭流程碰巧保存。
    const location = first.ctx.sessionPersistence.locate(session.header)
    if (location?.kind !== 'jsonl') throw new Error('missing JSONL location')
    const stored = (await readFile(location.path, 'utf8')).trim().split('\n').slice(1)
      .map(line => JSON.parse(line) as { type: string; data: { item: GalleryItem } })
    expect(stored.filter(event => event.type === 'image-gen/created').map(event => event.data.item)).toEqual(images)
    expect(api.paths).toContain('/v1/images/edits')
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const reopened = await boot(directory)
    expect(reopened.ctx.sessions.get(session.id)).toBeUndefined()
    const gallery = await reopened.get('gallery', session.id)
    expect(gallery.status).toBe(200)
    expect(await gallery.json()).toEqual({ enabled: false, items: images })
    for (const image of images) {
      const response = await reopened.get('image', session.id, `&id=${image.id}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    }
    reopened.ctx.sessions.create(SessionId('another-session'))
    expect((await reopened.get('image', 'another-session', `&id=${initial.id}`)).status).toBe(404)
  })

  it('persists imported references through the service without the HTTP consumer', async () => {
    const directory = await root()
    const first = await boot(directory)
    const session = first.ctx.sessions.create(SessionId('references'))
    const item = await first.ctx.imageGeneration.importReference(session, { data: PNG, mediaType: 'image/png' })
    const inspection = await first.ctx.sessionPersistence.inspect(session.id)
    expect(first.ctx.imageGeneration.gallery(inspection.events)).toEqual([item])
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const reopened = await boot(directory)
    expect(await (await reopened.get('gallery', session.id)).json()).toEqual({ enabled: false, items: [item] })
    const image = await reopened.get('image', session.id, `&id=${item.id}`)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
  })

  it.each(['generate', 'import'] as const)('waits for the %s durability barrier and rejects its failure', async (operation) => {
    const directory = await root()
    const api = await upstream()
    const { ctx } = await boot(directory, api.endpoint)
    const session = ctx.sessions.create(SessionId(`barrier-${operation}`))
    await apply(ctx, { variant: 'standard' })
    const start = () => operation === 'generate'
      ? execute(ctx, session, 'generate_image', { prompt: 'barrier' })
      : ctx.imageGeneration.importReference(session, { data: PNG, mediaType: 'image/png' })
    for (const fail of [false, true]) {
      const barrier = Promise.withResolvers<undefined>()
      const entered = vi.fn()
      const release = ctx.on('session/flush', async () => { entered(); await barrier.promise })
      const failure = new Error('synthetic durability failure')
      const reject = fail ? ctx.on('session/flush', () => Promise.reject(failure)) : () => {}
      let settled = false
      const pending = start()
      const observed = pending.then((value) => { settled = true; return { value } },
        (error: unknown) => { settled = true; return { error } })
      await vi.waitFor(() => { expect(entered).toHaveBeenCalledOnce() })
      expect(settled).toBe(false)
      barrier.resolve(undefined)
      const outcome = await observed
      release()
      reject()
      if (operation === 'generate') {
        expect(outcome).toMatchObject({ value: { isError: fail } })
        if ('value' in outcome && outcome.value && 'content' in outcome.value) {
          expect(outcome.value.content.filter(block => block.type === 'image')).toHaveLength(fail ? 0 : 1)
        }
      } else if (fail) expect(outcome).toEqual({ error: failure })
      else expect(outcome).toMatchObject({ value: { model: 'import' } })
    }
    expect(ctx.imageGeneration.gallery(session.events)).toHaveLength(2)
  })
})
