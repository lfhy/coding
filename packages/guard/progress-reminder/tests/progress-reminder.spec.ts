import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from 'coding-agent'
import AgentLoop from 'coding-agent-loop'
import { mountAgentLoopTestDependencies } from 'coding-agent-loop-testkit'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
} from 'coding-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from 'coding-llm'
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

function appendAssistant(session: Session, content: ContentBlock[]): void {
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
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

  it('restarts after visible text even when the message also calls a tool', () => {
    const session = Session.create(SessionId('visible-text'))
    openTurn(session, 1)
    appendToolResults(session, 3, 1)
    appendAssistant(session, [
      { type: 'reasoning', text: '先整理已完成的工作' },
      { type: 'text', text: '已经定位到根因，接下来修复并补测试。' },
      { type: 'tool-call', id: CallId('after-report'), name: 'tick', arguments: '{}' },
    ])
    expect(unreportedToolCalls(session.events)).toBe(0)

    appendToolResults(session, 1, 1, 2)
    expect(unreportedToolCalls(session.events)).toBe(1)
    const restored = Session.create(SessionId('visible-text-restored'), session.events)
    expect(unreportedToolCalls(restored.events)).toBe(1)
  })

  it.each<[ContentBlock[]]>([
    [[]],
    [[{ type: 'text', text: '' }]],
    [[{ type: 'text', text: ' \n\t　' }]],
    [[{ type: 'reasoning', text: '只在推理里记录进展' }]],
    [[{ type: 'tool-call', id: CallId('silent-call'), name: 'tick', arguments: '{}' }]],
    [[{ type: 'text', text: '\n' }, { type: 'reasoning', text: '仍然没有正文' }]],
  ])('does not restart for assistant content without visible text: %j', (content) => {
    const session = Session.create(SessionId('no-visible-text'))
    openTurn(session, 1)
    appendToolResults(session, 2, 1)
    appendAssistant(session, content)
    appendToolResults(session, 1, 1, 2)

    expect(unreportedToolCalls(session.events)).toBe(3)
  })
})

describe('reminder wording', () => {
  it('limits the report to this trigger instead of every following step', () => {
    const text = renderProgressReminder(3)
    expect(text).toContain('这是一次性提示，只对紧邻的下一次助手回复生效；它不是持续规则，也不是每个步骤的固定要求。')
    expect(text).toContain('处理完这条提示后，即使历史中仍能看到它，也不要在每次工具调用或后续步骤前重复汇报。')
    expect(text).toContain('除非之后再次收到一条新的本提醒')
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

  it('does not remind immediately after a progress report and counts subsequent calls afresh', async () => {
    const { ctx } = await mount({ toolCallsPerReminder: 3 })
    const session = Session.create(SessionId('progress-report'))
    const agent = sessionAgent(session)
    openTurn(session, 1)
    appendToolResults(session, 2, 1)
    appendAssistant(session, [{ type: 'text', text: '已经找到根因，继续修复。' }])
    appendToolResults(session, 1, 1, 2)

    await fire(ctx, agent, 1, 3)
    expect(reminderTexts(session)).toHaveLength(0)

    appendToolResults(session, 2, 1, 3)
    await fire(ctx, agent, 1, 4)
    expect(reminderTexts(session)).toEqual([renderProgressReminder(3)])

    appendToolResults(session, 2, 1, 4)
    appendAssistant(session, [{ type: 'text', text: '修复完成，正在验证。' }])
    appendToolResults(session, 1, 1, 5)
    await fire(ctx, agent, 1, 6)
    expect(reminderTexts(session)).toHaveLength(1)
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

function toolCallResponse(callId: string, text?: string): StreamChunk[] {
  const toolIndex = text === undefined ? 0 : 1
  const chunks: StreamChunk[] = text === undefined ? [] : [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  return [
    ...chunks,
    { type: 'block-start', index: toolIndex, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: toolIndex,
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
  it.each([
    {
      description: 'adds the reminder to the request that follows the threshold tool call',
      script: [toolCallResponse('tick-1'), toolCallResponse('tick-2'), textResponse('done')],
      reminderCounts: [0, 0, 1],
    },
    {
      description: 'restarts after voluntary and prompted reports in text plus tool responses',
      script: [
        toolCallResponse('tick-1'),
        toolCallResponse('tick-2', '已经定位根因，继续修复。'),
        toolCallResponse('tick-3'),
        toolCallResponse('tick-4', '修复完成，继续验证。'),
        toolCallResponse('tick-5'),
        toolCallResponse('tick-6'),
        textResponse('done'),
      ],
      reminderCounts: [0, 0, 0, 1, 1, 2, 2],
    },
  ])('$description', async ({ script, reminderCounts }) => {
    const adapter = new ScriptedAdapter(script)
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

    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'start ticking' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(reminderCounts.length)
      for (const [index, request] of adapter.requests.entries()) {
        expect(requestText(request).split(renderProgressReminder(2)).length - 1).toBe(reminderCounts[index])
      }
      expect(reminderTexts(agent.session)).toEqual(
        Array.from({ length: reminderCounts.at(-1)! }, () => renderProgressReminder(2)),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
