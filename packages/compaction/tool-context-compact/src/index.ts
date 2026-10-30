/**
 * Model-facing `context_compact` tool over the backend-independent compaction
 * seam. The model decides when earlier history has stopped earning its tokens
 * and states what the remaining work still needs, so a new topic or the switch
 * from exploration to implementation no longer depends on automatic pressure to
 * free context.
 * @module coding-tool-context-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from 'coding-compaction'
import { defineTool } from 'coding-tools'

export const name = 'tool-context-compact'
export const inject = ['tools', 'compaction']

/** Longest focus the summarizer accepts, in characters. */
const FOCUS_LIMIT = 2000

/** Model-facing compaction statuses, also the output schema's enum. */
const STATUSES = ['compacted', 'nothing_to_compact', 'busy', 'failed'] as const

/** Failure classes reported through the canonical value instead of an exception. */
const FAILURES = ['changed', 'summary', 'commit'] as const

/**
 * Canonical outcome of one model-requested compaction. The `failed` member keeps
 * its failure class, so no reader has to treat an unclassified failure as valid.
 */
type CompactionOutcome =
  | { status: 'compacted'; shadowedItems: number; shadowedTokens: number }
  | { status: 'nothing_to_compact' | 'busy'; shadowedItems: number; shadowedTokens: number }
  | { status: 'failed'; failure: typeof FAILURES[number]; shadowedItems: number; shadowedTokens: number }

/**
 * Compose the model-facing description. It names the two situations automatic
 * pressure policy cannot see: a topic that moved on, and exploration finished
 * before the real work starts.
 */
const DESCRIPTION = [
  'Replace older conversation history with a structured checkpoint to free context.',
  'Use it when the history has stopped earning its tokens — the topic moved on, or exploration is finished and the real work is about to start.',
  'Pass `focus` to state what the remaining work needs (the concrete task, decisions and constraints that still apply, files and identifiers that matter), so the checkpoint keeps that and drops what the work has outgrown.',
  'The current step is never replaced. A busy or failed call leaves the conversation unchanged.',
].join(' ')

/**
 * Compose the failure explanation. Every branch is fully determined by the
 * recorded failure class, so a replay never needs extra state.
 * @param failure - the recorded failure class.
 * @returns the model-facing explanation.
 */
function describeFailure(failure: typeof FAILURES[number]): string {
  switch (failure) {
    case 'changed':
      return 'No compaction applied: the selected history changed before it could be replaced, so the conversation is unchanged. Continue, and retry once if the old history still crowds out the work.'
    case 'summary':
      return 'No compaction applied: the checkpoint would not have been smaller than the history it replaced. The conversation is unchanged; continue without it.'
    case 'commit':
      return 'Compaction may not have applied cleanly: some earlier history may have changed. Re-read what you depend on before continuing.'
  }
}

/**
 * Compose the explanation for one outcome. Every branch names what the model
 * should do next, so a refusal never ends the turn's work.
 * @param value - the settled outcome.
 * @returns the model-facing explanation.
 */
function describeOutcome(value: CompactionOutcome): string {
  switch (value.status) {
    case 'compacted':
      return `Compacted ${value.shadowedItems} earlier history items (~${value.shadowedTokens} tokens) into a checkpoint. `
        + 'Build on that checkpoint instead of restating it, and continue with the current task.'
    case 'nothing_to_compact':
      return 'No compaction applied: the history is already short enough to keep verbatim. Continue without it.'
    case 'busy':
      return 'No compaction applied: another compaction is already running. Continue the task, and compact later only if the history still crowds out the work.'
    case 'failed':
      return describeFailure(value.failure)
  }
}

/**
 * Trim the model's focus and bound it. The focus is replayed into the
 * summarization request, so an unbounded string would enlarge the very history
 * this call exists to shrink.
 * @param raw - focus supplied by the model, when present.
 * @returns the trimmed focus, or `undefined` when the model stated none.
 */
function normalizeFocus(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const focus = raw.trim()
  if (focus.length === 0) return undefined
  if (focus.length > FOCUS_LIMIT) {
    throw new Error(`invalid focus: at most ${FOCUS_LIMIT} characters (got ${focus.length})`)
  }
  return focus
}

/**
 * Report one outcome that replaced nothing.
 * @param outcome - the settled status, with its failure class when it failed.
 * @returns the canonical value.
 */
function unchanged(outcome: {
  status: 'nothing_to_compact' | 'busy'
} | {
  status: 'failed'
  failure: typeof FAILURES[number]
}): CompactionOutcome {
  return { ...outcome, shadowedItems: 0, shadowedTokens: 0 }
}

/**
 * Register `context_compact` over the composed compaction service.
 * @param ctx - context carrying the tool registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'context_compact',
    description: DESCRIPTION,
    parameters: {
      focus: {
        type: 'string',
        description: 'What the work continuing after the checkpoint needs preserved: the concrete task, the decisions and constraints that still apply, '
          + `and the files or identifiers that matter. Omit only when the whole history is equally relevant. At most ${FOCUS_LIMIT} characters.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            required: true,
            enum: [...STATUSES],
            description: 'What happened: `compacted`, `nothing_to_compact`, `busy`, or `failed`.',
          },
          shadowedItems: {
            type: 'integer',
            required: true,
            description: 'History items replaced by the checkpoint; 0 unless `status` is `compacted`.',
          },
          shadowedTokens: {
            type: 'integer',
            required: true,
            description: 'Estimated tokens those items occupied; 0 unless `status` is `compacted`.',
          },
          failure: {
            type: 'string',
            enum: [...FAILURES],
            description: 'Failure class, present only when `status` is `failed`.',
          },
        },
      },
      // The registry hands the schema's wide object; `execute` is the only writer
      // and never reports `failed` without its class.
      render: (_args, value) => [{
        type: 'text',
        text: describeOutcome(value as CompactionOutcome),
      }],
    },
    async execute(args, exec): Promise<CompactionOutcome> {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('context_compact requires the calling agent: only an agent owns the history to compact')
      }
      const focus = normalizeFocus(args.focus)
      try {
        const result = await ctx.compaction.compactContext(
          agent,
          focus === undefined ? {} : { focus },
          exec.signal,
        )
        if (result === null) return unchanged({ status: 'nothing_to_compact' })
        return {
          status: 'compacted',
          shadowedItems: result.shadowedSeqs.length,
          shadowedTokens: result.shadowedTokenCount,
        }
      } catch (error: unknown) {
        // Cancellation stays an abort; only the seam's classified failures become values.
        if (!(error instanceof ManualCompactionError) || exec.signal.aborted) throw error
        switch (error.code) {
          case 'busy':
            return unchanged({ status: 'busy' })
          case 'changed':
          case 'summary':
          case 'commit':
            return unchanged({ status: 'failed', failure: error.code })
          // No domain outcome to report: one call was cancelled, the other left the
          // session's memory and disk out of step, and both must surface as failures.
          case 'cancelled':
          case 'persistence':
            throw error
        }
      }
    },
  }))
}
