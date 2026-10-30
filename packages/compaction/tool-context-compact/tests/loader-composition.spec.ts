// Proves `context_compact` reaches the model through the shipped Loader path:
// a cordis.yml boot mounts the tool beside a compaction backend, and the call
// it makes is the one the backend records.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from 'coding-agent'
import {
  CompactionEngine,
  CompactionId,
} from 'coding-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  ContextCompactionRequest,
} from 'coding-compaction'
import { CallId } from 'coding-llm'
import { Session, SessionId } from 'coding-session'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import * as ToolContextCompact from 'coding-tool-context-compact'

const COMPACTION_ID = CompactionId('loader-context-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'loader checkpoint' }],
  shadowedRange: { start: 3, end: 6 },
  shadowedSeqs: [3, 4, 6],
  shadowedTokenCount: 77,
}

/** Backend that records the transaction it was asked to run. */
class LoaderCompactionEngine extends CompactionEngine {
  override compactIfNeeded(): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactNow(): Promise<CompactionResult | null> {
    return Promise.reject(new Error('the model path must not use the idle command entry point'))
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new Error('the model path must not force an explicit range'))
  }

  override compactContext(
    agent: CompactionAgentContext,
    request: ContextCompactionRequest,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const turn = 1
    agent.session.append('turn/start', { turn })
    const focus = request.focus === undefined ? {} : { focus: request.focus }
    agent.session.append('compaction/start', { compactionId: COMPACTION_ID, turn })
    agent.session.append('compaction/summary', {
      compactionId: COMPACTION_ID,
      summary: RESULT.summary,
      shadowedRange: RESULT.shadowedRange,
      shadowedSeqs: RESULT.shadowedSeqs,
      shadowedTokenCount: RESULT.shadowedTokenCount,
      provider: 'loader-test',
      model: 'loader-test',
      ...focus,
    })
    agent.session.append('compaction/end', { compactionId: COMPACTION_ID, turn })
    return Promise.resolve(RESULT)
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the shipped composition shape through the real Loader. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-context-compact-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: '@test/compaction-backend'",
    "- name: 'coding-tool-context-compact'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-system-prompt', SystemPrompt],
    ['coding-tools', ToolRuntime],
    ['@test/compaction-backend', LoaderCompactionEngine],
    ['coding-tool-context-compact', ToolContextCompact],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('tool-context-compact real Loader composition', () => {
  it('offers context_compact and records the compaction it requests', async () => {
    const ctx = await boot()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'context_compact')
    if (schema === undefined) throw new Error('Loader composition did not register context_compact')
    expect(schema.description).toContain('free context')

    const session = Session.create(SessionId('loader-context-compact'))
    const agent = { session, options: {} } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-context-compact'),
      name: 'context_compact',
      arguments: { focus: 'implement the loader change' },
      agent,
    })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Compacted 3 earlier history items (~77 tokens) into a checkpoint. '
        + 'Build on that checkpoint instead of restating it, and continue with the current task.',
    }])
    const summary = session.events.find(event => event.type === 'compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('no compaction summary was recorded')
    expect(summary.data.shadowedSeqs).toEqual(RESULT.shadowedSeqs)
    expect(summary.data).toMatchObject({ focus: 'implement the loader change' })
  })
})
