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
  it('normalizes local file addresses without treating domains as file paths', () => {
    expect(normalizeBrowserUrl('file:///tmp/index.html')).toBe('file:///tmp/index.html')
    expect(normalizeBrowserUrl(' file:///tmp/中文%20文档.html '))
      .toBe('file:///tmp/%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3.html')
    expect(normalizeBrowserUrl('file:///tmp/a%20b.html')).toBe('file:///tmp/a%20b.html')
    expect(normalizeBrowserUrl('example.com/guide')).toBe('https://example.com/guide')
  })
  it('preserves local file URLs in both the tab and its observation', () => {
    const file = 'file:///tmp/%E4%B8%AD%E6%96%87%20document.html'
    const current = state()
    const parsed = parseBrowserState({ ...current,
      tabs: current.tabs.map(tab => tab.id === current.activeTabId ? { ...tab, url: file } : tab),
      observation: { ...current.observation, url: file },
    })
    expect(parsed.tabs[0]?.url).toBe(file)
    expect(parsed.observation?.url).toBe(file)
  })
  it.each([
    'file://remote.example/tmp/index.html', 'file://localhost/tmp/index.html', 'file:////remote.example/tmp/index.html',
    'file:/tmp/index.html', 'file:///tmp\\index.html', 'file:///tmp/%2findex.html',
    'file:///tmp/%5Cindex.html', 'file:///tmp/%00index.html', 'file:///tmp/%GGindex.html',
    'file:///tmp/index.html\n', 'file:///tmp/' + 'a'.repeat(4096),
    'file://user@remote.example/index.html', 'ftp://example.com/x', 'data:text/html,hi',
  ])('rejects ambiguous or nonlocal file navigation %#', (url) => {
    expect(() => normalizeBrowserUrl(url)).toThrow()
    for (const field of ['tab', 'observation'] as const) {
      const current = state()
      const incoming = field === 'tab'
        ? { ...current, tabs: [{ ...current.tabs[0], url }, current.tabs[1]] }
        : { ...current, observation: { ...current.observation, url } }
      expect(() => parseBrowserState(incoming)).toThrow()
    }
  })
  it.each([
    'file:///tmp/../etc/index.html', 'file:///tmp/%2e%2e/index.html',
  ])('normalizes address bar input while rejecting unnormalized state %#', (input) => {
    const canonical = normalizeBrowserUrl(input)
    const current = state()
    expect(() => parseBrowserState({ ...current, tabs: [{ ...current.tabs[0], url: input }, current.tabs[1]] })).toThrow()
    expect(parseBrowserState({ ...current, tabs: [{ ...current.tabs[0], url: canonical }, current.tabs[1]] })
      .tabs[0]?.url).toBe(canonical)
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
  it.each(['javascript:alert(1)', 'https://user:pass@example.com', 'not a domain', 'https://example.com/\n'])(
    'rejects unsafe address input %s', (input) => { expect(() => normalizeBrowserUrl(input)).toThrow() },
  )
})
