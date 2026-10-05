import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createRetainedWorkbenchStore, createWorkbenchStore, tabIdForSegments } from '../src/client/store.ts'

describe('file workbench store', () => {
  it('uses opaque provider segments as tab identity', () => {
    expect(tabIdForSegments(['C:\\work', 'a/b'])).toBe('["C:\\\\work","a/b"]')
    expect(tabIdForSegments(['/srv', 'a\\b'])).not.toBe(tabIdForSegments(['C:\\work', 'a/b']))
  })

  it('opens, activates, deduplicates, and closes tabs with an adjacent fallback', () => {
    const instance = createWorkbenchStore().create()
    const first = { name: 'first.ts', segments: ['src', 'first.ts'] }
    const second = { name: 'second.ts', segments: ['src', 'second.ts'] }
    const third = { name: 'third.ts', segments: ['src', 'third.ts'] }
    instance.actions.openFile(first)
    instance.actions.openFile(second)
    instance.actions.openFile(third)
    instance.actions.openFile(first)
    expect(instance.store.getSnapshot()).toMatchObject({
      tabs: [first, second, third],
      activeId: tabIdForSegments(first.segments),
    })

    instance.actions.activateFile(tabIdForSegments(second.segments))
    instance.actions.activateFile('missing')
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(second.segments))

    instance.actions.closeFile(tabIdForSegments(first.segments))
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(second.segments))
    instance.actions.closeFile(tabIdForSegments(second.segments))
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(third.segments))
    instance.actions.closeFile('missing')
    instance.actions.closeFile(tabIdForSegments(third.segments))
    expect(instance.store.getSnapshot()).toEqual({
      view: 'menu',
      tabs: [],
      activeId: null,
      nextTerminalNumber: 1,
      activeBrowserTabId: null,
      filesQuery: '',
      filesExpanded: [],
      filesLevels: {},
    })
  })

  it('retains the browser selection per Session and returns to files on tab activation', () => {
    const first = createWorkbenchStore().create()
    const second = createWorkbenchStore().create()
    const file = { name: 'notes.txt', segments: ['notes.txt'] }
    first.actions.openFile(file)
    first.actions.setView('browser')
    expect(first.store.getSnapshot().view).toBe('browser')
    expect(second.store.getSnapshot().view).toBe('menu')
    first.actions.activateFile(tabIdForSegments(file.segments))
    expect(first.store.getSnapshot()).toMatchObject({ view: 'files', activeId: tabIdForSegments(file.segments) })
    first.actions.setView('browser')
    first.actions.openFile({ name: 'next.txt', segments: ['next.txt'] })
    expect(first.store.getSnapshot().view).toBe('files')
  })

  it('keeps file viewing state in the session store', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.setFilesQuery('readme')
    instance.actions.toggleFilesExpanded('root')
    instance.actions.setFilesLevel(['src'], 'loading')
    instance.actions.setFilesListing(['src'], {
      path: '/w/src',
      entries: [{ name: 'main.ts', type: 'file', size: 1, segments: ['src', 'main.ts'] }],
      truncated: false,
    })
    expect(instance.store.getSnapshot()).toMatchObject({
      filesQuery: 'readme',
      filesExpanded: ['root'],
      filesLevels: {
        [tabIdForSegments(['src'])]: {
          phase: 'ready',
          segments: ['src'],
          listing: { path: '/w/src' },
        },
      },
    })

    instance.actions.setFilesLevel(['src'], 'error')
    expect(instance.store.getSnapshot()).toMatchObject({
      filesLevels: {
        [tabIdForSegments(['src'])]: {
          phase: 'error',
          listing: { path: '/w/src' },
        },
      },
    })
  })
})

describe('统一工作台标签', () => {
  it('按标签类型切换内容，关闭活动标签时选择相邻项，关闭最后一项回到菜单', () => {
    const instance = createWorkbenchStore().create()
    const fileId = tabIdForSegments(['notes.txt'])
    instance.actions.openFile({ name: 'notes.txt', segments: ['notes.txt'] })
    instance.actions.openTerminal()
    instance.actions.syncBrowserTabs([{ id: 'page', name: '页面' }], 'page')
    instance.actions.openTerminal()
    expect(instance.getSnapshot().tabs.map(tab => [tab.type, tab.id])).toEqual([
      ['file', fileId], ['terminal', 'terminal:1'], ['browser', 'browser:page'], ['terminal', 'terminal:2'],
    ])
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:2' })

    instance.actions.activateTab(fileId)
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: fileId })
    instance.actions.activateTab('browser:page')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:page' })
    instance.actions.closeTab('terminal:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:page' })
    instance.actions.closeTab('browser:page')
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:2' })
    instance.actions.closeTab('terminal:2')
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: fileId })
    instance.actions.activateTab('missing')
    instance.actions.closeTab('missing')
    instance.actions.closeTab(fileId)
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: null, tabs: [] })

    instance.actions.openTerminal()
    expect(instance.getSnapshot().tabs).toEqual([{ type: 'terminal', id: 'terminal:3', number: 3 }])
  })

  it('文件兼容动作只操作文件标签，视图入口恢复同类型的活动项', () => {
    const instance = createWorkbenchStore().create()
    const fileId = tabIdForSegments(['notes.txt'])
    instance.actions.openFile({ name: 'notes.txt', segments: ['notes.txt'] })
    instance.actions.openTerminal()
    instance.actions.activateFile('terminal:1')
    instance.actions.closeFile('terminal:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
    instance.actions.setView('files')
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: fileId })
    instance.actions.setView('terminal')
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
    instance.actions.setView('menu')
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: 'terminal:1' })
  })

  it('文件管理器作为独立标签复用，文件预览保持独立且关闭时回退到邻近标签', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.openTerminal()
    instance.actions.openFileManager()
    instance.actions.openFileManager()
    expect(instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['terminal', 'file-manager'])
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
    instance.actions.openFile({ name: 'readme.md', segments: ['readme.md'] })
    expect(instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['terminal', 'file-manager', 'file'])
    instance.actions.closeTab(tabIdForSegments(['readme.md']))
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
    instance.actions.closeTab('file-manager')
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
  })

  it('同步浏览器标题和活动页时保留文件与终端选择，返回浏览器时恢复 Host 活动页', () => {
    const instance = createWorkbenchStore().create()
    const fileId = tabIdForSegments(['notes.txt'])
    const pages = [{ id: 'one', name: '第一页' }, { id: 'two', name: '第二页' }]
    instance.actions.openFile({ name: 'notes.txt', segments: ['notes.txt'] })
    instance.actions.syncBrowserTabs(pages, 'one')
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: fileId })
    instance.actions.openTerminal()
    instance.actions.syncBrowserTabs([{ id: 'one', name: '更新标题' }, pages[1]!], 'two')
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
    expect(instance.getSnapshot().tabs.find(tab => tab.id === 'browser:one')).toMatchObject({ name: '更新标题' })
    instance.actions.setView('browser')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:two' })
    instance.actions.syncBrowserTabs(pages, 'one')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:one' })

    const unchanged = instance.getSnapshot()
    instance.actions.syncBrowserTabs(pages, 'one')
    expect(instance.getSnapshot()).toBe(unchanged)
    instance.actions.setView('menu')
    instance.actions.syncBrowserTabs([pages[1]!], 'two')
    expect(instance.getSnapshot().view).toBe('menu')
    instance.actions.setView('browser')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:two' })
    instance.actions.syncBrowserTabs([], null)
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
  })

  it('首次浏览器加载没有标签时保留入口，Host 关闭最后一个标签后返回菜单', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.setView('browser')
    instance.actions.syncBrowserTabs([], null)
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: null })
    instance.actions.syncBrowserTabs([{ id: 'page', name: '页面' }], 'page')
    expect(instance.getSnapshot()).toMatchObject({ view: 'browser', activeId: 'browser:page' })
    instance.actions.syncBrowserTabs([], null)
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: null, tabs: [] })
  })
})

describe('根级保留工作台状态', () => {
  const firstId = 'first-session' as SessionId
  const secondId = 'second-session' as SessionId

  it('按 Session 分别保留文件管理器，并在移除 Session 后释放', () => {
    const instance = createRetainedWorkbenchStore().create()
    instance.actions.openFileManager(firstId)
    instance.actions.openFileManager(secondId)
    instance.actions.openFile(firstId, { name: 'first.txt', segments: ['first.txt'] })
    expect(instance.getSnapshot().sessions[firstId]?.tabs.map(tab => tab.type)).toEqual(['file-manager', 'file'])
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({ view: 'files', activeId: 'file-manager' })
    instance.actions.retainSessions([secondId])
    expect(instance.getSnapshot().sessions[firstId]).toBeUndefined()
    expect(instance.getSnapshot().sessions[secondId]?.tabs).toEqual([{ type: 'file-manager', id: 'file-manager' }])
  })

  it('按 Session 延迟初始化，隔离标签和文件树，并仅释放离开会话列表的状态', () => {
    const instance = createRetainedWorkbenchStore().create()
    expect(instance.getSnapshot().sessions).toEqual({})
    instance.actions.initSession(firstId)
    const initialized = instance.getSnapshot()
    instance.actions.initSession(firstId)
    expect(instance.getSnapshot()).toBe(initialized)
    instance.actions.openTerminal(firstId)
    instance.actions.openTerminal(secondId)
    instance.actions.openFile(firstId, { name: 'first.txt', segments: ['first.txt'] })
    instance.actions.setFilesQuery(firstId, 'first')
    instance.actions.toggleFilesExpanded(firstId, 'root')
    instance.actions.setFilesLevel(firstId, [], 'loading')
    instance.actions.setFilesListing(firstId, [], { path: '/first', entries: [], truncated: false })
    instance.actions.syncBrowserTabs(secondId, [{ id: 'page', name: '页面' }], 'page')
    instance.actions.setView(secondId, 'browser')
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'files', filesQuery: 'first', filesExpanded: ['root'],
      filesLevels: { '[]': { phase: 'ready', listing: { path: '/first' } } },
    })
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({
      view: 'browser', activeId: 'browser:page', filesQuery: '', filesExpanded: [], filesLevels: {},
      tabs: [{ type: 'terminal', id: 'terminal:1', number: 1 }, { type: 'browser', id: 'browser:page' }],
    })
    instance.actions.activateTab(firstId, 'terminal:1')
    instance.actions.closeTab(firstId, 'terminal:1')
    instance.actions.activateFile(firstId, tabIdForSegments(['first.txt']))
    instance.actions.closeFile(firstId, tabIdForSegments(['first.txt']))
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({ view: 'menu', tabs: [] })

    const retained = instance.getSnapshot().sessions[secondId]
    instance.actions.retainSessions([secondId])
    expect(instance.getSnapshot().sessions).toEqual({ [secondId]: retained })
    instance.actions.retainSessions([secondId])
    expect(instance.getSnapshot().sessions[secondId]).toBe(retained)
    instance.actions.initSession(firstId)
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({ view: 'menu', tabs: [], nextTerminalNumber: 1 })
  })
})
