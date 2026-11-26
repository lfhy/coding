/** IDE store 的标签、草稿、目录缓存与相邻选择语义。 */
import { describe, expect, it } from 'vitest'
import { createIdeWorkspaceStore } from '../src/client/ide-store.ts'

function setup() {
  return createIdeWorkspaceStore().create('session')
}

describe('IDE 工作区 store', () => {
  it('目录缓存保留加载中的旧快照，并切换展开状态', () => {
    const store = setup()
    const entries = [{ name: 'a.ts', type: 'file' as const, segments: ['a.ts'] }]
    store.actions.setDirectory('', 'ready', entries, true)
    store.actions.setDirectory('', 'loading')
    expect(store.getSnapshot().directories['']).toEqual({ status: 'loading', entries, truncated: true })
    store.actions.setDirectory('src', 'error')
    expect(store.getSnapshot().directories['src']).toEqual({ status: 'error', entries: [], truncated: false })
    store.actions.toggleExpanded('src')
    store.actions.toggleExpanded('lib')
    store.actions.toggleExpanded('src')
    expect(store.getSnapshot().expanded).toEqual(['lib'])
  })

  it('打开与重载标签保留顺序，激活只接受已打开路径', () => {
    const store = setup()
    store.actions.openTab('a.ts', 'a.ts', ['a.ts'])
    store.actions.openTab('a.ts', 'a.ts', ['a.ts'])
    store.actions.openTab('b.ts', 'b.ts', ['b.ts'])
    expect(store.getSnapshot().tabs.map(tab => tab.path)).toEqual(['a.ts', 'b.ts'])
    store.actions.activateTab('missing')
    expect(store.getSnapshot().activePath).toBe('b.ts')
    store.actions.reloadTab('a.ts', 'a.ts', ['a.ts'])
    expect(store.getSnapshot().tabs[0]).toMatchObject({ path: 'a.ts', status: 'loading', content: '' })
    store.actions.reloadTab('c.ts', 'c.ts', ['c.ts'])
    expect(store.getSnapshot().tabs.map(tab => tab.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('读取、编辑、保存与失败动作只影响存在的活动草稿', () => {
    const store = setup()
    store.actions.openTab('a.ts', 'a.ts', ['a.ts'])
    store.actions.updateTab('a.ts', 'ignored while loading')
    expect(store.getSnapshot().tabs[0]?.content).toBe('')
    store.actions.readyTab('a.ts', 'old', 'v1')
    store.actions.updateTab('a.ts', 'new')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ content: 'new', savedContent: 'old', dirty: true })
    store.actions.failTab('a.ts', 'save', 'ready')
    store.actions.updateTab('a.ts', 'newer')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ content: 'newer', dirty: true, error: 'save' })
    store.actions.savedTab('a.ts', 'v2', 'new')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ version: 'v2', savedContent: 'new', dirty: true })
    store.actions.savedTab('a.ts', 'v3', 'newer')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ version: 'v3', dirty: false, status: 'ready' })
    store.actions.failTab('a.ts', 'load')
    expect(store.getSnapshot().tabs[0]).toMatchObject({ status: 'error', error: 'load' })
    store.actions.updateTab('a.ts', 'newer')
    expect(store.getSnapshot().tabs[0]?.dirty).toBe(false)

    store.actions.readyTab('missing', 'x', 'v1')
    store.actions.updateTab('missing', 'x')
    store.actions.savedTab('missing', 'v2', 'x')
    store.actions.failTab('missing', 'load')
    expect(store.getSnapshot().tabs).toHaveLength(1)
  })

  it('关闭标签选择相邻项，关闭非活动标签不改变选择', () => {
    const store = setup()
    for (const path of ['a.ts', 'b.ts', 'c.ts']) store.actions.openTab(path, path, [path])
    store.actions.closeTab('b.ts')
    expect(store.getSnapshot().activePath).toBe('c.ts')
    store.actions.closeTab('a.ts')
    expect(store.getSnapshot().activePath).toBe('c.ts')
    store.actions.closeTab('c.ts')
    expect(store.getSnapshot().activePath).toBeNull()
    store.actions.closeTab('missing')
    expect(store.getSnapshot().tabs).toEqual([])
  })
})
