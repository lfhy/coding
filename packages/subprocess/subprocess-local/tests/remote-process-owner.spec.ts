import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  REMOTE_BRIDGE_TOKEN_ENV,
  REMOTE_BRIDGE_URL_ENV,
  REMOTE_WORKSPACE_MARKER,
} from '@deepseek-ai/dsh-subprocess'

const initialBridgeURL = process.env[REMOTE_BRIDGE_URL_ENV]
const initialBridgeToken = process.env[REMOTE_BRIDGE_TOKEN_ENV]
const roots: string[] = []
const servers: Server[] = []

interface BridgeRequest {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

afterEach(async () => {
  if (initialBridgeURL === undefined) Reflect.deleteProperty(process.env, REMOTE_BRIDGE_URL_ENV)
  else process.env[REMOTE_BRIDGE_URL_ENV] = initialBridgeURL
  if (initialBridgeToken === undefined) Reflect.deleteProperty(process.env, REMOTE_BRIDGE_TOKEN_ENV)
  else process.env[REMOTE_BRIDGE_TOKEN_ENV] = initialBridgeToken
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function marker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-process-owner-'))
  roots.push(root)
  await replaceMarker(root, 'connection-1')
  return root
}

async function replaceMarker(root: string, connectionId: string, generation = 1): Promise<void> {
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 3,
    remoteRoot: '/srv/project',
    connectionId,
    generation,
    mode: 'agent',
  }))
}

async function bridge(handler: (request: BridgeRequest) => Promise<unknown>): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      void handler({ path: request.url ?? '', headers: request.headers, body }).then((payload) => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(payload))
      }, (error: unknown) => {
        response.statusCode = 500
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: { code: String(error) } }))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env[REMOTE_BRIDGE_URL_ENV] = `http://127.0.0.1:${address.port}`
  process.env[REMOTE_BRIDGE_TOKEN_ENV] = 'test-bridge-token-which-is-long-enough'
}

function runningProcess(): Record<string, unknown> {
  return {
    id: 'p'.repeat(32),
    pid: 4321,
    running: true,
    closed: false,
    exitCode: null,
    signal: null,
    stdinClosed: true,
    startedAt: 1,
  }
}

describe('RemoteSubprocessHandle marker ownership', () => {
  it('uses the allocation owner only to clean up after marker replacement', async () => {
    const cwd = await marker()
    const readsStarted = Promise.withResolvers<undefined>()
    const releaseWait = Promise.withResolvers<undefined>()
    const killed = Promise.withResolvers<BridgeRequest>()
    let reads = 0
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/processes/start':
          expect(request.headers['x-coding-remote-connection']).toBe('connection-1')
          return { process: runningProcess() }
        case '/v1/processes/read':
          reads++
          if (reads === 2) readsStarted.resolve(undefined)
          return {
            dataBase64: '', nextOffset: 0, lossy: false, truncated: false, eof: false, closed: false,
            process: runningProcess(),
          }
        case '/v1/processes/wait':
          await releaseWait.promise
          return { completed: false, process: runningProcess() }
        case '/v1/processes/kill':
          killed.resolve(request)
          return { process: runningProcess() }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['remote-command'],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 },
          stderr: { maxBytes: 64 },
        },
        graceMs: 50,
      })
      await readsStarted.promise
      await replaceMarker(cwd, 'connection-2', 2)

      await expect(handle.done).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' })
      const kill = await killed.promise
      expect(kill.headers['x-coding-remote-connection']).toBe('connection-1')
      expect(kill.body).toMatchObject({ root: '/srv/project', id: 'p'.repeat(32), signal: 'SIGKILL' })

      releaseWait.resolve(undefined)
      await expect(handle.waitForExit()).rejects.toMatchObject({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' })
    } finally {
      releaseWait.resolve(undefined)
      await fiber.dispose().catch(() => {})
    }
  })
})
