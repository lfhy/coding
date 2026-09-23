/**
 * Pure subagent-lineage aggregation over the retained session-list mirror.
 * Ordinary forks terminate propagation so each visible session owns only its
 * uninterrupted subagent subtree.
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/subagent-lineage
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from './service.ts'
import type { SubagentCatalogSnapshot } from './manager.ts'

/** Descendant counts projected for one possible parent session. */
export interface SubagentDescendantSummary {
  /** All descendants connected through uninterrupted subagent-origin lineage. */
  readonly count: number
  /** Descendants whose exact session summary is currently running. */
  readonly runningCount: number
}

/**
 * Index every subagent descendant under each ancestor it reaches through an
 * uninterrupted subagent-origin chain. Cycles fail soft and orphan owners
 * remain harmless map keys until their summaries arrive.
 * @param summaries - retained session summaries keyed by id.
 * @returns descendant totals and running totals keyed by possible parent id.
 */
export function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, { count: number; runningCount: number }>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const seen = new Set<SessionId>()
    let current: SessionSummary | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined
      && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, {
          count: 1,
          runningCount: descendant.running ? 1 : 0,
        })
      } else {
        aggregate.count += 1
        if (descendant.running) aggregate.runningCount += 1
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}

function belongsTo(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  childId: SessionId,
  parentId: SessionId,
): boolean {
  const seen = new Set<SessionId>()
  let current = summaries[childId]
  while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
    if (current.parentId === parentId) return true
    seen.add(current.id)
    current = summaries[current.parentId]
  }
  return false
}

/**
 * 合并列表摘要中的完整后代与目录中先到达的直接子代理，按 id 去重。
 * 目录对直接子代理的活动状态优先于可能滞后的 Session 摘要；没有目录时仅用摘要。
 * @param summaries - 保留的 Session 摘要。
 * @param parentId - 当前会话 id。
 * @param catalog - 当前会话可见的直接子代理目录。
 * @returns 后代总数和运行中数。
 */
export function summarizeVisibleSubagents(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  parentId: SessionId,
  catalog: SubagentCatalogSnapshot | undefined,
): SubagentDescendantSummary {
  const lineage = indexSubagentDescendants(summaries).get(parentId)
  let count = lineage?.count ?? 0
  let runningCount = lineage?.runningCount ?? 0
  const seen = new Set<SessionId>()
  for (const entry of catalog?.entries ?? []) {
    if (entry.kind !== 'child' || seen.has(entry.id)) continue
    seen.add(entry.id)
    const running = entry.activity === 'running'
    if (belongsTo(summaries, entry.id, parentId)) {
      if (running !== summaries[entry.id]?.running) runningCount += running ? 1 : -1
    } else {
      count += 1
      if (running) runningCount += 1
    }
  }
  return { count, runningCount }
}
