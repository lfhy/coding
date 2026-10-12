/** 临时侧聊从 RPC 经过真实 AgentLoop/Session 持有者的 Host 集成行为。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import { InProcessApiClient, toFetchHandler } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { ApiProxy } from '../src/api/index.ts'

let sequence = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`side-chat-${sequence++}`), payload }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('answer')], withApproval = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  if (withApproval) await ctx.plugin(ApprovalService)
  ctx.provide('workspaceRegistry', {
    list: () => [], archivedSessionIds: [],
  } as never)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
  })
  return { ctx, api, adapter }
}

async function created(api: ApiProxy) {
  const result = await api.sideChat.create(request({}))
  if (!result.result.ok) throw new Error(result.result.error.message)
  return result.result.value.sideChatId
}

describe('sideChat full Agent and isolation', () => {
  it('round-trips create/send/state/close through the validated fetch carrier', async () => {
    const { ctx, api } = await harness()
    const client = new InProcessApiClient(toFetchHandler(api))
    const created = await client.sideChat.create({})
    if (!created.result.ok) throw new Error(created.result.error.message)
    const sideChatId = created.result.value.sideChatId
    expect((await client.sideChat.send({ sideChatId, text: 'carrier prompt' })).result.ok).toBe(true)
    await ctx.agents.get(sideChatId)?.whenIdle()
    const state = await client.sideChat.state({ sideChatId })
    if (!state.result.ok) throw new Error(state.result.error.message)
    expect(state.result.value.events.some(event => event.type === 'assistant/message')).toBe(true)
    expect((await client.sideChat.close({ sideChatId })).result.ok).toBe(true)
    expect((await client.sideChat.state({ sideChatId })).result).toMatchObject({ ok: false, error: { code: 'side-chat-not-found' } })
  })

  it('routes prompts into a private agent, polls bounded raw events, then destroys it', async () => {
    const { ctx, api, adapter } = await harness()
    const id = await created(api)
    const agent = ctx.agents.get(id)
    expect(agent?.session.transient).toBe(true)
    expect(agent?.session.header.cwd).toBe('/tmp')
    expect(await api.sessions.list(request({}))).toMatchObject({ result: { ok: true, value: { items: [] } } })
    expect(await api.sessions.history(request({ sessionId: id }))).toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })
    expect(await api.sessions.prompt(request({ sessionId: id, mode: 'queue', content: [{ type: 'text', text: 'wrong route' }] }))).toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })
    expect(await api.sessions.create(request({ sessionId: id }))).toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })
    expect(await api.sideChat.send(request({ sideChatId: id, text: 'question' }))).toMatchObject({ result: { ok: true } })
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages.some(message => message.role === 'user')).toBe(true)
    const states = []
    let afterSeq = 0
    do {
      const result = await api.sideChat.state(request({ sideChatId: id, afterSeq }))
      if (!result.result.ok) throw new Error(result.result.error.message)
      states.push(result.result.value)
      expect(result.result.value.events.length).toBeLessThanOrEqual(100)
      expect(result.result.value.views.length).toBe(result.result.value.events.length)
      afterSeq = result.result.value.nextSeq
    } while (states.at(-1)?.hasMore)
    expect(states.flatMap(state => state.events.map(event => event.type))).toContain('assistant/message')
    expect((await api.sideChat.state(request({ sideChatId: id, afterSeq }))).result).toMatchObject({ ok: true, value: { events: [], nextSeq: afterSeq, hasMore: false, status: 'idle' } })
    expect((await api.sideChat.close(request({ sideChatId: id }))).result.ok).toBe(true)
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect((await api.sideChat.close(request({ sideChatId: id }))).result.ok).toBe(true)
    expect((await api.sideChat.state(request({ sideChatId: id }))).result).toMatchObject({ ok: false, error: { code: 'side-chat-not-found' } })
  })

  it('inherits the current ordinary live session cwd/model/preset, but no history or workspace membership', async () => {
    const { ctx, api } = await harness()
    const sourceId = SessionId('ordinary-source')
    const source = ctx.sessions.create(sourceId, { meta: { cwd: '/tmp', agentPreset: 'coding' } })
    source.append('user/message', {
      role: 'user', id: 'source-message' as never, source: { kind: 'user' }, content: [{ type: 'text', text: 'not shared' }],
    }, { surfaceOp: 'append' })
    const ordinary = { id: sourceId, session: source, options: {}, status: 'idle', ctx } as never
    ctx.agents.register(ordinary)
    // source 会话的当前选择不必与当前部署默认值相同；从其日志重建已选择的模型。
    source.append('request/header', {
      header: { config: { provider: 'mock', model: 'alternate' } }, reason: 'initial',
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'default' }),
      mount: () => Promise.resolve(),
    } as never)
    const result = await api.sideChat.create(request({ sourceSessionId: sourceId }))
    if (!result.result.ok) throw new Error(result.result.error.message)
    const child = ctx.sessions.get(result.result.value.sideChatId)
    expect(result.result.value.agentPreset).toBe('coding')
    expect(child?.header.cwd).toBe('/tmp')
    expect(child?.header.parentSession).toBeUndefined()
    expect(child?.events).toHaveLength(0)
    expect(ctx.agents.get(result.result.value.sideChatId)?.session).toBe(child)
    expect(ctx.agents.get(result.result.value.sideChatId)?.options.model).toBe('alternate')
    const ordinaryList = await api.sessions.list(request({}))
    expect(ordinaryList).toMatchObject({ result: { ok: true, value: { items: [expect.objectContaining({ sessionId: sourceId })] } } })
    const refused = await api.sideChat.create(request({ sourceSessionId: result.result.value.sideChatId }))
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('resolves the requested preset before publication and retains its full composition', async () => {
    const { ctx, api } = await harness()
    const mounts: string[] = []
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'default' }),
      mount: (_agentCtx: Context, id: string) => { mounts.push(id); return Promise.resolve() },
    } as never)
    const result = await api.sideChat.create(request({ agentPreset: 'coding' }))
    if (!result.result.ok) throw new Error(result.result.error.message)
    expect(result.result.value.agentPreset).toBe('coding')
    expect(ctx.sessions.get(result.result.value.sideChatId)?.header.agentPreset).toBe('coding')
    expect(mounts).toEqual(['coding'])
  })

  it('keeps permission prompts off shared mux and resolves them through the private state', async () => {
    const { ctx, api } = await harness([textResponse('answer')], true)
    const id = await created(api)
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error('missing side-chat Agent')
    agent.session.append('turn/start', { turn: 1 })
    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'approval needed' })
    let interaction: Extract<import('../src/api/side-chat.ts').SideChatInteraction, { type: 'approval/requested' }> | undefined
    await vi.waitFor(async () => {
      const state = await api.sideChat.state(request({ sideChatId: id }))
      if (!state.result.ok) throw new Error(state.result.error.message)
      interaction = state.result.value.interactions.find(item => item.type === 'approval/requested')
      expect(interaction).toBeDefined()
    })
    if (interaction === undefined) throw new Error('approval missing')
    const receipt = await api.respond({ type: 'client-response', rpcId: interaction.rpcId, result: {
      ok: true, value: { sessionId: id, approvalId: interaction.approvalId, outcome: 'allowed-once' },
    } })
    expect(receipt).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    const state = await api.sideChat.state(request({ sideChatId: id }))
    expect(state.result).toMatchObject({ ok: true, value: { interactions: [] } })
  })

  it('resolves a private user question through the same answer receipt', async () => {
    const { ctx, api } = await harness()
    const id = await created(api)
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error('missing side-chat Agent')
    const asked = ctx.userQuestions.ask({ agent, questions: [{ id: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }] }] })
    const state = await api.sideChat.state(request({ sideChatId: id }))
    if (!state.result.ok) throw new Error(state.result.error.message)
    const interaction = state.result.value.interactions.find(item => item.type === 'question/requested')
    if (interaction === undefined) throw new Error('private question was not registered')
    expect(await api.respond({ type: 'client-response', rpcId: interaction.rpcId, result: {
      ok: true, value: { sessionId: id, answer: { answers: [{ id: 'choice', selected: ['Yes'] }] } },
    } })).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'choice', selected: ['Yes'] }] })
  })

  it('closes while a private user question is pending, before awaiting Agent disposal', async () => {
    const { ctx, api } = await harness()
    const id = await created(api)
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error('missing side-chat Agent')
    const asked = ctx.userQuestions.ask({ agent, questions: [{ id: 'wait', question: 'Wait?' }] })
    const closed = api.sideChat.close(request({ sideChatId: id }))
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect((await closed).result.ok).toBe(true)
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('closes while a private approval is pending, before awaiting Agent disposal', async () => {
    const { ctx, api } = await harness([textResponse('answer')], true)
    const id = await created(api)
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error('missing side-chat Agent')
    agent.session.append('turn/start', { turn: 1 })
    const asked = ctx.approval.request({ agent, toolName: 'write' })
    await vi.waitFor(async () => {
      const state = await api.sideChat.state(request({ sideChatId: id }))
      if (!state.result.ok) throw new Error(state.result.error.message)
      expect(state.result.value.interactions.some(item => item.type === 'approval/requested')).toBe(true)
    })
    const closed = api.sideChat.close(request({ sideChatId: id }))
    await expect(asked).resolves.toBe('cancelled')
    expect((await closed).result.ok).toBe(true)
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('racing state snapshots either finish before close or return not-found afterward', async () => {
    const { ctx, api } = await harness()
    const id = await created(api)
    const state = api.sideChat.state(request({ sideChatId: id }))
    const close = api.sideChat.close(request({ sideChatId: id }))
    const snapshot = await state
    expect(snapshot.result.ok).toBe(true)
    expect((await close).result.ok).toBe(true)
    expect(ctx.sessions.get(id)).toBeUndefined()
    const after = await api.sideChat.state(request({ sideChatId: id }))
    expect(after.result).toMatchObject({ ok: false, error: { code: 'side-chat-not-found' } })
  })

  it('serves exactly 100 events per page even during a high-volume active log', async () => {
    const { ctx, api } = await harness()
    const id = await created(api)
    const session = ctx.sessions.get(id)
    if (session === undefined) throw new Error('missing live side chat')
    for (let index = 0; index < 220; index++) session.append('turn/start', { turn: index })
    const first = await api.sideChat.state(request({ sideChatId: id }))
    if (!first.result.ok) throw new Error(first.result.error.message)
    expect([first.result.value.events.length, first.result.value.nextSeq, first.result.value.hasMore]).toEqual([100, 100, true])
    const last = await api.sideChat.state(request({ sideChatId: id, afterSeq: 200 }))
    if (!last.result.ok) throw new Error(last.result.error.message)
    expect([last.result.value.events.length, last.result.value.nextSeq, last.result.value.hasMore]).toEqual([20, 220, false])
  })

  it('limits complete snapshot bytes and reports oversized single events without losing the cursor', async () => {
    const { ctx, api } = await harness()
    const id = await created(api)
    const session = ctx.sessions.get(id)
    if (session === undefined) throw new Error('missing live side chat')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      role: 'user', id: 'large-input' as never, source: { kind: 'user' },
      content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }],
    }, { surfaceOp: 'append' })
    const first = await api.sideChat.state(request({ sideChatId: id }))
    expect(first.result).toMatchObject({ ok: true, value: { nextSeq: 1, hasMore: true } })
    const oversized = await api.sideChat.state(request({ sideChatId: id, afterSeq: 1 }))
    expect(oversized.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('closes an active model stream, cancels it, and rejects further deliveries', async () => {
    const { ctx, api, adapter } = await harness(['hang'])
    const id = await created(api)
    await api.sideChat.send(request({ sideChatId: id, text: 'wait for model' }))
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    const closed = await api.sideChat.close(request({ sideChatId: id }))
    expect(closed.result.ok).toBe(true)
    expect(adapter.requests[0]?.signal?.aborted).toBe(true)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect((await api.sideChat.send(request({ sideChatId: id, text: 'later' }))).result).toMatchObject({ ok: false, error: { code: 'side-chat-not-found' } })
  })

  it('keeps model tool execution enabled with a private transcript', async () => {
    const { ctx, api, adapter } = await harness([toolCallResponse('call-1', 'tool-private', {}), textResponse('finished')])
    ctx.tools.register(defineContentToolFixture({
      name: 'tool-private', description: 'private tool', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'executed' }]),
    }))
    const id = await created(api)
    await api.sideChat.send(request({ sideChatId: id, text: 'run a tool' }))
    await ctx.agents.get(id)?.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const result = await api.sideChat.state(request({ sideChatId: id }))
    if (!result.result.ok) throw new Error(result.result.error.message)
    expect(result.result.value.events.some(event => event.type === 'tool/result')).toBe(true)
  })

  it('expires an unpolled side chat and releases the complete owner lifecycle', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, api } = await harness()
      const id = await created(api)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect((await api.sideChat.state(request({ sideChatId: id }))).result).toMatchObject({ ok: false, error: { code: 'side-chat-not-found' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never forwards private events or lifecycle through shared mux and host streams', async () => {
    const { api } = await harness()
    const stop = new AbortController()
    const mux = api.events.mux(request({}), stop.signal)[Symbol.asyncIterator]()
    const host = api.events.host(request({}), stop.signal)[Symbol.asyncIterator]()
    const nextMux = mux.next()
    const nextHost = host.next()
    const id = await created(api)
    await api.sideChat.send(request({ sideChatId: id, text: 'private' }))
    await api.sideChat.close(request({ sideChatId: id }))
    stop.abort()
    expect((await nextMux).done).toBe(true)
    expect((await nextHost).done).toBe(true)
    await mux.return?.()
    await host.return?.()
  })
})
