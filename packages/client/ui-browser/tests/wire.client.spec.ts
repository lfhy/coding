import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl, parseBrowserState, parseBrowserStateOrLock } from '../src/client/wire.ts'
import { otherId, state } from './browser-fixtures.ts'

describe('browser state wire', () => {
  it('projects tab identities, active observation, and safe URLs', () => {
    expect(parseBrowserState({ ...state(), extra: 1 })).toEqual(state())
    expect(normalizeBrowserUrl('example.com/path')).toBe('https://example.com/path')
    expect(normalizeBrowserUrl('example.com:8080')).toBe('https://example.com:8080/')
    expect(normalizeBrowserUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
  })
  it('projects optional loading while preserving explicit false and existing unknown-field policy', () => {
    for (const loading of [true, false]) {
      const tab = { ...state().tabs[0], loading, extra: 'ignored' }
      expect(parseBrowserState({ ...state(), tabs: [tab] }).tabs[0]).toEqual({ ...state().tabs[0], loading })
    }
    expect(parseBrowserState(state()).tabs[0]).not.toHaveProperty('loading')
    expect(() => parseBrowserState({ ...state(), tabs: [{ ...state().tabs[0], loading: 'yes' }] })).toThrow('浏览器标签字段无效')
  })
  it('accepts only the exact lock-only response and validates the full-state operation flag', () => {
    expect(parseBrowserStateOrLock({ operationActive: true })).toEqual({ operationActive: true })
    expect(() => parseBrowserStateOrLock({ operationActive: true, tabs: [] })).toThrow()
    expect(() => parseBrowserStateOrLock({ operationActive: false })).toThrow()
    expect(() => parseBrowserState({ ...state(), operationActive: 'yes' })).toThrow()
  })
  it('accepts the provider multiline Page text and Elements snapshot without weakening other fields', () => {
    const snapshot = 'Page text:\nExample Domain\r\nA sample\tlink\nElements:\n[1] link "More information"'
    const observation = { ...state().observation, snapshot }
    expect(parseBrowserState({ ...state(), observation }).observation?.snapshot).toBe(snapshot)
    expect(() => parseBrowserState({ ...state(), observation: { ...observation, title: 'Bad\nTitle' } })).toThrow()
  })
  it.each(['\u0000', '\u0001', '\u000b', '\u001b', '\u007f', 'x'.repeat(12_001)])(
    'rejects invalid snapshot content %#', (snapshot) => {
      expect(() => parseBrowserState({ ...state(), observation: { ...state().observation, snapshot } })).toThrow()
    },
  )
  it.each([
    null, [], { ...state(), browserGeneration: '../bad' },
    { ...state(), stateRevision: -1 },
    { ...state(), viewport: { width: 199, height: 720 } },
    { ...state(), viewport: { width: 1920, height: 1400 } },
    { ...state(), activeTabId: otherId, hasFrame: true },
    { ...state(), observation: { ...state().observation, tabId: otherId } },
    { ...state(), observation: { ...state().observation, generation: 'wrong' } },
    { ...state(), tabs: [state().tabs[0], state().tabs[0]] },
    { ...state(), tabs: [{ ...state().tabs[0], url: 'javascript:alert(1)' }] },
    { ...state(), observation: { ...state().observation, cursor: { x: 9999, y: 0, kind: 'click', at: 1 } } },
  ])('rejects malformed Host JSON %#', (value) => {
    expect(() => parseBrowserState(value)).toThrow()
  })
  it.each(['javascript:alert(1)', 'https://user:pass@example.com', 'file:///tmp/x', 'not a domain', 'https://example.com/\n'])(
    'rejects unsafe address input %s', (input) => { expect(() => normalizeBrowserUrl(input)).toThrow() },
  )
})
