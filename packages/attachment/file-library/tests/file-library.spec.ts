import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from 'coding-storage'
import { DomainFacility } from 'coding-storage-domain'
import { SqliteStorageBackend } from 'coding-storage-sqlite'
import WebServer from 'coding-host-webserver'
import FileLibrary, { FileId, MAX_MANAGED_FILE_BYTES } from '../src/index.ts'
import { managedFileSchema } from '../src/spec.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function harness(home?: string) {
  const dir = home ?? await mkdtemp(join(tmpdir(), 'coding-file-library-'))
  if (!home) homes.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: join(dir, 'files.sqlite'), journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite' })
  ctx.provide('storageDomain', facility)
  await ctx.plugin(FileLibrary, { root: join(dir, 'files') })
  return { ctx, library: ctx.fileLibrary, dir, backend }
}

function bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield value })()
}
function upload(library: FileLibrary, name: string, data = new Uint8Array([1, 2, 3]), verify = async () => {}) {
  return library.saveUpload({ name, sessionId: 'session-1', stream: bytes(data), verify })
}

describe('global file library (SQLite)', () => {
  it('brands only valid UUID file IDs at code and stored-record boundaries', () => {
    expect(() => FileId('not-a-uuid')).toThrow(TypeError)
    const id = FileId('123e4567-e89b-42d3-a456-426614174000')
    expect(id).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(managedFileSchema.safeParse({ id: 'bad', kind: 'upload', name: 'x',
      relativePath: `uploads/${id}-x`, mediaType: 'text/plain', bytes: 1,
      createdAt: new Date().toISOString() }).success).toBe(false)
  })

  it('persists private uploads and generated image copies across restart', async () => {
    const first = await harness()
    const uploadResult = await upload(first.library, '../notes.txt')
    expect(uploadResult.record).toMatchObject({ kind: 'upload', name: 'notes.txt', bytes: 3, sessionId: 'session-1' })
    expect(await readFile(uploadResult.path)).toEqual(Buffer.from([1, 2, 3]))
    expect(await first.library.isManagedUploadPath(uploadResult.path)).toBe(true)
    const image = await first.library.saveGeneratedImage({ sessionId: 'session-1', attachmentId: 'sha256:sample',
      mediaType: 'image/png', data: new Uint8Array([4, 5]) })
    expect(image).toMatchObject({ kind: 'generated-image', mediaType: 'image/png', bytes: 2 })
    expect(await first.library.isManagedUploadPath(join(first.library.root, image.relativePath))).toBe(false)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.backend.close()
    const second = await harness(first.dir)
    expect(second.library.list().items.map(row => row.id).sort()).toEqual([uploadResult.record.id, image.id].sort())
    expect(await second.library.isManagedUploadPath(uploadResult.path)).toBe(true)
  })

  it('copies an admitted generated image larger than the upload limit', async () => {
    const first = await harness()
    const data = Buffer.alloc(MAX_MANAGED_FILE_BYTES + 1, 7)
    const saved = await first.library.saveGeneratedImage({ sessionId: 'one', attachmentId: 'sha256:large',
      mediaType: 'image/png', data })
    expect(saved.bytes).toBe(data.byteLength)
    expect((await stat(join(first.library.root, saved.relativePath))).size).toBe(data.byteLength)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.backend.close()
    const second = await harness(first.dir)
    expect(second.library.list().items[0]?.bytes).toBe(data.byteLength)
  })

  it('bounds pagination and checks both stream and late session validation', async () => {
    const { library } = await harness()
    for (let i = 0; i < 101; i++) await upload(library, `file-${i}`)
    const first = library.list(0, 2)
    expect(first).toMatchObject({ total: 101, nextOffset: 2 })
    expect(library.list(first.nextOffset, 2).items).toHaveLength(2)
    expect(library.list(0, 1000)).toMatchObject({ total: 101, nextOffset: 100 })
    expect(library.list(0, 1000).items).toHaveLength(100)
    expect(() => library.list(-1)).toThrow(TypeError)
    expect(() => library.list(0, 0)).toThrow(TypeError)
    await expect(upload(library, 'large', new Uint8Array(MAX_MANAGED_FILE_BYTES + 1))).rejects.toThrow(/32 MiB/)
    expect(await readdir(join(library.root, 'uploads'))).toHaveLength(101)
    let checked = 0
    await expect(upload(library, 'closed', new Uint8Array([1]), async () => {
      if (++checked === 2) throw new Error('session closed')
    })).rejects.toThrow('session closed')
    expect(await readdir(join(library.root, 'uploads'))).toHaveLength(101)
  })

  it('normalizes names to the client path grammar within 120 UTF-8 bytes and retains extensions', async () => {
    const { library } = await harness()
    const saved = await upload(library, `../../${'中'.repeat(80)}(draft).pptx`)
    expect(saved.record.name).toMatch(/^[\p{L}\p{N} ._-]+$/u)
    expect(saved.record.name).toMatch(/\.pptx$/u)
    expect(Buffer.byteLength(saved.record.name, 'utf8')).toBeLessThanOrEqual(120)
    expect(saved.record.relativePath).toMatch(/^uploads\/[a-f0-9-]{36}-/u)
    expect(await library.isManagedUploadPath(saved.path)).toBe(true)
  })

  it('rejects symlink roots and refuses symlink, outside and unregistered upload paths', async () => {
    const { library, dir } = await harness()
    const saved = await upload(library, 'real.txt')
    const link = join(library.root, 'uploads', 'link.txt')
    await symlink(saved.path, link)
    expect(await library.isManagedUploadPath(link)).toBe(false)
    const outside = join(dir, 'external.txt')
    await writeFile(outside, 'external')
    expect(await library.isManagedUploadPath(outside)).toBe(false)
    expect(await library.isManagedUploadPath(join(library.root, 'uploads', 'missing'))).toBe(false)
    expect(await library.isManagedUploadPath(saved.path)).toBe(true)
    const symlinkHome = await mkdtemp(join(tmpdir(), 'coding-file-library-link-'))
    homes.push(symlinkHome)
    await symlink(library.root, join(symlinkHome, 'files'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'delete' })
    ctx.storage.backend.register('sqlite', backend)
    ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'sqlite' }))
    await expect(ctx.plugin(FileLibrary, { root: join(symlinkHome, 'files') })).rejects.toThrow(/真实目录/)
  })

  it('rejects root characters that cannot be represented in @file syntax before creating directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-file-library-invalid-root-'))
    homes.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new FileLibrary(ctx, { root: join(dir, 'bad"files') })).toThrow(TypeError)
    expect(() => new FileLibrary(ctx, { root: join(dir, 'bad\nfiles') })).toThrow(TypeError)
    expect(await readdir(dir)).toEqual([])
  })

  it('rolls back only its own new file when the metadata backend rejects', async () => {
    const { library, backend } = await harness()
    await backend.close()
    await expect(upload(library, 'failed.txt')).rejects.toThrow()
    expect(library.list().total).toBe(0)
    expect(await readdir(join(library.root, 'uploads'))).toEqual([])
  })

  it('does not publish a path after a directory swap during a stream', async () => {
    const { library } = await harness()
    const original = join(library.root, 'uploads')
    let moved = false
    await expect(library.saveUpload({
      name: 'race.txt', sessionId: 'one', verify: async () => {},
      stream: (async function* () {
        yield Buffer.from('before')
        await rename(original, `${original}-moved`)
        await mkdir(original, { mode: 0o700 })
        moved = true
        yield Buffer.from('after')
      })(),
    })).rejects.toThrow()
    expect(moved).toBe(true)
    expect(library.list().total).toBe(0)
    expect(await readdir(`${original}-moved`)).toHaveLength(1)
  })

  it('serves an authenticated same-origin read-only list without absolute paths', async () => {
    const { ctx, library } = await harness()
    let rejected = false
    ctx.provide('connection', { requestRejection: () => rejected ? 403 : undefined } as never)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await upload(library, 'sample.txt')
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/files/list`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const text = await response.text()
    expect(text).not.toContain(library.root)
    expect(JSON.parse(text)).toMatchObject({ total: 1, items: [{ kind: 'upload', name: 'sample.txt' }] })
    expect((await fetch(`${url}?offset=-1`)).status).toBe(400)
    expect((await fetch(`${url}?limit=1&limit=2`)).status).toBe(400)
    expect((await fetch(url, { method: 'POST' })).status).toBe(405)
    expect((await fetch(url, { headers: { origin: 'http://untrusted.example' } })).status).toBe(403)
    rejected = true
    expect((await fetch(url)).status).toBe(403)
  })
})
