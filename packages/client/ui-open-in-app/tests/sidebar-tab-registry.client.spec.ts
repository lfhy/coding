import { describe, expect, it, vi } from 'vitest'
import {
  SidebarRightTabRegistry,
  type SidebarRightTabDefinition,
} from '../src/client/sidebar-tab-registry.ts'

function tab(id: string, kind = id, overrides: Partial<SidebarRightTabDefinition> = {}): SidebarRightTabDefinition {
  return { id, kind, title: address => `${id}: ${address}`, ...overrides }
}

describe('右侧标签类型注册表', () => {
  it('只保留当前注册，冲突失败不污染已注册项，旧 disposer 不移除重注册项', () => {
    const registry = new SidebarRightTabRegistry()
    const dispose = registry.register(tab('first', 'file', { priority: 'builtin' }))
    expect(() => registry.register(tab('first', 'other'))).toThrow('tab type id "first" is already registered')
    expect(() => registry.register(tab('another', 'file', { priority: 'builtin' }))).toThrow('tab kind "file"')
    expect(() => registry.register(tab('duplicate', 'other', {
      guide: [{ id: 'open', order: 1, title: () => '一' }, { id: 'open', order: 2, title: () => '二' }],
    }))).toThrow('duplicate guide entry id')
    expect(registry.entries().map(entry => entry.id)).toEqual(['first'])
    dispose()
    const replacement = tab('first', 'other')
    registry.register(replacement)
    dispose()
    expect(registry.get('other')).toBe(replacement)
  })

  it('extension 接管 builtin，撤销任意顺序后正确恢复或释放 kind', () => {
    const registry = new SidebarRightTabRegistry()
    const builtin = tab('builtin', 'file', {
      priority: 'builtin', guide: [{ id: 'open', order: 1, title: () => '内置' }],
    })
    const extension = tab('extension', 'file', {
      guide: [{ id: 'open', order: 1, title: () => '扩展' }],
    })
    const stopBuiltin = registry.register(builtin)
    const stopExtension = registry.register(extension)
    expect(registry.get('file')).toBe(extension)
    expect(registry.has('builtin')).toBe(true)
    expect(registry.has('extension')).toBe(true)
    expect(registry.entries()).toEqual([extension])
    expect(registry.guide()).toMatchObject([{ providerId: 'extension', kind: 'file' }])
    expect(() => registry.register(tab('another', 'file'))).toThrow('tab kind "file"')
    stopExtension()
    expect(registry.get('file')).toBe(builtin)
    expect(registry.has('extension')).toBe(false)
    expect(registry.has('builtin')).toBe(true)
    expect(registry.guide()).toMatchObject([{ providerId: 'builtin' }])
    stopBuiltin()
    expect(registry.get('file')).toBeUndefined()
    expect(registry.has('builtin')).toBe(false)

    const stopExtensionAgain = registry.register(extension)
    const stopBuiltinAgain = registry.register(builtin)
    stopBuiltinAgain()
    expect(registry.get('file')).toBe(extension)
    expect(registry.has('builtin')).toBe(false)
    expect(registry.has('extension')).toBe(true)
    stopExtensionAgain()
    expect(registry.entries()).toEqual([])
  })

  it('fallback 不共存，默认优先级是 extension', () => {
    const registry = new SidebarRightTabRegistry()
    const stopFallback = registry.register(tab('fallback', 'text', { priority: 'fallback' }))
    expect(() => registry.register(tab('extension', 'text'))).toThrow('tab kind "text"')
    stopFallback()
    const stopExtension = registry.register(tab('extension', 'text'))
    expect(() => registry.register(tab('fallback', 'text', { priority: 'fallback' }))).toThrow('tab kind "text"')
    stopExtension()
  })

  it('候选按优先级、最长匹配 pattern、注册顺序排列，显式 kind 跳过 pattern 但仍检查 veto', () => {
    const registry = new SidebarRightTabRegistry()
    registry.register(tab('fallback', 'fallback', { priority: 'fallback', patterns: ['*.md'] }))
    registry.register(tab('short', 'short', { priority: 'builtin', patterns: ['*.md'] }))
    registry.register(tab('long', 'long', { priority: 'builtin', patterns: ['**/*.md'] }))
    registry.register(tab('same', 'same', { priority: 'builtin', patterns: ['**/*.md'] }))
    registry.register(tab('veto', 'veto', { patterns: ['*.md'], canOpen: () => false }))
    expect(registry.candidates('dsh-resource://file/session/s1/.Notes.MD').map(entry => entry.id))
      .toEqual(['long', 'same', 'short', 'fallback'])
    expect(registry.claim('dsh-resource://file/session/s1/.Notes.MD')).toEqual({
      kind: 'long', contentId: 'dsh-resource://file/session/s1/.Notes.MD',
      title: 'long: dsh-resource://file/session/s1/.Notes.MD',
    })
    expect(registry.claim('sidebar://guide', 'short').kind).toBe('short')
    expect(() => registry.claim('sidebar://guide', 'veto')).toThrow('refuses')
    expect(() => registry.claim('sidebar://guide', 'missing')).toThrow('no tab type')
    expect(() => registry.claim('sidebar://guide')).toThrow('no registered tab type')
  })

  it('完整 URI pattern 匹配 scheme，path pattern 只接受 URI，接管者独占候选资格', () => {
    const registry = new SidebarRightTabRegistry()
    registry.register(tab('page', 'page', { patterns: ['sidebar://guide'] }))
    registry.register(tab('file', 'file', { patterns: ['dsh-resource://file/**'], priority: 'builtin' }))
    registry.register(tab('not-uri', 'suffix', { patterns: ['*.md'] }))
    expect(registry.candidates('sidebar://guide').map(entry => entry.id)).toEqual(['page'])
    expect(registry.candidates('dsh-resource://file/a.md').map(entry => entry.id)).toEqual(['not-uri', 'file'])
    expect(registry.candidates('/tmp/a.md')).toEqual([])
    const stop = registry.register(tab('override', 'file', { patterns: ['*.txt'] }))
    expect(registry.candidates('dsh-resource://file/a.md').map(entry => entry.id)).toEqual(['not-uri'])
    stop()
    expect(registry.candidates('dsh-resource://file/a.md').map(entry => entry.id)).toEqual(['not-uri', 'file'])
  })

  it('引导项排序稳定，文案延迟求值，变更同步通知且 snapshot 只在变更后递增', () => {
    const registry = new SidebarRightTabRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const initial = registry.getSnapshot()
    let title = '起初'
    const first = tab('first', 'first', {
      multiple: true, keepMounted: true,
      guide: [{ id: 'later', order: 3, title: () => title }],
    })
    const stopFirst = registry.register(first)
    const stable = registry.getSnapshot()
    expect(stable).toBeGreaterThan(initial)
    expect(registry.getSnapshot()).toBe(stable)
    expect(registry.entries()).toBe(registry.entries())
    expect(registry.guide()).toBe(registry.guide())
    expect(registry.guide()[0]?.title()).toBe('起初')
    title = '后来'
    expect(registry.guide()[0]?.title()).toBe('后来')
    registry.register(tab('second', 'second', {
      guide: [{ id: 'before', order: 1, title: () => '前' }, { id: 'tie', order: 3, title: () => '同序' }],
    }))
    expect(registry.guide().map(entry => `${entry.providerId}/${entry.id}`))
      .toEqual(['second/before', 'first/later', 'second/tie'])
    expect(listener).toHaveBeenCalledTimes(2)
    stopFirst()
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    registry.register(tab('third'))
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
