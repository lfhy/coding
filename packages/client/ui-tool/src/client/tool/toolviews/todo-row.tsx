// todo_write toolview: plan-flavored summary row replacing the generic
// "Tool call" card, registered into the keyed 'tool.call.toolview'
// hole like the bash sample (a product registration, not a sample). The row
// composes ToolRow (chrome, running sweep, whole-row expand) and swaps in a
// summary of the written list (counts + active items) from the call args, with
// the parallel-active count riding ToolRow's non-shrinking summary suffix so a
// narrow row never clips it; the durable list itself renders in the TodoPanel
// above the composer, so the row stays one line until expanded.

import { IconChecklistOutline14 } from 'coding-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { planSummary, type PlanItemLike } from './plan-summary.ts'

/** Todo row props: the toolview runtime share plus the standard locale seat. */
type TodoRowProps = ToolCallViewProps & PropsLocale<'conversation'>

function isItem(value: unknown): value is PlanItemLike {
  return typeof value === 'object' && value !== null
}

/**
 * The row's summary split at the ellipsis boundary: `text` truncates, `extra`
 * is the parallel-active count that must not, so a narrow row never clips the
 * one part that says several tasks are running.
 */
interface RowSummary {
  text: string
  extra: number
  body: string
}

function summarize(argsRaw: string, t: TodoRowProps['t']): RowSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // 流式截断或参数无效时不把原始输入放进折叠摘要。
    return null
  }
  // 失败调用也保留原始参数，只在检查详情中供开发者查看。
  if (typeof parsed !== 'object' || parsed === null) return null
  const todos = (parsed as { todos?: unknown }).todos
  if (!Array.isArray(todos) || !todos.every(isItem)) return null
  const { done, total, activeContent, activeExtra } = planSummary(todos)
  const head = t('todo.completed', { done, total })
  const labels: Record<string, string> = {
    completed: t('todo.item.completed'),
    in_progress: t('todo.item.active'),
    pending: t('todo.item.pending'),
  }
  return {
    text: activeContent === null ? head : `${head} · ${activeContent}`,
    extra: activeExtra,
    body: todos.map(item => typeof item.content === 'string' && typeof item.status === 'string'
      && labels[item.status] !== undefined ? `${labels[item.status]} · ${item.content}` : null).filter(Boolean).join('\n') || head,
  }
}

/** One-line plan update row (the whole row toggles the call's Input/Output
 *  sections, ToolRow's unified expand). Non-ok execution states keep the
 *  shared row's dot semantics — a cancelled call wrote no todo/write, so it
 *  must not read as a completed update. */
export function TodoRow({ toolName, block, inspect, t }: TodoRowProps) {
  const model = toolRowModel(toolName, block)
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const summary = summarize(argsRaw, t) ?? { text: t('todo.unavailable'), extra: 0, body: t('todo.unavailable') }
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconChecklistOutline14 />}
      title={t('todo.rowTitle')}
      summary={argsRaw === '' ? summary.text : model.summary || summary.text}
      summarySuffix={summary.extra > 0 ? `+${summary.extra}` : null}
      body={summary.body}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/**
 * The todo row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
export const todoToolview = {
  name: 'todo-toolview',
  inject: ['slots'],
  /**
   * Register the todo row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'todo_write', locale: NS }, TodoRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'update_plan', locale: NS }, TodoRow)
    })
  },
}
