import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

function agent(ctx: Context): Agent {
  const session = ctx.sessions.create()
  const value = { id: session.id, session, status: 'idle', ctx } as Agent
  ctx.agents.register(value)
  return value
}

function openMux(api: ApiProxy, abort: AbortController): {
  envelopes: RpcRequest<MuxFrame>[]
  waitForQuestion(): Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>
} {
  const envelopes: RpcRequest<MuxFrame>[] = []
  let resolveQuestion!: (value: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>) => void
  const question = new Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>((resolve) => {
    resolveQuestion = resolve
  })
  void (async () => {
    for await (const envelope of api.events.mux({ rpcId: RpcId('question-mux'), payload: {} }, abort.signal)) {
      envelopes.push(envelope)
      if (envelope.payload.type === 'question/requested') {
        resolveQuestion(envelope as RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>)
      }
    }
  })()
  return { envelopes, waitForQuestion: () => question }
}

function answer(
  envelope: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>,
  selected: string[],
  custom?: string,
): Parameters<ApiProxy['respond']>[0] {
  return {
    type: 'client-response',
    rpcId: envelope.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: envelope.payload.sessionId,
        answer: {
          answers: [{
            id: envelope.payload.questions[0]?.id,
            selected,
            ...custom === undefined ? {} : { custom },
          }],
        },
      },
    },
  }
}

describe('question response validation', () => {
  afterEach(() => { vi.useRealTimers() })

  it('accepts selected options with custom text for multi-select questions', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const mux = openMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{
        id: 'targets',
        question: 'Choose targets and add another',
        multiSelect: true,
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const envelope = await mux.waitForQuestion()

    expect(await api.respond(answer(envelope, ['Code', 'Docs'], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'targets', selected: ['Code', 'Docs'], custom: 'Release notes' }],
    })
    expect(mux.envelopes.some(item => item.payload.type === 'question/resolved')).toBe(true)
    abort.abort()
  })

  it('keeps selected options and custom text mutually exclusive for single-select questions', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const mux = openMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{
        id: 'target',
        question: 'Choose one target',
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const envelope = await mux.waitForQuestion()

    expect(await api.respond(answer(envelope, ['Code'], 'Release notes')))
      .toEqual({ accepted: false, reason: 'bad-response' })
    expect(await api.respond(answer(envelope, [], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'target', selected: [], custom: 'Release notes' }],
    })
    abort.abort()
  })

  it('withdraws a timed-out tool question from the host and rejects late replies', async () => {
    vi.useFakeTimers()
    const { ctx, api } = await harness()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolAskUser)
    const abort = new AbortController()
    const mux = openMux(api, abort)
    const resultPromise = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('host-question-timeout'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
      agent: agent(ctx),
    })
    const envelope = await mux.waitForQuestion()
    await vi.advanceTimersByTimeAsync(300_000)
    await expect(resultPromise).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'ASK_TIMEOUT' } },
      content: [{ type: 'text', text: 'Error: 用户未响应 需要自行决策' }],
    })
    expect(mux.envelopes).toContainEqual(expect.objectContaining({
      payload: { type: 'question/resolved', sessionId: envelope.payload.sessionId,
        questionRpcId: envelope.rpcId, outcome: 'cancelled' },
    }))
    expect(await api.respond(answer(envelope, ['Yes']))).toEqual({ accepted: false, reason: 'not-pending' })
    const replayAbort = new AbortController()
    // 此测试的 Agent 是手写桩；重连快照还会读取 inbox，因此只补足该无关字段。
    const live = ctx.agents.get(envelope.payload.sessionId)
    if (live === undefined) throw new Error('missing question agent')
    live.inbox = { hasPending: false } as Agent['inbox']
    const replay = openMux(api, replayAbort)
    await vi.advanceTimersByTimeAsync(0)
    expect(replay.envelopes.some(item => item.payload.type === 'question/requested')).toBe(false)
    replayAbort.abort()
    abort.abort()
  })
})
