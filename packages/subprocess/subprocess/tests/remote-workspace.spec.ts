import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOTE_WORKSPACE_MARKER,
  callRemoteWorkspaceBridge,
  parseRemoteWorkspaceTargetKey,
  remoteWorkspaceLocalPath,
  remoteWorkspacePath,
  remoteWorkspaceTargetKey,
  verifyRemoteWorkspaceTarget,
} from '@deepseek-ai/dsh-subprocess'

const originalBridgeUrl = process.env.DSH_REMOTE_BRIDGE_URL
const originalBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  if (originalBridgeUrl === undefined) delete process.env.DSH_REMOTE_BRIDGE_URL
  else process.env.DSH_REMOTE_BRIDGE_URL = originalBridgeUrl
  if (originalBridgeToken === undefined) delete process.env.DSH_REMOTE_BRIDGE_TOKEN
  else process.env.DSH_REMOTE_BRIDGE_TOKEN = originalBridgeToken
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function marker(remoteRoot = '/srv/project', connectionId = 'connection-1', generation = 1): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-marker-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({ version: 2, remoteRoot, connectionId, generation }))
  return root
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('Remote-SSH workspace marker', () => {
  it('maps marker descendants to the declared remote root without serializing credentials', async () => {
    const root = await marker()
    await mkdir(join(root, 'src'), { recursive: true })
    const mapped = await remoteWorkspacePath('src/index.ts', root)

    expect(mapped).toMatchObject({
      remoteRoot: '/srv/project',
      remotePath: '/srv/project/src/index.ts',
      connectionId: 'connection-1',
      markerGeneration: 1,
    })
    const key = remoteWorkspaceTargetKey(mapped!)
    expect(key).not.toContain('token')
    const parsed = parseRemoteWorkspaceTargetKey(key)
    expect(parsed).toMatchObject({ remotePath: '/srv/project/src/index.ts', connectionId: 'connection-1', markerGeneration: 1 })
    await expect(verifyRemoteWorkspaceTarget(parsed!)).resolves.toMatchObject({ remoteRoot: '/srv/project' })
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
      version: 2,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 1,
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
      version: 2,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 2,
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
