import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  ctx.provide('webServer', { port: 0, host: '127.0.0.1', register: () => () => {} } as never)
  await ctx.plugin(notesTabs)
  return { base: '', agent: live.agent, session: liveSession }
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
