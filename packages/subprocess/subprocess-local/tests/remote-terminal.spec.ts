import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteWorkspaceError,
  REMOTE_BRIDGE_TOKEN_ENV,
  REMOTE_BRIDGE_URL_ENV,
  REMOTE_WORKSPACE_MARKER,
  remoteWorkspacePath,
} from '@deepseek-ai/dsh-subprocess'
import { spawnRemoteTerminal } from '../src/remote-terminal.ts'

const initialBridgeURL = process.env[REMOTE_BRIDGE_URL_ENV]
const initialBridgeToken = process.env[REMOTE_BRIDGE_TOKEN_ENV]
const roots: string[] = []
const servers: Server[] = []
const DROP_BRIDGE_RESPONSE = Symbol('drop bridge response')

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

async function marker(connectionId = 'connection-1'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-terminal-'))
  roots.push(root)
  await replaceMarker(root, connectionId)
  return root
}

async function replaceMarker(root: string, connectionId: string, generation = 1): Promise<void> {
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 2,
    remoteRoot: '/srv/project',
    connectionId,
    generation,
  }))
}

async function bridge(handler: (request: BridgeRequest) => Promise<unknown>): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        response.statusCode = 400
        response.end(JSON.stringify({ error: { code: 'invalid-json' } }))
        return
      }
      void handler({ path: request.url ?? '', headers: request.headers, body }).then((payload) => {
        if (payload === DROP_BRIDGE_RESPONSE) {
          response.destroy()
          return
        }
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

function openReadResponse(): Record<string, unknown> {
  return {
    chunks: [],
    cursor: 0,
    closed: false,
    truncated: false,
    exitCode: null,
    signal: null,
  }
}

async function before<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(message)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('RemoteTerminalHandle marker ownership', () => {
  it('uses the allocation owner only to clean up after marker replacement', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const terminations: BridgeRequest[] = []
    let ordinaryCalls = 0
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          expect(request.headers['x-coding-remote-connection']).toBe('connection-1')
          expect(request.body).toMatchObject({ root: '/srv/project', path: '/srv/project' })
          return { id: 't'.repeat(32), pid: 8765 }
        case '/v1/terminals/read':
          readStarted.resolve(undefined)
          await releaseRead.promise
          return openReadResponse()
        case '/v1/terminals/write':
        case '/v1/terminals/resize':
        case '/v1/terminals/foreground':
        case '/v1/terminals/signal':
          ordinaryCalls++
          throw new Error(`unexpected ordinary request: ${request.path}`)
        case '/v1/terminals/terminate':
          terminations.push(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    const terminalFailure = terminal.done.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    await readStarted.promise
    await replaceMarker(root, 'connection-2', 2)

    await expect(terminal.write('echo should-not-reach-old-agent\n')).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_TARGET_INVALID',
    })
    await expect(terminal.resize(100, 30)).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_TARGET_INVALID',
    })
    await expect(terminal.inspectForeground()).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_TARGET_INVALID',
    })
    await expect(terminal.signalForeground('SIGINT')).rejects.toMatchObject({
      code: 'REMOTE_WORKSPACE_TARGET_INVALID',
    })
    expect(ordinaryCalls).toBe(0)

    releaseRead.resolve(undefined)
    await expect(terminalFailure).resolves.toMatchObject({ code: 'REMOTE_WORKSPACE_TARGET_INVALID' })
    await expect(terminal.resize(100, 30)).rejects.toThrow('has exited')
    await terminal.terminate()

    expect(terminations).toHaveLength(1)
    expect(terminations[0]?.headers['x-coding-remote-connection']).toBe('connection-1')
    expect(terminations[0]?.body).toMatchObject({ root: '/srv/project', id: 't'.repeat(32) })
  })

  it('uses the allocation owner for synchronous host-exit cleanup after marker replacement', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const terminated = Promise.withResolvers<BridgeRequest>()
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 'u'.repeat(32), pid: 8766 }
        case '/v1/terminals/read':
          readStarted.resolve(undefined)
          await releaseRead.promise
          return openReadResponse()
        case '/v1/terminals/terminate':
          terminated.resolve(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    await readStarted.promise
    await replaceMarker(root, 'connection-2', 2)

    terminal.terminateForHostExit()
    const request = await terminated.promise
    releaseRead.resolve(undefined)

    expect(request.headers['x-coding-remote-connection']).toBe('connection-1')
    expect(request.body).toMatchObject({ root: '/srv/project', id: 'u'.repeat(32) })
  })
})

describe('RemoteTerminalHandle start idempotency', () => {
  it('reclaims a terminal after its dispatched start loses the transport response', async () => {
    const root = await marker()
    const starts: BridgeRequest[] = []
    const terminations: BridgeRequest[] = []
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          starts.push(request)
          if (starts.length === 1) return DROP_BRIDGE_RESPONSE
          return { id: 'n'.repeat(32), pid: 8768 }
        case '/v1/terminals/terminate':
          terminations.push(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')

    await expect(spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })).rejects.toBeInstanceOf(RemoteWorkspaceError)

    expect(starts).toHaveLength(2)
    const nonce = starts[0]?.body.startNonce
    expect(nonce).toMatch(/^[a-f0-9]{32}$/u)
    expect(starts[1]?.body).toEqual(starts[0]?.body)
    expect(terminations).toHaveLength(1)
    expect(terminations[0]?.headers['x-coding-remote-connection']).toBe('connection-1')
    expect(terminations[0]?.body).toMatchObject({ root: '/srv/project', id: 'n'.repeat(32) })
  })

  it('does not retry a lost start through an owner after marker replacement', async () => {
    const root = await marker()
    const starts: BridgeRequest[] = []
    const terminations: BridgeRequest[] = []
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          starts.push(request)
          await replaceMarker(root, 'connection-2', 2)
          return DROP_BRIDGE_RESPONSE
        case '/v1/terminals/terminate':
          terminations.push(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')

    await expect(spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })).rejects.toBeInstanceOf(RemoteWorkspaceError)

    expect(starts).toHaveLength(1)
    expect(terminations).toHaveLength(0)
  })
})

describe('RemoteTerminalHandle resize', () => {
  it('validates dimensions, forwards accepted sizes, and preserves remote rejection', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const resizeRequests: BridgeRequest[] = []
    let terminated = false
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 'r'.repeat(32), pid: 8770 }
        case '/v1/terminals/read':
          readStarted.resolve(undefined)
          await releaseRead.promise
          return terminated ? { ...openReadResponse(), closed: true, exitCode: 0 } : openReadResponse()
        case '/v1/terminals/resize':
          resizeRequests.push(request)
          if (request.body.cols === 99) throw new Error('resize rejected')
          return { accepted: true }
        case '/v1/terminals/terminate':
          terminated = true
          releaseRead.resolve(undefined)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    await readStarted.promise

    await expect(terminal.resize(100, 30)).resolves.toBeUndefined()
    expect(resizeRequests[0]?.body).toMatchObject({
      root: '/srv/project', id: 'r'.repeat(32), cols: 100, rows: 30,
    })
    for (const [cols, rows] of [[1, 24], [80, 0], [1_001, 24], [80, 1_001], [80.5, 24]] as const) {
      await expect(terminal.resize(cols, rows)).rejects.toThrow('terminal size requires integer cols')
    }
    expect(resizeRequests).toHaveLength(1)
    await expect(terminal.resize(99, 30)).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_REJECTED' })
    expect(resizeRequests).toHaveLength(2)

    await terminal.terminate()
    await expect(terminal.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(terminal.resize(80, 24)).rejects.toThrow('has exited')
  })

  it('aborts and drains an in-flight resize before termination settles', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseFirstRead = Promise.withResolvers<undefined>()
    const resizeStarted = Promise.withResolvers<undefined>()
    const releaseResize = Promise.withResolvers<undefined>()
    const terminated = Promise.withResolvers<BridgeRequest>()
    let reads = 0
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 's'.repeat(32), pid: 8771 }
        case '/v1/terminals/read':
          reads++
          if (reads === 1) {
            readStarted.resolve(undefined)
            await releaseFirstRead.promise
            return openReadResponse()
          }
          return { ...openReadResponse(), closed: true, exitCode: 0 }
        case '/v1/terminals/resize':
          resizeStarted.resolve(undefined)
          await releaseResize.promise
          return { accepted: true }
        case '/v1/terminals/terminate':
          terminated.resolve(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    await readStarted.promise
    let resizeSettled = false
    const resizing = terminal.resize(120, 40).finally(() => { resizeSettled = true })
    void resizing.catch(() => {})
    await resizeStarted.promise

    const closing = terminal.terminate()
    const termination = await before(terminated.promise, 1_000, 'terminate did not reach the remote agent')
    expect(termination.body).toMatchObject({ root: '/srv/project', id: 's'.repeat(32) })
    await closing
    expect(resizeSettled).toBe(true)
    await expect(resizing).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })

    releaseFirstRead.resolve(undefined)
    releaseResize.resolve(undefined)
  })
})

describe('RemoteTerminalHandle transport bounds', () => {
  it('does not let a hanging write block termination', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const writeStarted = Promise.withResolvers<undefined>()
    const terminated = Promise.withResolvers<BridgeRequest>()
    const releaseFirstRead = Promise.withResolvers<undefined>()
    const releaseWrite = Promise.withResolvers<undefined>()
    let reads = 0
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 'v'.repeat(32), pid: 8767 }
        case '/v1/terminals/read':
          reads++
          if (reads === 1) {
            readStarted.resolve(undefined)
            await releaseFirstRead.promise
            return openReadResponse()
          }
          return { ...openReadResponse(), closed: true, exitCode: 0 }
        case '/v1/terminals/write':
          writeStarted.resolve(undefined)
          await releaseWrite.promise
          return { accepted: true }
        case '/v1/terminals/terminate':
          terminated.resolve(request)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    const done = terminal.done
    await readStarted.promise
    const writing = terminal.write('echo pending\n')
    // terminate 会主动中止这项请求；先挂上观察器，避免它在断言前成为未处理拒绝。
    void writing.catch(() => {})
    await writeStarted.promise

    const closing = terminal.terminate()
    const termination = await before(terminated.promise, 1_000, 'terminate did not reach the remote agent')
    expect(termination.body).toMatchObject({ root: '/srv/project', id: 'v'.repeat(32) })
    await closing
    await expect(writing).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
    await expect(done).resolves.toEqual({ exitCode: 0, signal: null })

    releaseFirstRead.resolve(undefined)
    releaseWrite.resolve(undefined)
  })

  it('rejects a hanging cleanup request and settles done', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const terminateStarted = Promise.withResolvers<undefined>()
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 'w'.repeat(32), pid: 8768 }
        case '/v1/terminals/read':
          readStarted.resolve(undefined)
          await releaseRead.promise
          return openReadResponse()
        case '/v1/terminals/terminate':
          terminateStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    const done = terminal.done.catch((error: unknown) => error)
    await readStarted.promise

    vi.useFakeTimers()
    try {
      const closing = terminal.terminate().then(
        () => undefined,
        (error: unknown) => error,
      )
      await terminateStarted.promise
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(closing).resolves.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
      await expect(done).resolves.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
    } finally {
      vi.useRealTimers()
      releaseRead.resolve(undefined)
    }
  })

  it('settles done when the final cleanup read hangs', async () => {
    const root = await marker()
    const readStarted = Promise.withResolvers<undefined>()
    const releaseFirstRead = Promise.withResolvers<undefined>()
    const finalReadStarted = Promise.withResolvers<undefined>()
    let reads = 0
    await bridge(async (request) => {
      switch (request.path) {
        case '/v1/terminals/start':
          return { id: 'x'.repeat(32), pid: 8769 }
        case '/v1/terminals/read':
          reads++
          if (reads === 1) {
            readStarted.resolve(undefined)
            await releaseFirstRead.promise
            return openReadResponse()
          }
          finalReadStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        case '/v1/terminals/terminate':
          releaseFirstRead.resolve(undefined)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path: ${request.path}`)
      }
    })
    const target = await remoteWorkspacePath('.', root)
    if (target === undefined) throw new Error('remote marker was not discovered')
    const terminal = await spawnRemoteTerminal(target, {
      argv: ['sh'], cwd: root, rows: 24, cols: 80, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    const done = terminal.done.catch((error: unknown) => error)
    await readStarted.promise

    vi.useFakeTimers()
    try {
      const closing = terminal.terminate()
      await finalReadStarted.promise
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(closing).resolves.toBeUndefined()
      await expect(done).resolves.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
    } finally {
      vi.useRealTimers()
      releaseFirstRead.resolve(undefined)
    }
  })
})
