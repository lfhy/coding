import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOTE_WORKSPACE_MARKER,
  callRemoteWorkspaceBridge,
  parseRemoteWorkspaceTargetKey,
  readRemoteWorkspaceMarker,
  requireRemoteWorkspaceCapability,
  remoteWorkspaceLocalPath,
  remoteWorkspacePath,
  remoteWorkspacePathSync,
  remoteWorkspaceTargetKey,
  verifyRemoteWorkspaceTarget,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorkspaceCapability, RemoteWorkspaceMode } from '@deepseek-ai/dsh-subprocess'

const originalBridgeUrl = process.env.DSH_REMOTE_BRIDGE_URL
const originalBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const originalDshHome = process.env.DSH_HOME
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  if (originalBridgeUrl === undefined) delete process.env.DSH_REMOTE_BRIDGE_URL
  else process.env.DSH_REMOTE_BRIDGE_URL = originalBridgeUrl
  if (originalBridgeToken === undefined) delete process.env.DSH_REMOTE_BRIDGE_TOKEN
  else process.env.DSH_REMOTE_BRIDGE_TOKEN = originalBridgeToken
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function marker(remoteRoot = '/srv/project', connectionId = 'connection-1', generation = 1, mode: RemoteWorkspaceMode = 'agent'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-marker-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({ version: 3, remoteRoot, connectionId, generation, mode }))
  return root
}

async function officialMarker(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-home-'))
  roots.push(home)
  process.env.DSH_HOME = home
  const root = join(home, 'remote-workspaces', 'a'.repeat(20), `project-${'b'.repeat(20)}`)
  await mkdir(root, { recursive: true })
  return { home, root }
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('Remote-SSH workspace marker', () => {
  it('rejects a missing official marker at its root and descendants in async and sync consumers', async () => {
    const { root } = await officialMarker()
    for (const path of [root, join(root, 'src', 'file.ts')]) {
      await expect(remoteWorkspacePath(path)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' })
      expect(() => remoteWorkspacePathSync(path)).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' }))
    }
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'basic',
    }))
    expect((await remoteWorkspacePath(join(root, 'src', 'file.ts')))?.remotePath).toBe('/srv/project/src/file.ts')
    expect(remoteWorkspacePathSync(root)?.mode).toBe('basic')
    await rm(join(root, REMOTE_WORKSPACE_MARKER))
    await expect(remoteWorkspacePath(root)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' })
    expect(() => remoteWorkspacePathSync(root)).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' }))
  })

  it('retains valid v2 markers and ordinary local directories beneath the same home', async () => {
    const { home, root } = await officialMarker()
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 2, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1,
    }))
    expect((await remoteWorkspacePath(root))?.mode).toBe('agent')
    expect(remoteWorkspacePathSync(join(root, 'src'))?.mode).toBe('agent')
    for (const local of [
      join(home, 'ordinary', 'file.txt'),
      join(home, 'remote-workspaces', 'notes', 'project-' + 'b'.repeat(20)),
      join(home, 'remote-workspaces', 'a'.repeat(20), 'ordinary', 'file.txt'),
      join(home, 'remote-workspaces', 'a'.repeat(20), 'two--dashes-' + 'b'.repeat(20)),
      join(home, 'remote-workspaces', 'g'.repeat(20), 'project-' + 'b'.repeat(20)),
    ]) {
      expect(await remoteWorkspacePath(local)).toBeUndefined()
      expect(remoteWorkspacePathSync(local)).toBeUndefined()
    }
  })

  it('canonicalizes a symlinked home and leaves an unset DSH_HOME unbound to an unrelated home', async () => {
    const { home, root } = await officialMarker()
    const alias = `${home}-alias`
    const rootAlias = `${home}-root-alias`
    roots.push(alias)
    roots.push(rootAlias)
    await symlink(home, alias, 'dir')
    await symlink(root, rootAlias, 'dir')
    process.env.DSH_HOME = alias
    const uppercaseAlias = join(home, 'remote-workspaces', 'A'.repeat(20), `project-${'b'.repeat(20)}`)
    const aliases = [root, rootAlias, join(alias, 'remote-workspaces', 'a'.repeat(20), `project-${'b'.repeat(20)}`, 'file.txt')]
    if (await realpath(uppercaseAlias).catch(() => undefined) === await realpath(root)) aliases.push(uppercaseAlias)
    for (const path of aliases) {
      await expect(remoteWorkspacePath(path)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' })
      expect(() => remoteWorkspacePathSync(path), path).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' }))
    }
    delete process.env.DSH_HOME
    expect(await remoteWorkspacePath(root)).toBeUndefined()
    expect(remoteWorkspacePathSync(root)).toBeUndefined()
  })

  it('maps marker descendants to the declared remote root without serializing credentials', async () => {
    const root = await marker()
    await mkdir(join(root, 'src'), { recursive: true })
    const mapped = await remoteWorkspacePath('src/index.ts', root)

    expect(mapped).toMatchObject({
      remoteRoot: '/srv/project',
      remotePath: '/srv/project/src/index.ts',
      connectionId: 'connection-1',
      markerGeneration: 1,
      mode: 'agent',
    })
    const key = remoteWorkspaceTargetKey(mapped!)
    expect(key).not.toContain('token')
    const parsed = parseRemoteWorkspaceTargetKey(key)
    expect(parsed).toMatchObject({ remotePath: '/srv/project/src/index.ts', connectionId: 'connection-1', markerGeneration: 1, mode: 'agent' })
    await expect(verifyRemoteWorkspaceTarget(parsed!)).resolves.toMatchObject({ remoteRoot: '/srv/project' })
  })

  it('reads basic mode through async/sync paths and retains it in target keys', async () => {
    const root = await marker('/srv/project', 'connection-1', 1, 'basic')
    const asyncPath = await remoteWorkspacePath('src/index.ts', root)
    const syncPath = remoteWorkspacePathSync('src/index.ts', root)
    expect(asyncPath?.mode).toBe('basic')
    expect(syncPath).toEqual(asyncPath)
    expect((await readRemoteWorkspaceMarker(asyncPath!.markerRoot)).mode).toBe('basic')
    const target = parseRemoteWorkspaceTargetKey(remoteWorkspaceTargetKey(asyncPath!))
    expect(target?.mode).toBe('basic')
    await expect(verifyRemoteWorkspaceTarget(target!)).resolves.toMatchObject({ mode: 'basic' })
  })

  it('accepts a v2 marker as agent mode, but never runs a v1 marker', async () => {
    const root = await marker()
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 2, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1,
    }))
    const mapped = await remoteWorkspacePath('file.txt', root)
    expect(mapped?.mode).toBe('agent')
    expect(remoteWorkspacePathSync('file.txt', root)?.mode).toBe('agent')
    expect((await readRemoteWorkspaceMarker(mapped!.markerRoot)).mode).toBe('agent')
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 1, remoteRoot: '/srv/project', connectionId: 'connection-1',
    }))
    await expect(remoteWorkspacePath('file.txt', root)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' })
    expect(() => remoteWorkspacePathSync('file.txt', root)).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' }))
  })

  it('rejects unknown, missing, and misplaced mode fields at the marker boundary', async () => {
    const root = await marker()
    for (const record of [
      { version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1 },
      { version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'other' },
      { version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: null },
      { version: 2, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent' },
    ]) {
      await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify(record))
      await expect(remoteWorkspacePath('file.txt', root)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' })
      expect(() => remoteWorkspacePathSync('file.txt', root)).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_MARKER_INVALID' }))
    }
  })

  it('fails closed when a marker rebind changes mode even if its other fields are unchanged', async () => {
    const root = await marker('/srv/project', 'connection-1', 1, 'agent')
    const target = await remoteWorkspacePath('file.txt', root)
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'basic',
    }))
    await expect(verifyRemoteWorkspaceTarget(target!)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' })
  })

  it('requires valid mode in target keys and treats old mode-less target keys as agent only', async () => {
    const root = await marker()
    const mapped = (await remoteWorkspacePath('file.txt', root))!
    const prefix = 'coding-remote-target:v1:'
    const oldKey = prefix + Buffer.from(JSON.stringify({
      markerRoot: mapped.markerRoot,
      remoteRoot: mapped.remoteRoot,
      remotePath: mapped.remotePath,
      connectionId: mapped.connectionId,
      markerGeneration: mapped.markerGeneration,
    })).toString('base64url')
    expect(parseRemoteWorkspaceTargetKey(oldKey)?.mode).toBe('agent')
    await expect(verifyRemoteWorkspaceTarget(parseRemoteWorkspaceTargetKey(oldKey)!)).resolves.toMatchObject({ mode: 'agent' })
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'basic',
    }))
    await expect(verifyRemoteWorkspaceTarget(parseRemoteWorkspaceTargetKey(oldKey)!)).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' })
    for (const mode of [null, 'other', 42]) {
      const invalidKey = prefix + Buffer.from(JSON.stringify({
        markerRoot: mapped.markerRoot, remoteRoot: mapped.remoteRoot, remotePath: mapped.remotePath,
        connectionId: mapped.connectionId, markerGeneration: mapped.markerGeneration, mode,
      })).toString('base64url')
      expect(() => parseRemoteWorkspaceTargetKey(invalidKey)).toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' }))
    }
    expect(() => remoteWorkspaceTargetKey({ ...mapped, mode: 'other' as RemoteWorkspaceMode }))
      .toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' }))
  })

  it('allows basic workspace operations but rejects LSP explicitly', () => {
    const capabilities: RemoteWorkspaceCapability[] = ['files-read', 'files-write', 'exec', 'process', 'terminal', 'search', 'code', 'lsp']
    for (const capability of capabilities) {
      expect(() => { requireRemoteWorkspaceCapability({ mode: 'agent' }, capability) }).not.toThrow()
      if (capability === 'lsp') {
        expect(() => { requireRemoteWorkspaceCapability({ mode: 'basic' }, capability) })
          .toThrow(expect.objectContaining({ code: 'REMOTE_CAPABILITY_UNAVAILABLE' }))
      } else {
        expect(() => { requireRemoteWorkspaceCapability({ mode: 'basic' }, capability) }).not.toThrow()
      }
    }
  })

  it('maps case-insensitive Windows and UNC remote paths back to marker placeholders', async () => {
    const root = await marker(String.raw`C:\project`)
    expect(remoteWorkspaceLocalPath({ markerRoot: root, remoteRoot: String.raw`C:\project` }, String.raw`c:\project\src\file.ts`))
      .toBe(join(root, 'src', 'file.ts'))
    expect(remoteWorkspaceLocalPath({ markerRoot: root, remoteRoot: String.raw`\\server\share` }, String.raw`\\SERVER\SHARE\src\file.ts`))
      .toBe(join(root, 'src', 'file.ts'))
    expect(() => remoteWorkspaceLocalPath({ markerRoot: root, remoteRoot: String.raw`C:\project` }, String.raw`C:\outside\file.ts`))
      .toThrow(expect.objectContaining({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' }))
  })

  it('does not route a path outside the marker and rejects marker fields that could hold credentials', async () => {
    const root = await marker()
    expect(await remoteWorkspacePath('../outside.txt', root)).toBeUndefined()
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 1,
      mode: 'agent',
      token: 'must-not-persist',
    }))
    await expect(remoteWorkspacePath('file.txt', root)).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_MARKER_INVALID',
    })
  })

  it('fails closed when the marker generation changes without changing the connection id', async () => {
    const root = await marker()
    const target = await remoteWorkspacePath('file.txt', root)
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 2,
      mode: 'agent',
    }))
    await expect(verifyRemoteWorkspaceTarget(target!)).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_TARGET_INVALID',
    })
  })

  it('rejects a legacy v1 marker instead of dispatching it without a bridge generation', async () => {
    const root = await marker()
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 1,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
    }))
    await expect(remoteWorkspacePath('file.txt', root)).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_MARKER_INVALID',
    })
  })
})

describe('Remote-SSH local bridge', () => {
  it('sends only the process token in Authorization and routes a marker connection id in its own header', async () => {
    let received: {
      authorization: string | undefined
      connection: string | undefined
      markerRoot: string | undefined
      generation: string | undefined
      remoteRoot: string | undefined
      body: unknown
    } | undefined
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        received = {
          authorization: request.headers.authorization,
          connection: request.headers['x-coding-remote-connection'] as string | undefined,
          markerRoot: request.headers['x-coding-remote-marker-root'] as string | undefined,
          generation: request.headers['x-coding-remote-marker-generation'] as string | undefined,
          remoteRoot: request.headers['x-coding-remote-root'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ path: '/srv/project/src/index.ts' }))
      })
    })
    process.env.DSH_REMOTE_BRIDGE_URL = await listen(server)
    process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'

    const response = await callRemoteWorkspaceBridge(
      { markerRoot: '/tmp/dsh-remote-marker', connectionId: 'connection-1', remoteRoot: '/srv/project', markerGeneration: 1 },
      '/v1/resolve',
      'POST',
      { path: '/srv/project/src/index.ts' },
      (value) => {
        const path = (value as { path?: unknown }).path
        if (typeof path !== 'string') throw new Error('bad fixture response')
        return path
      },
    )

    expect(response).toBe('/srv/project/src/index.ts')
    expect(received).toEqual({
      authorization: 'Bearer test-bridge-token-which-is-long-enough',
      connection: 'connection-1',
      markerRoot: '/tmp/dsh-remote-marker',
      generation: '1',
      remoteRoot: '/srv/project',
      body: { path: '/srv/project/src/index.ts', root: '/srv/project' },
    })
  })
})
