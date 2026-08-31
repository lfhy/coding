import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'

const initialBridgeURL = process.env.DSH_REMOTE_BRIDGE_URL
const initialBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  if (initialBridgeURL === undefined) delete process.env.DSH_REMOTE_BRIDGE_URL
  else process.env.DSH_REMOTE_BRIDGE_URL = initialBridgeURL
  if (initialBridgeToken === undefined) delete process.env.DSH_REMOTE_BRIDGE_TOKEN
  else process.env.DSH_REMOTE_BRIDGE_TOKEN = initialBridgeToken
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function remoteWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-process-start-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 2,
    remoteRoot: '/srv/project',
    connectionId: 'connection-1',
    generation: 1,
  }))
  return root
}

async function bridge(status: number, payload: unknown): Promise<void> {
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      expect(request.url).toBe('/v1/processes/start')
      response.statusCode = status
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(payload))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
}

function spawn(ctx: Context, cwd: string) {
  return ctx.subprocess.spawn({
    argv: ['unavailable-command'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 },
      stderr: { maxBytes: 64 },
    },
    graceMs: 50,
  })
}

describe('RemoteSubprocessHandle startup settlement', () => {
  it('proves quiescence after an explicit remote start rejection', async () => {
    const cwd = await remoteWorkspace()
    await bridge(400, { error: { code: 'invalid-argv' } })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = spawn(ctx, cwd)
      await expect(handle.done).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'invalid-argv' })
      await expect(handle.waitForExit()).resolves.toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps waitForExit uncertain after bridge availability fails', async () => {
    const cwd = await remoteWorkspace()
    await bridge(503, { error: { code: 'bridge-unavailable' } })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = spawn(ctx, cwd)
      await expect(handle.done).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'bridge-unavailable' })
      await expect(handle.waitForExit()).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'bridge-unavailable' })
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('keeps waitForExit uncertain after an invalid successful start response', async () => {
    const cwd = await remoteWorkspace()
    await bridge(200, { process: { id: 'not-a-complete-process-snapshot' } })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = spawn(ctx, cwd)
      await expect(handle.done).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_RESPONSE_INVALID' })
      await expect(handle.waitForExit()).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_RESPONSE_INVALID' })
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })
})
