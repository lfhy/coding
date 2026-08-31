import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'

const initialBridgeURL = process.env.DSH_REMOTE_BRIDGE_URL
const initialBridgeToken = process.env.DSH_REMOTE_BRIDGE_TOKEN
const roots: string[] = []
const servers: Server[] = []
const DROP_BRIDGE_RESPONSE = Symbol('drop bridge response')

afterEach(async () => {
  if (initialBridgeURL === undefined) delete process.env.DSH_REMOTE_BRIDGE_URL
  else process.env.DSH_REMOTE_BRIDGE_URL = initialBridgeURL
  if (initialBridgeToken === undefined) delete process.env.DSH_REMOTE_BRIDGE_TOKEN
  else process.env.DSH_REMOTE_BRIDGE_TOKEN = initialBridgeToken
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    // 故意悬挂的长轮询在客户端中止后不能继续占用测试 HTTP 连接。
    server.closeAllConnections()
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function marker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-code-'))
  roots.push(root)
  await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 2,
    remoteRoot: '/srv/project',
    connectionId: 'connection-1',
    generation: 1,
  }))
  return root
}

async function bridge(
  handler: (path: string, body: Record<string, unknown>, connectionId: string | undefined) => unknown,
): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const connection = request.headers['x-coding-remote-connection']
      const connectionId = typeof connection === 'string' ? connection : undefined
      void Promise.resolve(handler(request.url ?? '', body, connectionId)).then((payload) => {
        if (payload === DROP_BRIDGE_RESPONSE) {
          response.destroy()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(payload))
      }).catch(() => { response.destroy() })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
}

describe('WorkerThreadCodeRuntime Remote-SSH routing', () => {
  it('runs Goja remotely while host bindings remain on the local Host', async () => {
    const cwd = await marker()
    const replied = Promise.withResolvers<Record<string, unknown>>()
    await bridge(async (path, body) => {
      expect(body.root).toBe('/srv/project')
      switch (path) {
        case '/v1/code/start':
          expect(body.program).toBe('return await tools.echo({ value: 7 })')
          expect(body.computeMs).toBe(137)
          expect(body.memoryLimitBytes).toBe(2 * 1024 * 1024 * 1024)
          expect(body.startNonce).toMatch(/^[a-f0-9]{32}$/u)
          expect(body.namespaces).toEqual([{
            global: 'tools', names: ['echo'], errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
          }])
          return { id: 'a'.repeat(32) }
        case '/v1/code/next':
          if (body.after === 0) {
            return {
              events: [{
                type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'echo', arguments: { value: 7 },
              }],
              cursor: 1,
              done: false,
            }
          }
          await replied.promise
          return {
            events: [{ type: 'done', sequence: 2, value: { echoed: 7 }, logs: ['remote console'] }],
            cursor: 2,
            done: true,
          }
        case '/v1/code/reply':
          replied.resolve(body)
          return { accepted: true }
        default:
          throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { computeMs: 137, maxOldGenerationSizeMb: 2_048 })
      const result = await ctx.codeRuntime.run({
        program: 'return await tools.echo({ value: 7 })',
        cwd,
        bindings: [{
          global: 'tools',
          functions: { echo: async value => ({ echoed: (value as { value: number }).value }) },
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }],
      })
      expect(await replied.promise).toMatchObject({ id: 'a'.repeat(32), callId: 1, ok: true, value: { echoed: 7 } })
      expect(result).toEqual({ value: { echoed: 7 }, logs: ['remote console'] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('等待远端终态确认后才结算调用方取消', async () => {
    const cwd = await marker()
    const canceled = Promise.withResolvers<undefined>()
    const releaseCancel = Promise.withResolvers<undefined>()
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/code/start': return { id: 'b'.repeat(32) }
        case '/v1/code/next': return await new Promise(() => {})
        case '/v1/code/cancel':
          expect(body.id).toBe('b'.repeat(32))
          canceled.resolve(undefined)
          // bridge 的 accepted 代表 Go agent 已得到 CodeRun 的终态；在它以前
          // Node Host 不能把 run()/dispose 当作已经静默。
          await releaseCancel.promise
          return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const controller = new AbortController()
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({ program: 'await tools.never({})', cwd, bindings: [], signal: controller.signal })
      let settled = false
      void running.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      controller.abort('user canceled remote code')
      await canceled.promise
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseCancel.resolve(undefined)
      await expect(running).resolves.toEqual({ logs: [], error: { kind: 'abort', message: 'user canceled remote code' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('provider dispose 同样等待远端终态确认', async () => {
    const cwd = await marker()
    const canceled = Promise.withResolvers<undefined>()
    const releaseCancel = Promise.withResolvers<undefined>()
    await bridge(async (path) => {
      switch (path) {
        case '/v1/code/start': return { id: 'd'.repeat(32) }
        case '/v1/code/next': return await new Promise(() => {})
        case '/v1/code/cancel':
          canceled.resolve(undefined)
          await releaseCancel.promise
          return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      const fiber = await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({ program: 'await new Promise(() => {})', cwd, bindings: [] })
      await new Promise(resolve => setTimeout(resolve, 20))
      let disposed = false
      const disposing = fiber.dispose().then(() => { disposed = true })
      await canceled.promise
      await Promise.resolve()
      expect(disposed).toBe(false)
      releaseCancel.resolve(undefined)
      await disposing
      await expect(running).resolves.toEqual({ logs: [], error: { kind: 'abort', message: 'runtime disposed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('丢失 start 响应后以同一 nonce 找回会话并终止', async () => {
    const cwd = await marker()
    const firstStart = Promise.withResolvers<undefined>()
    const dropFirstResponse = Promise.withResolvers<undefined>()
    const canceled = Promise.withResolvers<undefined>()
    const startBodies: Record<string, unknown>[] = []
    const paths: string[] = []
    await bridge(async (path, body) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start':
          startBodies.push(body)
          if (startBodies.length === 1) {
            firstStart.resolve(undefined)
            await dropFirstResponse.promise
            return DROP_BRIDGE_RESPONSE
          }
          return { id: '9'.repeat(32) }
        case '/v1/code/cancel':
          expect(body.id).toBe('9'.repeat(32))
          canceled.resolve(undefined)
          return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const controller = new AbortController()
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { maxWallMs: 500 })
      const running = ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [], signal: controller.signal })
      await firstStart.promise
      controller.abort('cancel after start response loss')
      dropFirstResponse.resolve(undefined)
      await canceled.promise
      await expect(running).resolves.toEqual({
        logs: [], error: { kind: 'abort', message: 'cancel after start response loss' },
      })
      expect(startBodies).toHaveLength(2)
      expect(startBodies[0]!.startNonce).toMatch(/^[a-f0-9]{32}$/u)
      expect(startBodies[1]!.startNonce).toBe(startBodies[0]!.startNonce)
      expect(paths).toEqual(['/v1/code/start', '/v1/code/start', '/v1/code/cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('以本机 OutputLedger 复核远端权威终态日志', async () => {
    const cwd = await marker()
    const paths: string[] = []
    await bridge((path) => {
      paths.push(path)
      if (path === '/v1/code/start') return { id: '1'.repeat(32) }
      if (path === '/v1/code/next') {
        return {
          events: [{ type: 'done', sequence: 1, logs: ['远端输出'.repeat(40)], value: { ok: true } }],
          cursor: 1,
          done: true,
        }
      }
      throw new Error(`unexpected route ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { maxOutputBytes: 64 })
      const result = await ctx.codeRuntime.run({ program: 'return { ok: true }', cwd, bindings: [] })
      expect(result.error?.kind).toBe('output-limit')
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8') + Buffer.byteLength(JSON.stringify(result.error?.message), 'utf8')).toBeLessThanOrEqual(64)
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('只以 done.logs 结算输出，不与流式日志重复计费', async () => {
    const cwd = await marker()
    const log = 'x'.repeat(29)
    await bridge((path, body) => {
      if (path === '/v1/code/start') return { id: '4'.repeat(32) }
      if (path === '/v1/code/next' && body.after === 0) {
        return { events: [{ type: 'log', sequence: 1, level: 'info', text: log }], cursor: 1, done: false }
      }
      if (path === '/v1/code/next' && body.after === 1) {
        return { events: [{ type: 'done', sequence: 2, logs: [log] }], cursor: 2, done: true }
      }
      throw new Error(`unexpected route ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { maxOutputBytes: 64 })
      await expect(ctx.codeRuntime.run({ program: 'console.log("x"); return', cwd, bindings: [] })).resolves.toEqual({ logs: [log] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('拒绝异常终态与同批次的 decoy binding 并存', async () => {
    const cwd = await marker()
    const paths: string[] = []
    let calls = 0
    await bridge(async (path) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start': return { id: '5'.repeat(32) }
        case '/v1/code/next':
          return {
            events: [
              { type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'slow', arguments: {} },
              { type: 'done', sequence: 2, logs: [], error: { kind: 'exception', message: 'program failed' } },
            ],
            cursor: 2,
            done: true,
          }
        case '/v1/code/cancel': return { accepted: true }
        case '/v1/code/reply': throw new Error('same-batch decoy binding must not be called')
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      await expect(ctx.codeRuntime.run({
        program: 'void tools.slow({}); throw new Error("program failed")', cwd,
        bindings: [{ global: 'tools', functions: { slow: async () => { calls += 1; return null } } }],
      })).resolves.toEqual({ logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' } })
      expect(calls).toBe(0)
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('拒绝成功终态与同批次的 decoy binding 并存', async () => {
    const cwd = await marker()
    const paths: string[] = []
    let calls = 0
    await bridge(async (path) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start': return { id: '8'.repeat(32) }
        case '/v1/code/next':
          return {
            events: [
              { type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'slow', arguments: {} },
              { type: 'done', sequence: 2, logs: [], value: null },
            ],
            cursor: 2,
            done: true,
          }
        case '/v1/code/cancel': return { accepted: true }
        case '/v1/code/reply': throw new Error('same-batch decoy binding must not be called')
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      await expect(ctx.codeRuntime.run({
        program: 'void tools.slow({}); return', cwd,
        bindings: [{ global: 'tools', functions: { slow: async () => { calls += 1; return null } } }],
      })).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
      expect(calls).toBe(0)
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('异常终态会拒绝并清理已在本机执行的 pending binding', async () => {
    const cwd = await marker()
    const bindingStarted = Promise.withResolvers<undefined>()
    const releaseBinding = Promise.withResolvers<null>()
    let replies = 0
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/code/start': return { id: '6'.repeat(32) }
        case '/v1/code/next': {
          if (body.after === 0) {
            return {
              events: [{ type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'slow', arguments: {} }],
              cursor: 1,
              done: false,
            }
          }
          return {
            events: [{ type: 'done', sequence: 2, logs: [], error: { kind: 'exception', message: 'program failed' } }],
            cursor: 2,
            done: true,
          }
        }
        case '/v1/code/reply':
          replies += 1
          return { accepted: true }
        case '/v1/code/cancel': return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({
        program: 'return await tools.slow({})', cwd,
        bindings: [{ global: 'tools', functions: {
          slow: async () => {
            bindingStarted.resolve(undefined)
            return await releaseBinding.promise
          },
        } }],
      })
      await bindingStarted.promise
      await expect(running).resolves.toEqual({ logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' } })
      releaseBinding.resolve(null)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(replies).toBe(0)
    } finally {
      releaseBinding.resolve(null)
      await ctx.fiber.dispose()
    }
  })

  it('timeout 终态会清理已在本机执行的 pending binding', async () => {
    const cwd = await marker()
    const bindingStarted = Promise.withResolvers<undefined>()
    const releaseBinding = Promise.withResolvers<null>()
    const bindingFinished = Promise.withResolvers<undefined>()
    const paths: string[] = []
    let replies = 0
    await bridge(async (path, body) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start': return { id: '9'.repeat(32) }
        case '/v1/code/next': {
          if (body.after === 0) {
            return {
              events: [{ type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'slow', arguments: {} }],
              cursor: 1,
              done: false,
            }
          }
          await bindingStarted.promise
          return {
            events: [{ type: 'done', sequence: 2, logs: [], error: { kind: 'timeout', message: 'remote wall clock expired' } }],
            cursor: 2,
            done: true,
          }
        }
        case '/v1/code/reply':
          replies += 1
          return { accepted: true }
        case '/v1/code/cancel': throw new Error('a confirmed timeout terminal must not be canceled again')
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({
        program: 'return await tools.slow({})', cwd,
        bindings: [{ global: 'tools', functions: {
          slow: async () => {
            bindingStarted.resolve(undefined)
            const value = await releaseBinding.promise
            bindingFinished.resolve(undefined)
            return value
          },
        } }],
      })
      await expect(running).resolves.toEqual({
        logs: [], error: { kind: 'timeout', message: 'remote wall clock expired' },
      })
      releaseBinding.resolve(null)
      await bindingFinished.promise
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(replies).toBe(0)
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/next'])
    } finally {
      releaseBinding.resolve(null)
      await ctx.fiber.dispose()
    }
  })

  it('在执行本机 binding 前拒绝重复或超额的远端调用', async () => {
    const scenarios = [
      {
        name: 'duplicate call id',
        events: [
          { type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'echo', arguments: {} },
          { type: 'tool_call', sequence: 2, callId: 1, global: 'tools', name: 'echo', arguments: {} },
        ],
      },
      {
        name: 'more than 128 pending bindings',
        events: Array.from({ length: 129 }, (_, index) => ({
          type: 'tool_call', sequence: index + 1, callId: index + 1, global: 'tools', name: 'echo', arguments: {},
        })),
      },
    ] as const
    for (const scenario of scenarios) {
      const cwd = await marker()
      const paths: string[] = []
      let calls = 0
      await bridge((path) => {
        paths.push(path)
        if (path === '/v1/code/start') return { id: '2'.repeat(32) }
        if (path === '/v1/code/next') return { events: scenario.events, cursor: scenario.events.length, done: false }
        if (path === '/v1/code/cancel') return { accepted: true }
        throw new Error(`unexpected route for ${scenario.name}: ${path}`)
      })
      const ctx = new Context()
      try {
        await ctx.plugin(WorkerThreadCodeRuntime, {})
        await expect(ctx.codeRuntime.run({
          program: 'return await tools.echo({})', cwd,
          bindings: [{ global: 'tools', functions: { echo: async () => { calls += 1; return null } } }],
        })).resolves.toEqual({
          logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
        })
        expect(calls).toBe(0)
        expect(paths, scenario.name).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('允许已逐个结算的远端 binding 超过 pending 窗口', async () => {
    const cwd = await marker()
    const count = 257
    const replies = Array.from({ length: count }, () => Promise.withResolvers<undefined>())
    const seenReplies: number[] = []
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/code/start': return { id: '7'.repeat(32) }
        case '/v1/code/next': {
          const after = body.after
          if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after > count) {
            throw new Error(`unexpected cursor ${String(after)}`)
          }
          if (after > 0) {
            await replies[after - 1]!.promise
            // `/reply` 的 HTTP 响应是 client 从 pending 集合移除的边界；下一
            // 个 tool_call 必须在这一步之后到达，才能表示真正的顺序调用。
            await new Promise(resolve => setTimeout(resolve, 0))
          }
          if (after === count) {
            return {
              events: [{ type: 'done', sequence: count + 1, logs: [], value: count }],
              cursor: count + 1,
              done: true,
            }
          }
          return {
            events: [{
              type: 'tool_call', sequence: after + 1, callId: after + 1,
              global: 'tools', name: 'echo', arguments: { value: after + 1 },
            }],
            cursor: after + 1,
            done: false,
          }
        }
        case '/v1/code/reply': {
          const callId = body.callId
          if (typeof callId !== 'number' || !Number.isSafeInteger(callId) || callId < 1 || callId > count) {
            throw new Error(`unexpected call id ${String(callId)}`)
          }
          expect(body).toMatchObject({ id: '7'.repeat(32), ok: true, value: { value: callId } })
          seenReplies.push(callId)
          replies[callId - 1]!.resolve(undefined)
          return { accepted: true }
        }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      await expect(ctx.codeRuntime.run({
        program: 'for (let i = 1; i <= 257; i++) await tools.echo({ value: i }); return 257',
        cwd,
        bindings: [{ global: 'tools', functions: { echo: async value => value as CodeJsonValue } }],
      })).resolves.toEqual({ logs: [], value: count })
      expect(seenReplies).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('取消后不等待或回传已脱离的本机 binding', async () => {
    const cwd = await marker()
    const bindingStarted = Promise.withResolvers<undefined>()
    const releaseBinding = Promise.withResolvers<null>()
    const bindingFinished = Promise.withResolvers<undefined>()
    let replies = 0
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/code/start': return { id: '3'.repeat(32) }
        case '/v1/code/next':
          if (body.after === 0) {
            return {
              events: [{ type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'slow', arguments: {} }],
              cursor: 1,
              done: false,
            }
          }
          return await new Promise(() => {})
        case '/v1/code/reply':
          replies += 1
          return { accepted: true }
        case '/v1/code/cancel': return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const controller = new AbortController()
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({
        program: 'return await tools.slow({})', cwd, signal: controller.signal,
        bindings: [{ global: 'tools', functions: {
          slow: async () => {
            bindingStarted.resolve(undefined)
            const value = await releaseBinding.promise
            bindingFinished.resolve(undefined)
            return value
          },
        } }],
      })
      await bindingStarted.promise
      controller.abort('stop without waiting for binding')
      await expect(running).resolves.toEqual({
        logs: [], error: { kind: 'abort', message: 'stop without waiting for binding' },
      })
      releaseBinding.resolve(null)
      await bindingFinished.promise
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(replies).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects malformed remote code polling responses before they affect a local run', async () => {
    const malformed = [
      {
        name: 'extra response field',
        response: { events: [], cursor: 0, done: false, extra: true },
      },
      {
        name: 'extra event field',
        response: {
          events: [{ type: 'done', sequence: 1, value: 1, logs: [], extra: true }], cursor: 1, done: true,
        },
      },
      {
        name: 'sequence gap',
        response: {
          events: [{ type: 'done', sequence: 2, value: 1, logs: [] }], cursor: 2, done: true,
        },
      },
      {
        name: 'cursor beyond the final event',
        response: {
          events: [{ type: 'done', sequence: 1, value: 1, logs: [] }], cursor: 2, done: true,
        },
      },
      {
        name: 'done without a final event',
        response: { events: [], cursor: 0, done: true },
      },
      {
        name: 'done event in a nonterminal response',
        response: {
          events: [{ type: 'done', sequence: 1, value: 1, logs: [] }], cursor: 1, done: false,
        },
      },
      {
        name: 'terminal value and error together',
        response: {
          events: [{
            type: 'done', sequence: 1, value: 1, logs: [], error: { kind: 'exception', message: 'bad' },
          }], cursor: 1, done: true,
        },
      },
      {
        name: 'extra error field',
        response: {
          events: [{
            type: 'done', sequence: 1, logs: [], error: { kind: 'exception', message: 'bad', extra: true },
          }], cursor: 1, done: true,
        },
      },
    ] as const

    for (const payload of malformed) {
      const cwd = await marker()
      const paths: string[] = []
      await bridge((path) => {
        paths.push(path)
        if (path === '/v1/code/start') return { id: 'c'.repeat(32) }
        if (path === '/v1/code/next') return payload.response
        if (path === '/v1/code/cancel') return { accepted: true }
        throw new Error(`unexpected route for ${payload.name}: ${path}`)
      })
      const ctx = new Context()
      try {
        await ctx.plugin(WorkerThreadCodeRuntime, {})
        await expect(ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [] })).resolves.toEqual({
          logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
        })
        expect(paths, payload.name).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('rejects extra fields on code start and binding acknowledgement responses', async () => {
    const startCwd = await marker()
    await bridge((path) => {
      if (path === '/v1/code/start') return { id: 'd'.repeat(32), extra: true }
      throw new Error(`unexpected route ${path}`)
    })
    const startCtx = new Context()
    try {
      await startCtx.plugin(WorkerThreadCodeRuntime, {})
      await expect(startCtx.codeRuntime.run({ program: 'return 1', cwd: startCwd, bindings: [] })).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
    } finally {
      await startCtx.fiber.dispose()
    }

    const replyCwd = await marker()
    const replyReceived = Promise.withResolvers<undefined>()
    await bridge(async (path, body) => {
      switch (path) {
        case '/v1/code/start': return { id: 'e'.repeat(32) }
        case '/v1/code/next':
          if (body.after === 0) {
            return {
              events: [{ type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'echo', arguments: {} }],
              cursor: 1,
              done: false,
            }
          }
          await replyReceived.promise
          return await new Promise(() => {})
        case '/v1/code/reply':
          replyReceived.resolve(undefined)
          return { accepted: true, extra: true }
        case '/v1/code/cancel': return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const replyCtx = new Context()
    try {
      await replyCtx.plugin(WorkerThreadCodeRuntime, {})
      await expect(replyCtx.codeRuntime.run({
        program: 'return await tools.echo({})', cwd: replyCwd,
        bindings: [{ global: 'tools', functions: { echo: async () => null } }],
      })).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
    } finally {
      await replyCtx.fiber.dispose()
    }
  })

  it('marker 重绑后只用旧 owner 清理已发布会话', async () => {
    const cwd = await marker()
    const calls: Array<{ path: string; connectionId: string | undefined }> = []
    await bridge(async (path, body, connectionId) => {
      calls.push({ path, connectionId })
      if (path === '/v1/code/start') {
        expect(connectionId).toBe('connection-1')
        await writeFile(join(cwd, REMOTE_WORKSPACE_MARKER), JSON.stringify({
          version: 2, remoteRoot: '/srv/project', connectionId: 'connection-2', generation: 2,
        }))
        return { id: 'f'.repeat(32) }
      }
      if (path === '/v1/code/cancel') {
        expect(connectionId).toBe('connection-1')
        expect(body.id).toBe('f'.repeat(32))
        return { accepted: true }
      }
      throw new Error(`marker-rebound session dispatched ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      await expect(ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [] })).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
      expect(calls).toEqual([
        { path: '/v1/code/start', connectionId: 'connection-1' },
        { path: '/v1/code/cancel', connectionId: 'connection-1' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('marker 重绑后不会发送 binding reply，并由旧 owner 清理会话', async () => {
    const cwd = await marker()
    const paths: string[] = []
    await bridge(async (path, body, connectionId) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start':
          expect(connectionId).toBe('connection-1')
          return { id: 'f'.repeat(32) }
        case '/v1/code/next':
          expect(connectionId).toBe('connection-1')
          expect(body.after).toBe(0)
          await writeFile(join(cwd, REMOTE_WORKSPACE_MARKER), JSON.stringify({
            version: 2, remoteRoot: '/srv/project', connectionId: 'connection-2', generation: 2,
          }))
          return {
            events: [{ type: 'tool_call', sequence: 1, callId: 1, global: 'tools', name: 'echo', arguments: {} }],
            cursor: 1,
            done: false,
          }
        case '/v1/code/cancel':
          // marker 已指向 connection-2；已发布 session 的 owner 只可用于清理。
          expect(connectionId).toBe('connection-1')
          expect(body.id).toBe('f'.repeat(32))
          return { accepted: true }
        case '/v1/code/reply': throw new Error('binding reply must not target either marker-rebound connection')
        default: throw new Error(`marker-rebound session dispatched ${path}`)
      }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      await expect(ctx.codeRuntime.run({
        program: 'return await tools.echo({})', cwd,
        bindings: [{ global: 'tools', functions: { echo: async () => null } }],
      })).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('调用方取消已发布会话时可用 owner 连接补偿终止', async () => {
    const cwd = await marker()
    const paths: string[] = []
    const polling = Promise.withResolvers<undefined>()
    await bridge(async (path, body, connectionId) => {
      paths.push(path)
      switch (path) {
        case '/v1/code/start':
          expect(connectionId).toBe('connection-1')
          return { id: 'f'.repeat(32) }
        case '/v1/code/next':
          expect(connectionId).toBe('connection-1')
          expect(body.after).toBe(0)
          await writeFile(join(cwd, REMOTE_WORKSPACE_MARKER), JSON.stringify({
            version: 2, remoteRoot: '/srv/project', connectionId: 'connection-2', generation: 2,
          }))
          polling.resolve(undefined)
          return await new Promise(() => {})
        case '/v1/code/cancel':
          // marker 已切向 connection-2；只有已确认创建的 session 才能用 owner
          // identity 回到 connection-1 补偿清理，普通 next/reply 不得这样回退。
          expect(connectionId).toBe('connection-1')
          expect(body.id).toBe('f'.repeat(32))
          return { accepted: true }
        default: throw new Error(`unexpected route ${path}`)
      }
    })
    const controller = new AbortController()
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, {})
      const running = ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [], signal: controller.signal })
      await polling.promise
      controller.abort('connection changed')
      await expect(running).resolves.toEqual({ logs: [], error: { kind: 'abort', message: 'connection changed' } })
      expect(paths).toEqual(['/v1/code/start', '/v1/code/next', '/v1/code/cancel'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('未确认 start 成功时，取消绝不回退到 owner 连接', async () => {
    const cwd = await marker()
    const started = Promise.withResolvers<undefined>()
    const paths: string[] = []
    await bridge(async (path) => {
      paths.push(path)
      if (path === '/v1/code/start') {
        started.resolve(undefined)
        return await new Promise(() => {})
      }
      throw new Error(`unexpected route ${path}`)
    })
    const controller = new AbortController()
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { maxWallMs: 50 })
      const running = ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [], signal: controller.signal })
      await started.promise
      await writeFile(join(cwd, REMOTE_WORKSPACE_MARKER), JSON.stringify({
        version: 2, remoteRoot: '/srv/project', connectionId: 'connection-2', generation: 2,
      }))
      controller.abort('start response was never confirmed')
      await expect(running).resolves.toEqual({
        logs: [], error: { kind: 'abort', message: 'start response was never confirmed' },
      })
      expect(paths).toEqual(['/v1/code/start'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('start 未获明确响应时在本机 deadline 内 fail-closed', async () => {
    const cwd = await marker()
    const started = Promise.withResolvers<undefined>()
    const paths: string[] = []
    await bridge(async (path) => {
      paths.push(path)
      if (path === '/v1/code/start') {
        started.resolve(undefined)
        return await new Promise(() => {})
      }
      throw new Error(`unexpected route ${path}`)
    })
    const ctx = new Context()
    try {
      await ctx.plugin(WorkerThreadCodeRuntime, { maxWallMs: 50 })
      const running = ctx.codeRuntime.run({ program: 'return 1', cwd, bindings: [] })
      await started.promise
      await expect(running).resolves.toEqual({
        logs: [], error: { kind: 'worker-exit', message: 'remote code runtime became unavailable' },
      })
      expect(paths).toEqual(['/v1/code/start'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
