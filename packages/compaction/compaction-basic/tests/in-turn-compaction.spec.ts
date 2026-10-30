// The model's own compaction request, exercised through the real backend:
// it runs inside an open turn, keeps the step it was called from, and carries
// the requester's focus into the summarization request.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from 'coding-compaction-basic'
import { CompactionId, ManualCompactionError } from 'coding-compaction'
import { CallId, createAssistantMessage, createUserMessage } from 'coding-llm'
import type { ContentBlock, Message } from 'coding-llm'
import LlmRuntime from 'coding-llm'
import SessionStore, { Session, SessionId } from 'coding-session'
import TokenMeter from 'coding-token-meter'
import type { Agent } from 'coding-agent'
import type {
  SummarizationInput,
  SummaryResult,
} from 'coding-compaction-basic/src/summarizer.ts'

const MODEL = 'mock'
const SIGNAL = new AbortController().signal
const PROMPT = 'explored implementation detail '.repeat(60)
const CALL_ID = CallId('call-context-compact')

/** A summarizer under test control: it can block, fail, or append mid-call. */
class GatedCompactionEngine extends BasicCompactionEngine {
  summary: ContentBlock[] = [{ type: 'text', text: 'checkpoint' }]
  error: unknown
  gate: Promise<undefined> | undefined
  duringSummary: (() => void) | undefined
  calls: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls.push(input)
    this.duringSummary?.()
    if (this.gate !== undefined) await this.gate
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      rawOutput: this.summary,
      llmStreamCall: true,
      provider: 'summary-provider',
      model: 'summary-model',
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly compact: GatedCompactionEngine
}

/** Service over a live session; the agent only supplies the session and routing. */
function harness(): Harness {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  const session = Session.create(SessionId('in-turn-compact'))
  const agent = {
    session,
    options: { provider: MODEL, model: MODEL },
  } as unknown as Agent
  return { ctx, session, agent, compact: new GatedCompactionEngine(ctx, { auto: false }) }
}

/**
 * A closed first turn carrying exploration, followed by a second turn that is
 * still open and ends in the unanswered tool call the request came from.
 * @param harnessUnderTest - harness owning the session.
 * @param exchanges - how many closed user/assistant exchanges the first turn holds.
 * @returns the session in the state a running tool call sees.
 */
function openTurnSession(harnessUnderTest: Harness, exchanges = 2): Session {
  const { session } = harnessUnderTest
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  for (let index = 1; index <= exchanges; index += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${PROMPT} ${index}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: index })
    session.append('assistant/message', {
      turn: 1,
      step: index,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `finding ${index}` }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: index })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'now implement it' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: CALL_ID, name: 'context_compact', arguments: '{"focus":"implement it"}' }],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: CALL_ID,
    name: 'context_compact',
    arguments: '{"focus":"implement it"}',
  })
  return session
}

/** Text of every derived model-visible message, in request order. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().map((message: Message) => message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join(''))
}

/** Await one classified compaction rejection. */
async function rejection(operation: Promise<unknown>): Promise<ManualCompactionError> {
  let caught: unknown
  try {
    const value = await operation
    throw new Error(`expected a rejection, resolved with ${String(value)}`)
  } catch (error: unknown) {
    caught = error
  }
  if (!(caught instanceof ManualCompactionError)) {
    throw new Error(`expected a ManualCompactionError, got ${String(caught)}`)
  }
  return caught
}

/** The turn number recorded on one compaction marker. */
function markerTurn(session: Session, type: 'compaction/start' | 'compaction/end'): number | null {
  const event = session.events.findLast(candidate => candidate.type === type)
  if (event === undefined || event.type !== type) throw new Error(`no ${type} event`)
  return event.data.turn
}

describe('compactContext inside an open turn', () => {
  it('replaces the history before the asking step and keeps that step', async () => {
    const underTest = harness()
    const session = openTurnSession(underTest)
    const openStep = session.surface.nodes.at(-1)

    const result = await underTest.compact.compactContext(
      underTest.agent,
      { focus: 'implement the parser' },
      SIGNAL,
    )

    expect(result).not.toBeNull()
    expect(session.events.filter(event => event.type.startsWith('compaction/')).map(event => event.type))
      .toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
    expect(markerTurn(session, 'compaction/start')).toBe(2)
    expect(markerTurn(session, 'compaction/end')).toBe(2)
    expect(session.surface.nodes).toHaveLength(2)
    expect(session.surface.nodes.at(-1)).toBe(openStep)
    const messages = derivedText(session)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('checkpoint')
    expect(messages[0]).not.toContain(PROMPT)
  })

  it('carries the requester focus into the summarization input', async () => {
    const underTest = harness()
    openTurnSession(underTest)

    await underTest.compact.compactContext(underTest.agent, { focus: 'implement the parser' }, SIGNAL)

    expect(underTest.compact.calls).toHaveLength(1)
    expect(underTest.compact.calls[0]?.focus).toBe('implement the parser')
    expect(underTest.compact.calls[0]?.messages.length).toBeGreaterThan(0)
  })

  it('summarizes without a focus when the request states none', async () => {
    const underTest = harness()
    openTurnSession(underTest)

    await underTest.compact.compactContext(underTest.agent, {}, SIGNAL)

    expect(underTest.compact.calls[0]).not.toHaveProperty('focus')
  })

  it('reports nothing to compact when the open step is all that is left', async () => {
    const underTest = harness()
    const { session } = underTest
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: CALL_ID, name: 'context_compact', arguments: '{}' }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CALL_ID, name: 'context_compact', arguments: '{}' })
    const before = session.events.length

    const result = await underTest.compact.compactContext(underTest.agent, {}, SIGNAL)

    expect(result).toBeNull()
    expect(session.events).toHaveLength(before)
    expect(underTest.compact.calls).toEqual([])
  })

  it('classifies an active compaction as busy without writing', async () => {
    const underTest = harness()
    const session = openTurnSession(underTest)
    session.append('compaction/start', { compactionId: CompactionId('other'), turn: 2 })
    const before = session.events.length

    const error = await rejection(underTest.compact.compactContext(underTest.agent, {}, SIGNAL))

    expect(error.code).toBe('busy')
    expect(session.events).toHaveLength(before)
  })

  it('classifies a summarizer failure as summary and leaves history unchanged', async () => {
    const underTest = harness()
    const session = openTurnSession(underTest)
    const surfaceBefore = [...session.surface.nodes]
    underTest.compact.error = new Error('summarizer unavailable')

    const error = await rejection(underTest.compact.compactContext(underTest.agent, {}, SIGNAL))

    expect(error.code).toBe('summary')
    expect(session.surface.nodes).toEqual(surfaceBefore)
    const end = session.events.at(-1)
    if (end?.type !== 'compaction/end') throw new Error('expected a closing marker')
    expect(end.data.error).toContain('summarizer unavailable')
  })

  it('keeps nodes appended while the summary runs', async () => {
    const underTest = harness()
    const session = openTurnSession(underTest)
    underTest.compact.duringSummary = () => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'INJECTED DURING SUMMARY' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), { surfaceOp: 'append' })
    }

    const result = await underTest.compact.compactContext(underTest.agent, {}, SIGNAL)

    expect(result).not.toBeNull()
    expect(session.surface.nodes).toHaveLength(3)
    expect(derivedText(session).some(text => text.includes('INJECTED DURING SUMMARY'))).toBe(true)
  })

  it('preserves the abort reason instead of classifying it', async () => {
    const underTest = harness()
    openTurnSession(underTest)
    const gate = Promise.withResolvers<undefined>()
    underTest.compact.gate = gate.promise
    const controller = new AbortController()
    const reason = new Error('caller cancelled')

    const running = underTest.compact.compactContext(underTest.agent, {}, controller.signal)
    await Promise.resolve()
    controller.abort(reason)
    gate.resolve(undefined)

    await expect(running).rejects.toBe(reason)
  })
})
