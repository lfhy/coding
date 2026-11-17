import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from 'coding-llm'
import SystemPrompt, { renderContextSnapshot } from 'coding-system-prompt'
import { REMOTE_WORKSPACE_MARKER, SubprocessRuntime } from 'coding-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from 'coding-subprocess'
import ToolRuntime from 'coding-tools'
import * as ToolFsSearch from 'coding-tool-fs-search'

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

/** A local subprocess would mean remote marker routing was bypassed. */
class NeverSpawnSubprocess extends SubprocessRuntime {
  readonly spawns: SubprocessSpawnSpec[] = []

  override async resolveExecutable(command: string): Promise<string> {
    return command
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    throw new Error('remote search unexpectedly started a local subprocess')
  }

  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('search never allocates a terminal')
  }
}

async function marker(mode: 'basic' | 'agent' = 'agent'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-remote-'))
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

interface BridgeReply {
  status?: number
  payload: unknown
}

async function bridge(handler: (path: string, body: Record<string, unknown>) => BridgeReply): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const reply = handler(request.url ?? '', body)
      response.setHeader('Content-Type', 'application/json')
      response.statusCode = reply.status ?? 200
      response.end(JSON.stringify(reply.payload))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
  process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-fs-search Remote-SSH routing', () => {
  it('routes basic-mode glob and grep through the remote bridge without local ripgrep', async () => {
    const cwd = await marker('basic')
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    await bridge((path, body) => {
      calls.push({ path, body })
      return { payload: body.kind === 'glob'
        ? { root: '/srv/project', paths: ['src/remote.ts'], truncated: false }
        : { root: '/srv/project', matches: [{ path: 'src/remote.ts', lineNumber: 3, line: 'needle' }], truncated: false } }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
      const subprocess = ctx.subprocess as NeverSpawnSubprocess

      for (const kind of ['glob', 'grep'] as const) {
        const exec = {
          signal: new AbortController().signal,
          callId: CallId(`remote-basic-${kind}`),
          name: kind,
          arguments: { pattern: 'needle', path: 'src' },
          agent: { session: { header: { id: 'remote-search-session', cwd } } },
        }
        const result = await ctx.tools.execute(exec as never)
        expect(result.isError).toBe(false)
        expect(text(result)).toContain(kind === 'glob' ? 'src/remote.ts' : 'Line 3: needle')
      }

      expect(calls).toHaveLength(2)
      expect(calls.map(call => call.path)).toEqual(['/v1/search', '/v1/search'])
      for (const kind of ['glob', 'grep'] as const) {
        expect(calls.find(call => call.body.kind === kind)?.body).toMatchObject({
          root: '/srv/project',
          path: '/srv/project/src',
          kind,
          pattern: 'needle',
          maxBytes: ToolFsSearch.RAW_OUTPUT_MAX_BYTES,
        })
      }
      expect(subprocess.spawns).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the verified marker workspace for glob without spawning local ripgrep', async () => {
    const cwd = await marker()
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    await bridge((path, body) => {
      calls.push({ path, body })
      expect(path).toBe('/v1/search')
      expect(body).toMatchObject({
        root: '/srv/project',
        path: '/srv/project',
        kind: 'glob',
        pattern: '**/*.ts',
        maxBytes: ToolFsSearch.RAW_OUTPUT_MAX_BYTES,
      })
      return { payload: { root: '/srv/project', paths: ['src/remote.ts'], truncated: false } }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
      const subprocess = ctx.subprocess as NeverSpawnSubprocess

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('remote-glob'),
        name: 'glob',
        arguments: { pattern: '**/*.ts' },
        agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
      })

      expect(result.isError).toBe(false)
      expect(text(result)).toBe('src/remote.ts')
      expect(calls).toHaveLength(1)
      expect(subprocess.spawns).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps the host placeholder path of the session workspace back onto the remote root', async () => {
    const cwd = await marker()
    const paths: unknown[] = []
    await bridge((_path, body) => {
      paths.push(body.path)
      return { payload: { root: '/srv/project', paths: ['src/remote.ts'], truncated: false } }
    })
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })

      for (const path of [cwd, join(cwd, 'src')]) {
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('remote-glob-placeholder'),
          name: 'glob',
          arguments: { pattern: '**/*.ts', path },
          agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
        })
        expect(result.isError).toBe(false)
      }

      expect(paths).toEqual(['/srv/project', '/srv/project/src'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['basic', true],
    ['agent', false],
  ] as const)('tells the model that a %s-mode remote search needs a narrow path', async (mode, guided) => {
    const cwd = await marker(mode)
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })

      const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble({
        agent: { session: { header: { id: 'remote-search-session', cwd } } },
      } as never))
      if (guided) {
        expect(snapshot).toContain('over SFTP')
        expect(snapshot).toContain('subdirectory')
      } else {
        expect(snapshot).not.toContain('over SFTP')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops a remote search inside its budget with the narrowing hint instead of a bare timeout', async () => {
    const cwd = await marker('basic')
    // 桥接器永不响应：搜索必须按自己的预算收尾，而不是等通用工具超时把它截断。
    const server = createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as AddressInfo
    process.env.DSH_REMOTE_BRIDGE_URL = `http://127.0.0.1:${address.port}`
    process.env.DSH_REMOTE_BRIDGE_TOKEN = 'test-bridge-token-which-is-long-enough'
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true, timeoutMs: 4_100 })
      const started = Date.now()

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('remote-glob-budget'),
        name: 'glob',
        arguments: { pattern: '**/*.ts' },
        agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
      })

      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_ABORTED' } })
      expect(text(result)).toContain('narrower `path`')
      expect(Date.now() - started).toBeLessThan(4_100)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an agent response that exceeds the requested raw-output budget', async () => {
    const cwd = await marker()
    await bridge(() => ({
      payload: {
        root: '/srv/project',
        paths: [`src/${'x'.repeat(128)}.ts`],
        truncated: false,
      },
    }))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true, rawOutputMaxBytes: 64 })

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('remote-glob-overflow'),
        name: 'glob',
        arguments: { pattern: '**/*.ts' },
        agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
      })

      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_RAW_OUTPUT_OVERFLOW' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps rejected remote patterns and include filters to the established pattern error', async () => {
    const cwd = await marker()
    await bridge((_path, body) => ({
      status: 400,
      payload: { error: { code: body.include === undefined ? 'invalid-pattern' : 'invalid-include' } },
    }))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NeverSpawnSubprocess)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
      const subprocess = ctx.subprocess as NeverSpawnSubprocess

      const glob = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('remote-glob-invalid-pattern'),
        name: 'glob',
        arguments: { pattern: '[' },
        agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
      })
      const grep = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('remote-grep-invalid-include'),
        name: 'grep',
        arguments: { pattern: 'needle', include: '*.ts' },
        agent: { session: { header: { id: 'remote-search-session', cwd } } } as never,
      })

      expect(glob.error).toMatchObject({ info: { code: 'SEARCH_INVALID_PATTERN' } })
      expect(grep.error).toMatchObject({ info: { code: 'SEARCH_INVALID_PATTERN' } })
      expect(text(glob)).toContain('pattern rejected by remote search')
      expect(text(grep)).toContain('include filter rejected by remote search')
      expect(subprocess.spawns).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
