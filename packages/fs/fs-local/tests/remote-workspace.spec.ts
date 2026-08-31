import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'

const initialBridgeUrl = process.env.DSH_REMOTE_BRIDGE_URL
const initialBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  if (initialBridgeUrl === undefined) delete process.env.DSH_REMOTE_BRIDGE_URL
  else process.env.DSH_REMOTE_BRIDGE_URL = initialBridgeUrl
  if (initialBridgeToken === undefined) delete process.env.DSH_REMOTE_BRIDGE_TOKEN
  else process.env.DSH_REMOTE_BRIDGE_TOKEN = initialBridgeToken
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspaceMarker(remoteRoot = '/srv/project'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fs-remote-marker-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 2,
    remoteRoot,
    connectionId: 'connection-1',
    generation: 1,
  }))
  return root
}

async function startBridge(
  handler: (
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ) => unknown,
): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      void Promise.resolve(handler(request.url ?? '', body, request.headers)).then((payload) => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(payload))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
}

/** 已派发 mutation 在 caller abort 后仍必须等待最终 bridge 响应。 */
async function expectMutationStillPending(operation: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    operation.then(() => 'settled', () => 'settled'),
    new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 25) }),
  ])
  expect(outcome).toBe('pending')
}

describe('LocalFileSystem Remote-SSH marker routing', () => {
  it('forwards resolve, read, write, edit, and directory listing to the selected connection', async () => {
    const root = await workspaceMarker()
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    await startBridge((path, body, headers) => {
      expect(headers.authorization).toBe('Bearer test-bridge-token-which-is-long-enough')
      expect(headers['x-coding-remote-connection']).toBe('connection-1')
      calls.push({ path, body })
      switch (path) {
        case '/v1/resolve':
          return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 5 } }
        case '/v1/read_file':
          return { path: body.path, content: 'hello', version: 'v1' }
        case '/v1/read_bytes':
          return { path: body.path, contentBase64: Buffer.from([0, 0xff]).toString('base64'), version: 'v1' }
        case '/v1/stat':
          return { info: { path: body.path, type: 'symlink', version: 'link-v1' } }
        case '/v1/update_file':
          return { operation: 'update', version: 'v2', before: 'hello', after: body.content }
        case '/v1/edit_file':
          return { version: 'v3', before: 'next', after: 'done' }
        case '/v1/directories':
          return {
            path: body.path,
            entries: [{ name: 'child.ts', path: '/srv/project/child.ts', type: 'file', version: 'v3', size: 4 }],
          }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      expect(target.displayPath).toBe('/srv/project/source.ts')
      expect((await fs.resolve('/srv/project/absolute.ts', { cwd: root })).displayPath).toBe('/srv/project/absolute.ts')
      await expect(fs.resolve('/etc/passwd', { cwd: root })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
      await expect(fs.lstat('link.ts', { cwd: root })).resolves.toMatchObject({ type: 'symlink', version: 'link-v1' })
      expect(await fs.readText(target)).toBe('hello')
      expect(await fs.readBytes(target, undefined, 2)).toEqual(Buffer.from([0, 0xff]))
      expect(fs.processPath(target)).toBe('/srv/project/source.ts')
      expect(fs.fileUrl(target)).toBe('file:///srv/project/source.ts')
      await expect(fs.writeText(target, 'next', { kind: 'replaceIfVersion', version: FsVersion('v1') }))
        .resolves.toMatchObject({ operation: 'update', version: 'v2', before: 'hello', after: 'next' })
      await expect(fs.editText(target, { oldString: 'next', newString: 'done', replaceAll: false }, { version: FsVersion('v2') }))
        .resolves.toMatchObject({ version: 'v3', before: 'next', after: 'done' })
      const entries = await fs.listDir(await fs.resolve('.'))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        name: 'child.ts',
        type: 'file',
        target: { displayPath: '/srv/project/child.ts' },
      })
      expect(calls.map(call => call.path)).toEqual([
        '/v1/resolve',
        '/v1/resolve',
        '/v1/stat',
        '/v1/read_file',
        '/v1/read_bytes',
        '/v1/update_file',
        '/v1/edit_file',
        '/v1/resolve',
        '/v1/directories',
      ])
      expect(calls[5]?.body.expected).toEqual({ kind: 'replaceIfVersion', version: 'v1' })
      expect(calls[6]?.body.expected).toEqual({ kind: 'replaceIfVersion', version: 'v2' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects stat metadata that belongs to another path in the same remote workspace', async () => {
    const root = await workspaceMarker()
    await startBridge((path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 5 } }
      }
      if (path === '/v1/stat') {
        return { info: { path: '/srv/project/other.ts', type: 'file', version: 'other-v1', size: 7 } }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
      await expect(fs.lstat('source.ts', { cwd: root })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recognizes a Windows remote absolute path on a non-Windows host', async () => {
    const root = await workspaceMarker(String.raw`C:\project`)
    const canonicalPath = String.raw`C:\project\src\index.ts`
    await startBridge((path, _body) => {
      if (path === '/v1/resolve') {
        return { path: canonicalPath, info: { path: canonicalPath, type: 'file', version: 'v1', size: 1 } }
      }
      if (path === '/v1/stat') {
        return { info: { path: canonicalPath, type: 'file', version: 'v1', size: 1 } }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      await expect(fs.resolve(String.raw`c:\project\src\index.ts`, { cwd: root }))
        .resolves.toMatchObject({ displayPath: canonicalPath })
      await expect(fs.lstat(String.raw`c:\project\src\index.ts`, { cwd: root }))
        .resolves.toMatchObject({ type: 'file', version: 'v1' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects non-canonical base64 before exposing remote bytes', async () => {
    const root = await workspaceMarker()
    await startBridge((path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 2 } }
      }
      if (path === '/v1/read_bytes') {
        return { path: body.path, contentBase64: 'AP8', version: 'v1' }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('binary.dat')
      await expect(fs.readBytes(target, undefined, 2)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('waits for a dispatched remote mutation result after caller cancellation', async () => {
    const root = await workspaceMarker()
    const dispatched = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    await startBridge(async (path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 3 } }
      }
      if (path === '/v1/update_file') {
        dispatched.resolve(undefined)
        await release.promise
        return { operation: 'update', version: 'v2', before: 'old', after: 'new' }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      const controller = new AbortController()
      const writing = fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: FsVersion('v1') }, controller.signal)
      await dispatched.promise
      controller.abort()
      await expectMutationStillPending(writing)
      release.resolve(undefined)
      await expect(writing).resolves.toMatchObject({ operation: 'update', version: 'v2', after: 'new' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('waits for a dispatched remote edit result after caller cancellation', async () => {
    const root = await workspaceMarker()
    const dispatched = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    await startBridge(async (path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 3 } }
      }
      if (path === '/v1/edit_file') {
        dispatched.resolve(undefined)
        await release.promise
        return { version: 'v2', before: 'old', after: 'new' }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      const controller = new AbortController()
      const editing = fs.editText(
        target,
        { oldString: 'old', newString: 'new', replaceAll: false },
        { version: FsVersion('v1') },
        controller.signal,
      )
      await dispatched.promise
      controller.abort()
      await expectMutationStillPending(editing)
      release.resolve(undefined)
      await expect(editing).resolves.toMatchObject({ version: 'v2', before: 'old', after: 'new' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a write response whose diff basis does not match the requested content', async () => {
    const root = await workspaceMarker()
    await startBridge((path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 3 } }
      }
      if (path === '/v1/update_file') {
        return { operation: 'update', version: 'v2', before: 'old\r\n', after: body.content }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      await expect(fs.writeText(target, 'new\r\n')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a remote edit response that does not apply the requested change', async () => {
    const root = await workspaceMarker()
    await startBridge((path, body) => {
      if (path === '/v1/resolve') {
        return { path: body.path, info: { path: body.path, type: 'file', version: 'v1', size: 3 } }
      }
      if (path === '/v1/edit_file') {
        return { version: 'v2', before: 'old', after: 'unrelated' }
      }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      const fs = ctx.fs as LocalFileSystem
      const target = await fs.resolve('source.ts')
      await expect(fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false }, { version: FsVersion('v1') }))
        .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
