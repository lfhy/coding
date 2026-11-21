import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from 'coding-agent'
import type { Agent, AgentStatus } from 'coding-agent'
import SessionStore, { SessionId, Session } from 'coding-session'
import ToolRuntime from 'coding-tools'
import SystemPrompt from 'coding-system-prompt'
import TypertRegistry from 'coding-typert-registry'
import * as notesTabs from '../src/index.ts'

const SESSION = 'notes-tabs-test-session'
let ctx: Context | undefined
let root: string | undefined
let notesRoot: string | undefined
/** 发布路由由 WebServer 注入；测试直接调用同一个 handler，不监听真实端口。 */
let route: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

function stubAgent(session: Session): StubAgent {
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id, options: {}, session, inbox,
    get status() { return status },
    ctx: new Context(), send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

async function boot(): Promise<{ base: string; agent: Agent; session: Session }> {
  ctx = new Context()
  root = await mkdtemp(join(tmpdir(), 'coding-notes-tabs-'))
  notesRoot = join(root, 'notes')
  await mkdir(notesRoot, { recursive: true })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  const sessionStore = ctx.sessions
  sessionStore.create(SessionId(SESSION), { meta: { cwd: notesRoot, agentPreset: 'notes' } })
  const liveSession = sessionStore.get(SessionId(SESSION))!
  const live = stubAgent(liveSession)
  ctx.agents.register(live.agent)
  ctx.provide('fileLibrary', { notesRootPath: () => notesRoot } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  route = undefined
  ctx.provide('webServer', {
    port: 0, host: '127.0.0.1',
    register: (entry: { handler: typeof route }) => { route = entry.handler; return () => {} },
  } as never)
  await ctx.plugin(notesTabs)
  return { base: '', agent: live.agent, session: liveSession }
}

/** 以一次同源 POST 调用发布路由，返回状态码与解析后的响应体。 */
async function publish(body: unknown): Promise<{ status: number; body: unknown }> {
  if (route === undefined) throw new Error('发布路由未注册')
  const payload = Buffer.from(JSON.stringify(body))
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: '/api/notes/tabs',
    headers: { host: '127.0.0.1:0', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield payload },
  } as unknown as IncomingMessage
  const res = {
    writeHead(code: number) { status = code },
    end(chunk?: string) { if (typeof chunk === 'string') text = chunk },
  } as unknown as ServerResponse
  await route(req, res)
  return { status, body: text === '' ? undefined : JSON.parse(text) }
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  notesRoot = undefined
})

describe('notes tabs protocol', () => {
  it('uses the Loader-safe function-plugin export and registers one model tool', async () => {
    const { agent } = await boot()
    expect('default' in notesTabs).toBe(false)
    expect(notesTabs.name).toBe('tool-notes-tabs')
    expect(notesTabs.inject).toEqual(['tools', 'webServer', 'connection', 'sessions', 'agents', 'fileLibrary'])
    expect(ctx?.tools.get('notes_tabs')?.name).toBe('notes_tabs')
    expect(ctx?.tools.get('notes_tabs')?.parameters).toEqual({ type: 'object', properties: {} })
    expect(agent.id).toBe(SESSION)
  })

  it('disposes the tool and route registration from the plugin fiber', async () => {
    const { agent } = await boot()
    expect(ctx?.tools.get('notes_tabs')).toBeDefined()
    await ctx?.fiber.dispose()
    expect(ctx?.get('tools')).toBeUndefined()
    expect(agent.id).toBe(SESSION)
  })

  it('publishes a .codingppt tab as the active ppt tab and rejects mismatched kinds', async () => {
    const { agent } = await boot()
    await writeFile(join(notesRoot!, 'hello.md'), '# Hello')
    await mkdir(join(notesRoot!, '演示.codingppt'))
    await mkdir(join(notesRoot!, 'data'), { recursive: true })
    const body = { sessionId: SESSION, windowId: 'window', version: 1,
      openTabs: ['hello.md', '演示.codingppt'], activeTabPath: '演示.codingppt', activeKind: 'ppt' }
    await expect(publish(body)).resolves.toMatchObject({ status: 200, body: { ok: true } })
    const result = await ctx!.tools.execute({
      name: 'notes_tabs', callId: 'notes-tabs-deck' as never, arguments: {},
      signal: new AbortController().signal, agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({ status: 'ready', activeKind: 'ppt',
      activeTabPath: '演示.codingppt', openTabs: [{ path: 'hello.md' }, { path: '演示.codingppt' }] })

    // 普通目录不能被声明成幻灯片，Markdown 也不能声明成 ppt。
    await expect(publish({ ...body, openTabs: ['data'], activeTabPath: 'data' })).resolves.toMatchObject({ status: 400 })
    await expect(publish({ ...body, openTabs: ['hello.md'], activeTabPath: 'hello.md' }))
      .resolves.toMatchObject({ status: 400 })
  })

  it('rejects a fake session and does not derive a path from the filesystem', async () => {
    const { agent } = await boot()
    await writeFile(join(notesRoot!, 'hello.md'), '# Hello')
    const result = await ctx!.tools.execute({
      name: 'notes_tabs', callId: 'notes-tabs-call' as never, arguments: {},
      signal: new AbortController().signal, agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({ status: 'unavailable', reason: 'not-published' })
  })
})
