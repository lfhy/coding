import { describe, expect, it } from 'vitest'
import type { SessionId, SessionSummary, SubagentCatalogSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { indexSubagentDescendants, summarizeVisibleSubagents } from '@deepseek-ai/dsh-client-runtime/client'

const sid = (id: string) => id as SessionId

function summary(
  id: string,
  parentId?: SessionId,
  origin?: 'subagent',
  running = false,
): SessionSummary {
  return {
    id: sid(id), displayTitle: id, running, blank: false, updatedAt: 0,
    ...(parentId === undefined ? {} : { parentId }),
    ...(origin === undefined ? {} : { origin }),
  }
}

function index(...summaries: SessionSummary[]) {
  return indexSubagentDescendants(Object.fromEntries(
    summaries.map(item => [item.id, item]),
  ))
}

describe('indexSubagentDescendants', () => {
  it('counts every nested descendant and its exact running state', () => {
    const owner = summary('owner')
    const child = summary('child', owner.id, 'subagent')
    const grandchild = summary('grandchild', child.id, 'subagent', true)

    const result = index(owner, child, grandchild)
    expect(result.get(owner.id)).toEqual({ count: 2, runningCount: 1 })
    expect(result.get(child.id)).toEqual({ count: 1, runningCount: 1 })
  })

  it('stops at ordinary forks and fails soft on cycles and missing parents', () => {
    const owner = summary('owner')
    const child = summary('child', owner.id, 'subagent', true)
    const fork = summary('fork', child.id)
    const forkChild = summary('fork-child', fork.id, 'subagent', true)
    const orphan = summary('orphan', sid('missing'), 'subagent', true)
    const cycleA = summary('cycle-a', sid('cycle-b'), 'subagent')
    const cycleB = summary('cycle-b', sid('cycle-a'), 'subagent')

    const result = index(owner, child, fork, forkChild, orphan, cycleA, cycleB)
    expect(result.get(owner.id)).toEqual({ count: 1, runningCount: 1 })
    expect(result.get(fork.id)).toEqual({ count: 1, runningCount: 1 })
    expect(result.get(sid('missing'))).toEqual({ count: 1, runningCount: 1 })
    expect(result.get(cycleA.id)).toEqual({ count: 2, runningCount: 0 })
    expect(result.get(cycleB.id)).toEqual({ count: 2, runningCount: 0 })
  })
})

describe('summarizeVisibleSubagents', () => {
  it('unions catalog-first direct children with the retained lineage and prefers their activity', () => {
    const owner = summary('owner')
    const child = summary('child', owner.id, 'subagent')
    const grandchild = summary('grandchild', child.id, 'subagent', true)
    const summaries = Object.fromEntries([owner, child, grandchild].map(item => [item.id, item]))
    const catalog: SubagentCatalogSnapshot = {
      entries: [
        { kind: 'child', id: child.id, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
        { kind: 'child', id: sid('new'), mode: 'one-shot', activity: 'running', hasChildren: false },
        { kind: 'diagnostic', id: sid('bad'), reason: 'corrupt' },
      ],
      parentAvailable: true, state: 'ready', error: null,
    }
    expect(summarizeVisibleSubagents(summaries, owner.id, catalog))
      .toEqual({ count: 3, runningCount: 3 })
    expect(summarizeVisibleSubagents(summaries, owner.id, undefined))
      .toEqual({ count: 2, runningCount: 1 })
  })
})
