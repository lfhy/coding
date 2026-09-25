import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as nodePty from 'node-pty'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RemoteWorkspaceError, REMOTE_WORKSPACE_MARKER, remoteWorkspacePath } from '@deepseek-ai/dsh-subprocess'

const initialBridgeURL = process.env.DSH_REMOTE_BRIDGE_URL
const initialBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const roots: string[] = []
const servers: Server[] = []
const DROP_BRIDGE_RESPONSE = Symbol('drop bridge response')

class BridgeRejection extends Error {
  constructor(readonly status: number, readonly bridgeCode: string) {
    super(bridgeCode)
  }
}

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

async function marker(mode: 'agent' | 'basic' = 'agent'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subprocess-remote-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 3,
    remoteRoot: '/srv/project',
    connectionId: 'connection-1',
    generation: 1,
    mode,
  }))
  return root
}

async function bridge(
  handler: (path: string, body: Record<string, unknown>) => unknown,
): Promise<void> {
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
      void Promise.resolve().then(() => handler(request.url ?? '', body)).then((payload) => {
        if (payload === DROP_BRIDGE_RESPONSE) {
          response.destroy()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(payload))
      }, (error: unknown) => {
        response.statusCode = error instanceof BridgeRejection ? error.status : 500
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: {
          code: error instanceof BridgeRejection ? error.bridgeCode : String(error),
        } }))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
}

function processSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p'.repeat(32),
    pid: 4321,
    running: true,
    closed: false,
    exitCode: null,
    signal: null,
    stdinClosed: true,
    startedAt: 1,
    ...overrides,
  }
}

describe('LocalSubprocessRuntime Remote-SSH process routing', () => {
  it.each(['agent', 'basic'] as const)('resolves executables and runs %s process streams on the remote bridge', async (mode) => {
    const cwd = await marker(mode)
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    await bridge((path, body) => {
      expect(body.root).toBe('/srv/project')
      calls.push({ path, body })
      switch (path) {
        case '/v1/processes/resolve':
          expect(body).toMatchObject({ path: '/srv/project', command: 'bash', env: { PATH: '/remote/bin' } })
          return { path: '/remote/bin/bash' }
        case '/v1/processes/start':
          expect(body).toMatchObject({
            path: '/srv/project',
            argv: ['bash', '-c', 'printf remote'],
            stdin: { mode: 'ignore' },
            stdout: { mode: 'collect', maxBytes: 64 },
            stderr: { mode: 'collect', maxBytes: 64 },
          })
          return { process: processSnapshot() }
        case '/v1/processes/read': {
          const stdout = body.stream === 'stdout'
          return {
            dataBase64: stdout ? Buffer.from('remote').toString('base64') : '',
            nextOffset: stdout ? 6 : 0,
            lossy: false,
            truncated: stdout,
            eof: true,
            closed: true,
            process: closed,
          }
        }
        case '/v1/processes/wait':
          return { completed: true, process: closed }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const localSpawn = vi.fn(() => { throw new Error('local process unexpectedly started') })
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    runtime.internals.spawn = localSpawn
    try {
      const target = await remoteWorkspacePath('.', cwd)
      expect(target?.mode).toBe(mode)
      await expect(ctx.subprocess.resolveExecutable('bash', { PATH: '/remote/bin' }, undefined, target)).resolves.toBe('/remote/bin/bash')
      const handle = ctx.subprocess.spawn({
        argv: ['bash', '-c', 'printf remote'],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 },
          stderr: { maxBytes: 64 },
        },
        graceMs: 50,
      })
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(handle.collected.stdout?.readFrom(0)).toEqual({ text: 'remote', nextOffset: 6, lossy: false })
      expect(handle.collected.stderr?.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
      expect(calls.map(call => call.path)).toContain('/v1/processes/start')
      expect(calls.map(call => call.path)).toContain('/v1/processes/wait')
      expect(localSpawn).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it('owns agent remote PTY writes, foreground control, and terminal cleanup', async () => {
    const cwd = await marker('agent')
    const ptySpy = vi.spyOn(nodePty, 'spawn')
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    let terminated = false
    let readCalls = 0
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    await bridge(async (path, body) => {
      expect(body.root).toBe('/srv/project')
      calls.push({ path, body })
      switch (path) {
        case '/v1/terminals/start':
          expect(body).toMatchObject({
            path: '/srv/project', argv: ['bash'], env: { TERM: 'dumb' }, rows: 24, cols: 80, graceMs: 50,
          })
          return { id: 't'.repeat(32), pid: 8765 }
        case '/v1/terminals/read':
          readCalls++
          if (!terminated && readCalls === 1) {
            readStarted.resolve(undefined)
            await releaseRead.promise
          }
          return {
            chunks: [{ sequence: 1, dataBase64: Buffer.from('ready\r\n').toString('base64') }],
            cursor: 1,
            closed: true,
            truncated: false,
            exitCode: 0,
          }
        case '/v1/terminals/write':
          expect(body.dataBase64).toBe(Buffer.from('echo ready\n').toString('base64'))
          return { accepted: true }
        case '/v1/terminals/foreground':
          return { processGroupId: 8765, inputWaiting: false }
        case '/v1/terminals/signal':
          expect(body.signal).toBe('SIGINT')
          return { processGroupId: 8765 }
        case '/v1/terminals/terminate':
          terminated = true
          releaseRead.resolve(undefined)
          return { accepted: true }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const terminal = await ctx.subprocess.spawnTerminal({
        argv: ['bash'], cwd, env: { TERM: 'dumb' }, rows: 24, cols: 80, graceMs: 50,
      })
      const output: Buffer[] = []
      terminal.output.on('data', (chunk: Buffer) => { output.push(Buffer.from(chunk)) })
      await readStarted.promise
      await terminal.write('echo ready\n')
      await expect(terminal.inspectForeground()).resolves.toEqual({ processGroupId: 8765, inputWaiting: false })
      await expect(terminal.signalForeground('SIGINT')).resolves.toBe(8765)
      await terminal.terminate()
      await expect(terminal.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(Buffer.concat(output).toString('utf8')).toBe('ready\r\n')
      expect(calls.map(call => call.path)).toEqual(expect.arrayContaining([
        '/v1/terminals/start',
        '/v1/terminals/read',
        '/v1/terminals/write',
        '/v1/terminals/foreground',
        '/v1/terminals/signal',
        '/v1/terminals/terminate',
      ]))
      expect(ptySpy).not.toHaveBeenCalled()
    } finally {
      ptySpy.mockRestore()
      await fiber.dispose()
    }
  })

  it('preserves direct SSH terminal control and termination uncertainty', async () => {
    const cwd = await marker('basic')
    const ptySpy = vi.spyOn(nodePty, 'spawn')
    const routes: string[] = []
    await bridge((path) => {
      routes.push(path)
      switch (path) {
        case '/v1/terminals/start': return { id: 't'.repeat(32), pid: 8765 }
        case '/v1/terminals/read': return { chunks: [], cursor: 0, closed: false, truncated: false, exitCode: null }
        case '/v1/terminals/write': return { accepted: true }
        case '/v1/terminals/foreground': throw new BridgeRejection(501, 'terminal-foreground-unavailable')
        case '/v1/terminals/signal': throw new BridgeRejection(503, 'terminal-state-unknown')
        case '/v1/terminals/terminate': throw new BridgeRejection(503, 'terminal-state-unknown')
        default: throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['bash'], cwd, cols: 80, rows: 24, graceMs: 50,
    })
    terminal.output.on('error', () => {})
    const doneFailure = terminal.done.catch((error: unknown) => error)
    try {
      await terminal.write('echo ready\n')
      await expect(terminal.inspectForeground()).rejects.toMatchObject({
        code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'terminal-foreground-unavailable',
      })
      await expect(terminal.signalForeground('SIGINT')).rejects.toMatchObject({
        code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'terminal-state-unknown',
      })
      await expect(terminal.terminate()).rejects.toMatchObject({
        code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'terminal-state-unknown',
      })
      await expect(doneFailure).resolves.toMatchObject({
        code: 'REMOTE_BRIDGE_REJECTED', bridgeCode: 'terminal-state-unknown',
      })
      expect(routes).toContain('/v1/terminals/start')
      expect(routes).toContain('/v1/terminals/write')
      expect(routes).toContain('/v1/terminals/terminate')
      expect(ptySpy).not.toHaveBeenCalled()
    } finally {
      ptySpy.mockRestore()
      await fiber.dispose().catch(() => {})
    }
  })

  it('rejects a process stream chunk larger than the requested remote read bound', async () => {
    const cwd = await marker()
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    await bridge((path, body) => {
      switch (path) {
        case '/v1/processes/start': return { process: processSnapshot() }
        case '/v1/processes/read': return {
          dataBase64: Buffer.alloc(64 * 1024 + 1).toString('base64'),
          nextOffset: 64 * 1024 + 1,
          lossy: false,
          truncated: false,
          eof: true,
          closed: true,
          process: closed,
        }
        case '/v1/processes/wait': return { completed: true, process: closed }
        default: throw new Error(`unexpected bridge path ${path} (${JSON.stringify(body)})`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash', '-c', 'printf remote'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 128 * 1024 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toThrow('remote workspace bridge returned an invalid response')
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('rejects unknown fields in successful process allocation and resolution responses', async () => {
    const cwd = await marker()
    await bridge((path) => {
      if (path === '/v1/processes/resolve') return { path: '/remote/bin/bash', unexpected: true }
      if (path === '/v1/processes/start') return { process: processSnapshot(), unexpected: true }
      throw new Error(`unexpected bridge path ${path}`)
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const target = await remoteWorkspacePath('.', cwd)
      expect(target).toBeDefined()
      await expect(ctx.subprocess.resolveExecutable('bash', undefined, undefined, target)).rejects.toThrow(
        'remote workspace bridge returned an invalid response',
      )
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toThrow('remote workspace bridge returned an invalid response')
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('reclaims a process after its dispatched start loses the transport response', async () => {
    const cwd = await marker()
    const starts: Array<{ body: Record<string, unknown> }> = []
    const kills: Array<{ body: Record<string, unknown> }> = []
    await bridge((path, body) => {
      switch (path) {
        case '/v1/processes/start':
          starts.push({ body })
          if (starts.length === 1) return DROP_BRIDGE_RESPONSE
          return { process: processSnapshot() }
        case '/v1/processes/kill':
          kills.push({ body })
          return { process: processSnapshot() }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toBeInstanceOf(RemoteWorkspaceError)

      expect(starts).toHaveLength(2)
      const nonce = starts[0]?.body.startNonce
      expect(nonce).toMatch(/^[a-f0-9]{32}$/u)
      expect(starts[1]?.body).toEqual(starts[0]?.body)
      expect(kills).toHaveLength(1)
      expect(kills[0]?.body).toMatchObject({ root: '/srv/project', id: 'p'.repeat(32), signal: 'SIGKILL' })
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('does not retry an uncertain process start through a replaced marker', async () => {
    const cwd = await marker()
    const starts: Array<{ body: Record<string, unknown> }> = []
    const kills: Array<{ body: Record<string, unknown> }> = []
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/processes/start':
          starts.push({ body })
          await writeFile(join(cwd, REMOTE_WORKSPACE_MARKER), JSON.stringify({
            version: 3, remoteRoot: '/srv/project', connectionId: 'connection-2', generation: 2, mode: 'agent',
          }))
          return DROP_BRIDGE_RESPONSE
        case '/v1/processes/kill':
          kills.push({ body })
          return { process: processSnapshot() }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toBeInstanceOf(RemoteWorkspaceError)
      expect(starts).toHaveLength(1)
      expect(kills).toHaveLength(0)
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('uses a terminal wait snapshot when timeout and process exit race', async () => {
    const cwd = await marker()
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    await bridge((path) => {
      switch (path) {
        case '/v1/processes/start': return { process: processSnapshot() }
        case '/v1/processes/read': return {
          dataBase64: '', nextOffset: 0, lossy: false, truncated: false,
          eof: true, closed: true, process: closed,
        }
        // timeout 触发和 waitLoop 完成之间允许此竞态；Consumer 必须以终态快照
        // 收敛，不能继续发起无限的 wait 请求。
        case '/v1/processes/wait': return { completed: false, process: closed }
        default: throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a closed empty stream page that cannot reach EOF', async () => {
    const cwd = await marker()
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    await bridge((path) => {
      switch (path) {
        case '/v1/processes/start': return { process: processSnapshot() }
        case '/v1/processes/read': return {
          dataBase64: '', nextOffset: 0, lossy: false, truncated: false,
          eof: false, closed: true, process: closed,
        }
        case '/v1/processes/wait': return { completed: true, process: closed }
        case '/v1/processes/kill': return { process: closed }
        default: throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toThrow('remote workspace bridge returned an invalid response')
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('rejects a completed wait response whose snapshot still runs', async () => {
    const cwd = await marker()
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    await bridge((path) => {
      switch (path) {
        case '/v1/processes/start': return { process: processSnapshot() }
        case '/v1/processes/read': return {
          dataBase64: '', nextOffset: 0, lossy: false, truncated: false,
          eof: true, closed: true, process: closed,
        }
        case '/v1/processes/wait': return { completed: true, process: processSnapshot() }
        case '/v1/processes/kill': return { process: processSnapshot() }
        default: throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await expect(handle.done).rejects.toThrow('remote workspace bridge returned an invalid response')
    } finally {
      await fiber.dispose().catch(() => {})
    }
  })

  it('settles a terminated handle when the cleanup bridge hangs', async () => {
    const cwd = await marker()
    const readsStarted = Promise.withResolvers<undefined>()
    const waitStarted = Promise.withResolvers<undefined>()
    const killStarted = Promise.withResolvers<undefined>()
    let reads = 0
    await bridge(async (path) => {
      switch (path) {
        case '/v1/processes/start':
          return { process: processSnapshot() }
        case '/v1/processes/read':
          reads++
          if (reads === 2) readsStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        case '/v1/processes/wait':
          waitStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        case '/v1/processes/kill':
          killStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['bash'], cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
      graceMs: 50,
    })
    const done = handle.done.catch((error: unknown) => error)
    try {
      await Promise.all([readsStarted.promise, waitStarted.promise])

      vi.useFakeTimers()
      try {
        handle.terminate()
        await killStarted.promise
        await vi.advanceTimersByTimeAsync(30_000)

        await expect(done).resolves.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
        await expect(handle.waitForExit()).rejects.toMatchObject({ code: 'REMOTE_BRIDGE_ABORTED' })
      } finally {
        vi.useRealTimers()
      }

      const disposed = fiber.dispose().then(
        () => undefined,
        (error: unknown) => error,
      )
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      const cleanup = fiber.dispose()
      if (cleanup !== undefined) await cleanup.catch(() => {})
    }
  })

  it('restarts cleanup reads and wait after termination aborts ordinary requests', async () => {
    const cwd = await marker()
    const readsStarted = Promise.withResolvers<undefined>()
    const waitStarted = Promise.withResolvers<undefined>()
    const closed = processSnapshot({ running: false, closed: true, exitCode: 0, exitedAt: 2 })
    let reads = 0
    let terminating = false
    await bridge(async (path) => {
      switch (path) {
        case '/v1/processes/start':
          return { process: processSnapshot() }
        case '/v1/processes/read':
          if (terminating) {
            return {
              dataBase64: '', nextOffset: 0, lossy: false, truncated: false,
              eof: true, closed: true, process: closed,
            }
          }
          reads++
          if (reads === 2) readsStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        case '/v1/processes/wait':
          if (terminating) return { completed: true, process: closed }
          waitStarted.resolve(undefined)
          return await new Promise<never>(() => {})
        case '/v1/processes/kill':
          terminating = true
          return { process: processSnapshot() }
        default:
          throw new Error(`unexpected bridge path ${path}`)
      }
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: ['bash'], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
        graceMs: 50,
      })
      await Promise.all([readsStarted.promise, waitStarted.promise])

      handle.terminate()
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(handle.waitForExit()).resolves.toBe(true)
    } finally {
      await fiber.dispose()
    }
  })
})
