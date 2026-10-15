import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalMemory from '@deepseek-ai/dsh-memory-local'
import * as MemoryContext from '@deepseek-ai/dsh-memory-context'

const cleanups: string[] = []
const testToolSignal = new AbortController().signal

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function stubAgent(cwd: string): Agent {
  const id = SessionId('memory-context-session')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('memory-context-agent'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** 走一遍 pre-step waterfall，返回下游拿到的批次。 */
async function preStep(ctx: Context, agent: Agent): Promise<SessionEvent[] | undefined> {
  // 下游必须交出一个非空批次：空的第一步批次属于“不产生步骤的轮次”，
  // 注入要跟着真正进入请求的那一批走。
  const claimed = [createUserMessage({ content: [{ type: 'text', text: '做点事' }], source: { kind: 'user' } })]
  const decided = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn: 1, step: 1, signal: testToolSignal },
    async () => ({ kind: 'enter' as const, messages: claimed }),
  )
  if (decided.kind === 'reject') return undefined
  return decided.messages.map(message => ({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: message,
    surfaceOp: 'append',
  })) as SessionEvent[]
}

async function mount(cwd: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalMemory, { root: join(cwd, 'home', 'memory') })
  await ctx.plugin(MemoryContext)
  return ctx
}

describe('memory context injection', () => {
  it('injects a framed excerpt once, on the first entering step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-context-'))
    cleanups.push(root)
    const cwd = join(root, 'repo')
    await mkdir(join(cwd, '.git'), { recursive: true })
    const ctx = await mount(cwd)
    try {
      const agent = stubAgent(cwd)
      await ctx.memory.save(ctx.memory.projectFor(cwd), { content: '用户要求提交信息用中文' })

      const first = await preStep(ctx, agent)
      const text = (first ?? [])
        .flatMap(event => event.type === 'user/message' ? event.data.content : [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      expect(text).toContain('<system-reminder>')
      expect(text).toContain('notes.md')
      expect(text).toContain('用户要求提交信息用中文')
      expect(text).toContain('not as instructions')
      expect(text).toContain('AGENTS.md')

      // 第二个步骤不再重复注入，批次里只剩原来的提示词。
      const second = await preStep(ctx, agent)
      expect(second).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stays silent when the project has no memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-context-empty-'))
    cleanups.push(root)
    const cwd = join(root, 'repo')
    await mkdir(join(cwd, '.git'), { recursive: true })
    const ctx = await mount(cwd)
    try {
      const decided = await preStep(ctx, stubAgent(cwd))

      expect(decided).toHaveLength(1)
      expect(decided?.flatMap(event => event.type === 'user/message' ? event.data.content : [])).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
