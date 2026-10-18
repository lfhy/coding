import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from 'coding-agent'
import AgentLoop from 'coding-agent-loop'
import { mountAgentLoopTestDependencies } from 'coding-agent-loop-testkit'
import {
  CallId,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
} from 'coding-llm'
import type { GenerateOptions, StreamChunk } from 'coding-llm'
import { Session, SessionId } from 'coding-session'
import { defineContentToolFixture } from 'coding-tools'
import * as progressReminder from 'coding-progress-reminder'
import {
  renderProgressReminder,
  unreportedToolCalls,
  type Config,
} from 'coding-progress-reminder'

const SIGNAL = new AbortController().signal

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(progressReminder, config)
  return { ctx, fiber }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('progress-reminder must append directly to the proposed step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** 追加 `count` 条已完成的工具结果，模拟一个步骤内的连续工具调用。 */
function appendToolResults(session: Session, count: number, turn: number, step = 1): void {
  for (let index = 0; index < count; index += 1) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: CallId(`call-${String(turn)}-${String(step)}-${String(index)}`),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
}

function reminderTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'progress-reminder') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

/** 以真实循环的调用形态触发一次 pre-step，并把决策写入会话。 */
async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'plugin', plugin: 'progress-reminder-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

describe('counting completed tool calls', () => {
  it('counts tool results since the latest reminder and stops at the previous turn', () => {
    const session = Session.create(SessionId('count'))
    openTurn(session, 1)
    appendToolResults(session, 3, 1)
    expect(unreportedToolCalls(session.events)).toBe(3)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(session, 2)
    expect(unreportedToolCalls(session.events)).toBe(0)
    appendToolResults(session, 2, 2)
    expect(unreportedToolCalls(session.events)).toBe(2)
  })
})

describe('reminder wording', () => {
  it('asks for a concise user-facing report without inventing a decision', () => {
    const text = renderProgressReminder(3)
    expect(text).toContain('请先在回复正文用几句话说明已完成什么、还剩什么，再继续执行。')
    expect(text).toContain('没有需要用户决定的事项就直接继续，不要为了汇报而停下或询问。')
    expect(text).not.toContain('计划工具')
    expect(text).not.toContain('拍板')
  })
})

describe('pre-step injection', () => {
  it('leaves the proposed batch alone below the threshold', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 3 })
    const session = Session.create(SessionId('below'))
    openTurn(session, 1)
    appendToolResults(session, 2, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(reminderTexts(session)).toHaveLength(0)
  })

  it('appends one reminder once the threshold is reached', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 3 })
    const session = Session.create(SessionId('at-threshold'))
    openTurn(session, 1)
    appendToolResults(session, 3, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(reminderTexts(session)).toEqual([renderProgressReminder(3)])
    const reminder = session.events.at(-1)
    expect(reminder?.type).toBe('user/message')
    if (reminder?.type !== 'user/message') throw new Error('missing reminder')
    expect(reminder.data.source).toEqual({ kind: 'plugin', plugin: 'progress-reminder' })
    expect(reminder.surfaceOp).toBe('append')
  })

  it('reports the real count when a parallel batch overshoots the threshold', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 3 })
    const session = Session.create(SessionId('overshoot'))
    openTurn(session, 1)
    appendToolResults(session, 7, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(reminderTexts(session)).toEqual([renderProgressReminder(7)])
  })

  it('restarts counting after its own reminder', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 2 })
    const session = Session.create(SessionId('restart'))
    const agent = sessionAgent(session)
    openTurn(session, 1)
    appendToolResults(session, 2, 1)
    await fire(ctx, agent, 1, 2)

    appendToolResults(session, 1, 1, 3)
    await fire(ctx, agent, 1, 4)
    expect(reminderTexts(session)).toHaveLength(1)

    appendToolResults(session, 1, 1, 5)
    await fire(ctx, agent, 1, 6)
    expect(reminderTexts(session)).toEqual([renderProgressReminder(2), renderProgressReminder(2)])
  })

  it('restarts counting at a new turn', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 2 })
    const session = Session.create(SessionId('new-turn'))
    const agent = sessionAgent(session)
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(session, 2)
    appendToolResults(session, 1, 2)

    await fire(ctx, agent, 2, 1)

    expect(reminderTexts(session)).toHaveLength(0)
  })

  it('ignores messages of other plugins as counting boundaries', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 2 })
    const session = Session.create(SessionId('other-plugin'))
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'other context' }],
      source: { kind: 'plugin', plugin: 'time-context' },
    }), { surfaceOp: 'append' })
    appendToolResults(session, 1, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(reminderTexts(session)).toEqual([renderProgressReminder(2)])
  })

  it('leaves a rejected decision and an aborted preparation untouched', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 1 })
    const session = Session.create(SessionId('reject'))
    const agent = sessionAgent(session)
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'rejected proposal' }],
      source: { kind: 'plugin', plugin: 'progress-reminder-test' },
    })

    const rejected = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 1, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'test' }),
    )
    expect(rejected.kind).toBe('reject')

    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 3, abort.signal)
    expect(reminderTexts(session)).toHaveLength(0)
  })
})

describe('configuration and lifecycle', () => {
  it('defaults to the shipped threshold', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('default-threshold'))
    openTurn(session, 1)
    appendToolResults(session, progressReminder.DEFAULT_TOOL_CALLS_PER_REMINDER - 1, 1)

    await fire(ctx, sessionAgent(session), 1, 2)
    expect(reminderTexts(session)).toHaveLength(0)

    appendToolResults(session, 1, 1, 2)
    await fire(ctx, sessionAgent(session), 1, 3)
    expect(reminderTexts(session)).toEqual([
      renderProgressReminder(progressReminder.DEFAULT_TOOL_CALLS_PER_REMINDER),
    ])
  })

  it('rejects invalid thresholds at plugin load with one diagnostic', async () => {
    const invalid = [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]
    for (const toolCallsPerReminder of invalid) {
      await expect(mount({ toolCallsPerReminder })).rejects.toThrow(
        'progress-reminder: toolCallsPerReminder must be a positive safe integer',
      )
    }
  })

  it('removes its listener when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await mount({ toolCallsPerReminder: 1 })
    const session = Session.create(SessionId('dispose'))
    const agent = sessionAgent(session)
    openTurn(session, 1)
    appendToolResults(session, 1, 1)
    await fire(ctx, agent, 1, 2)
    expect(reminderTexts(session)).toHaveLength(1)

    await fiber.dispose()
    appendToolResults(session, 1, 1, 3)
    await fire(ctx, agent, 1, 4)

    expect(reminderTexts(session)).toHaveLength(1)
  })
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

function toolCallResponse(callId: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId(callId), name: 'tick', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('real agent-loop request history', () => {
  it('adds the reminder to the request that follows the threshold tool call', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('tick-1'),
      toolCallResponse('tick-2'),
      textResponse('done'),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(progressReminder, { toolCallsPerReminder: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'tick',
      description: 'advance one tick',
      parameters: {},
      async execute() {
        return [{ type: 'text' as const, text: 'ticked' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('loop'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'start ticking' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(requestText(adapter.requests[0]!)).not.toContain('<system-reminder>')
    expect(requestText(adapter.requests[1]!)).not.toContain('你已连续执行')
    expect(requestText(adapter.requests[2]!)).toContain(renderProgressReminder(2))
    expect(reminderTexts(agent.session)).toEqual([renderProgressReminder(2)])
    await ctx.fiber.dispose()
  })
})
