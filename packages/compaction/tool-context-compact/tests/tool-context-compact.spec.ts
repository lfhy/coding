// The model-facing `context_compact` contract: what the model sees, what each
// settled outcome reports, and that the seam request carries the stated focus.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
} from 'coding-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ContextCompactionRequest,
  ManualCompactAgentContext,
} from 'coding-compaction'
import { CallId } from 'coding-llm'
import { Session, SessionId } from 'coding-session'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import type { ToolExecutionResult } from 'coding-tools'
import * as ToolContextCompact from 'coding-tool-context-compact'

/** The one durable-shape result every backend reports. */
const RESULT: CompactionResult = {
  compactionId: CompactionId('tool-context-compact-test'),
  startSeq: 4,
  summarySeq: 5,
  endSeq: 6,
  summary: [{ type: 'text', text: 'checkpoint' }],
  shadowedRange: { start: 1, end: 9 },
  shadowedSeqs: [1, 3, 7, 9],
  shadowedTokenCount: 12_345,
}

/** Backend double: scripted results and failures, recording every request. */
class ScriptedCompactionEngine extends CompactionEngine {
  requests: ContextCompactionRequest[] = []
  result: CompactionResult | null = RESULT
  failure: unknown
  /** Runs inside the call, so a test can cancel it while it is in flight. */
  onRun: (() => void) | undefined

  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.reject(new Error('context_compact must never run automatic policy'))
  }

  override compactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.reject(new Error('context_compact must never run the idle command path'))
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new Error('context_compact must never force an explicit range'))
  }

  override async compactContext(
    _agent: CompactionAgentContext,
    request: ContextCompactionRequest,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.requests.push(request)
    this.onRun?.()
    if (this.failure !== undefined) throw this.failure
    return this.result
  }
}

interface Harness {
  readonly ctx: Context
  readonly compact: ScriptedCompactionEngine
  readonly session: Session
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** A registry plus the scripted backend, sharing one session per test. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const compact = new ScriptedCompactionEngine(ctx)
  await ctx.plugin(ToolContextCompact)
  return { ctx, compact, session: Session.create(SessionId('tool-context-compact')) }
}

/** Call the tool the way the agent loop does, with the session owner attached. */
function call(
  under: Harness,
  args: Record<string, unknown>,
  withAgent = true,
): Promise<ToolExecutionResult> {
  return under.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-context-compact'),
    name: 'context_compact',
    arguments: args,
    ...withAgent ? { agent: { session: under.session } as never } : {},
  })
}

/** Flatten a settled result's model-facing text. */
function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('context_compact tool contract', () => {
  it('publishes one optional focus parameter and a status value', async () => {
    const under = await harness()
    const schema = under.ctx.tools.schemas().find(candidate => candidate.name === 'context_compact')
    if (schema === undefined) throw new Error('context_compact was not registered')
    expect(schema.description).toContain('checkpoint')
    expect(schema.parameters).toMatchObject({
      type: 'object',
      properties: { focus: { type: 'string' } },
    })
    expect(schema.parameters).not.toHaveProperty('required')
  })

  it('reports the replaced items and tokens after a successful compaction', async () => {
    const under = await harness()

    const result = await call(under, { focus: 'implement the parser' })

    expect(result.isError).toBe(false)
    expect(under.compact.requests).toEqual([{ focus: 'implement the parser' }])
    expect(text(result)).toBe(
      'Compacted 4 earlier history items (~12345 tokens) into a checkpoint. '
      + 'Build on that checkpoint instead of restating it, and continue with the current task.',
    )
  })

  it('sends no focus when the model states none', async () => {
    const under = await harness()

    await call(under, {})

    expect(under.compact.requests).toEqual([{}])
  })

  it('drops a blank focus and keeps a trimmed one', async () => {
    const under = await harness()

    await call(under, { focus: '   ' })
    await call(under, { focus: '  ship the parser  ' })

    expect(under.compact.requests).toEqual([{}, { focus: 'ship the parser' }])
  })

  it('rejects a focus longer than the summarizer budget', async () => {
    const under = await harness()

    const result = await call(under, { focus: 'x'.repeat(2001) })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at most 2000 characters')
    expect(under.compact.requests).toEqual([])
  })

  it('reports nothing to compact without claiming a reduction', async () => {
    const under = await harness()
    under.compact.result = null

    const result = await call(under, {})

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('already short enough')
  })

  it('reports an active compaction as busy', async () => {
    const under = await harness()
    under.compact.failure = new ManualCompactionError('busy', 'compaction already in progress')

    const result = await call(under, {})

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('another compaction is already running')
  })

  it.each([
    ['changed', 'the selected history changed'],
    ['summary', 'would not have been smaller'],
    ['commit', 'may not have applied cleanly'],
  ] as const)('reports a %s failure as an unchanged-history outcome', async (code, expected) => {
    const under = await harness()
    under.compact.failure = new ManualCompactionError(code, 'failed')

    const result = await call(under, {})

    expect(result.isError).toBe(false)
    expect(text(result)).toContain(expected)
  })

  it.each(['cancelled', 'persistence'] as const)('fails the call on a %s error', async (code) => {
    const under = await harness()
    under.compact.failure = new ManualCompactionError(code, 'failed')

    const result = await call(under, {})

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('failed')
  })

  it('lets cancellation win over an otherwise classified failure', async () => {
    const under = await harness()
    const controller = new AbortController()
    under.compact.failure = new ManualCompactionError('changed', 'history changed')
    under.compact.onRun = () => { controller.abort(new Error('cancelled by the caller')) }

    const result = await under.ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('call-context-compact'),
      name: 'context_compact',
      arguments: {},
      agent: { session: under.session } as never,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('history changed')
  })

  it('fails the call on an unexpected backend error', async () => {
    const under = await harness()
    under.compact.failure = new Error('token meter exploded')

    const result = await call(under, {})

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('token meter exploded')
  })

  it('requires the calling agent', async () => {
    const under = await harness()

    const result = await call(under, {}, false)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires the calling agent')
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    new ScriptedCompactionEngine(ctx)
    const fiber = await ctx.plugin(ToolContextCompact)
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'context_compact')).toBe(true)

    await fiber.dispose()

    expect(ctx.tools.schemas().some(candidate => candidate.name === 'context_compact')).toBe(false)
  })
})
