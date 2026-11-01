import { describe, expect, it } from 'vitest'
import {
  actionKind, actionLabelKey, appendAction, MAX_ACTIONS, recentActions, relativeTime, type EgoAction,
} from '../src/client/actions.ts'
import { en, zh } from '../src/client/locales.ts'

describe('最近动作归类与相对时间', () => {
  it('把带前缀和未知的工具名归类，不保留任何原始名称', () => {
    expect(actionKind('browser_navigate')).toBe('navigate')
    expect(actionKind('ego_click')).toBe('click')
    expect(actionKind('browser_wait_for_human')).toBe('human')
    expect(actionKind('browser_screenshot')).toBe('screenshot')
    expect(actionKind('browser_mystery')).toBe('other')
    expect(actionKind('')).toBe('other')
    expect(actionKind(undefined)).toBe('other')
    const kinds = new Set(['navigate', 'click', 'type', 'key', 'element', 'scroll', 'tabs', 'openTab',
      'closeTab', 'read', 'screenshot', 'wait', 'human', 'dialog', 'upload', 'download', 'network',
      'session', 'script', 'status', 'verify', 'settings', 'other'] as const)
    for (const kind of kinds) {
      const key = actionLabelKey(kind)
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
      expect(`${zh[key]}${en[key]}`).not.toMatch(/browser_|ego_/u)
    }
  })

  it('按秒、分钟和小时给出相对时间，未来时间显示为刚刚', () => {
    expect(relativeTime(10_000, 13_000)).toEqual({ key: 'timeNow' })
    expect(relativeTime(10_000, 22_000)).toEqual({ key: 'timeSeconds', count: 12 })
    expect(relativeTime(0, 5 * 60_000)).toEqual({ key: 'timeMinutes', count: 5 })
    expect(relativeTime(0, 3 * 3_600_000)).toEqual({ key: 'timeHours', count: 3 })
    expect(relativeTime(20_000, 10_000)).toEqual({ key: 'timeNow' })
  })

  it('最多保留 8 条并最新在前，重复通知只记一次', () => {
    let actions: readonly EgoAction[] = []
    for (let index = 0; index < 10; index++) {
      actions = appendAction(actions, { kind: 'click', at: index })
    }
    expect(actions).toHaveLength(MAX_ACTIONS)
    expect(actions.at(-1)?.at).toBe(9)
    expect(appendAction(actions, { kind: 'click', at: 9 })).toBe(actions)
    expect(recentActions(actions).map(action => action.at)).toEqual([9, 8, 7, 6, 5, 4, 3, 2])
  })
})
