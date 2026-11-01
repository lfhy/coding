import { describe, expect, it } from 'vitest'
import type { SessionId } from 'coding-session/types'
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
      nextLauncherNumber: 1,
      nextExternalNumber: 1,
      filesQuery: '',
      filesExpanded: [],
      filesLevels: {},
    })
  })

  it('retains file selection per Session and returns from the menu on tab activation', () => {
    const first = createWorkbenchStore().create()
    const second = createWorkbenchStore().create()
    const file = { name: 'notes.txt', segments: ['notes.txt'] }
    first.actions.openFile(file)
    first.actions.setView('menu')
    expect(first.store.getSnapshot().view).toBe('menu')
    expect(second.store.getSnapshot().view).toBe('menu')
    first.actions.activateFile(tabIdForSegments(file.segments))
    expect(first.store.getSnapshot()).toMatchObject({ view: 'files', activeId: tabIdForSegments(file.segments) })
    first.actions.setView('menu')
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
  it('历史记录单实例标签消费启动项、切换后保留并在关闭时回退邻项', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.openFileManager()
    instance.actions.openLauncher()
    instance.actions.openHistory()
    expect(instance.getSnapshot()).toMatchObject({ view: 'history', activeId: 'git-history',
      tabs: [{ type: 'file-manager' }, { type: 'history', id: 'git-history' }] })
    instance.actions.openLauncher()
    instance.actions.openHistory()
    expect(instance.getSnapshot().tabs).toHaveLength(2)
    instance.actions.activateTab('file-manager')
    instance.actions.activateTab('git-history')
    expect(instance.getSnapshot().view).toBe('history')
    instance.actions.closeTab('git-history')
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
  })

  it('为每次新增保留独立启动标签，并以新功能替换活动启动项', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.openTerminal()
    instance.actions.openLauncher()
    instance.actions.openLauncher()
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: 'launcher:2',
      tabs: [{ type: 'terminal' }, { type: 'launcher', id: 'launcher:1' }, { type: 'launcher', id: 'launcher:2' }] })
    instance.actions.openTerminal()
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:2',
      tabs: [{ type: 'terminal', id: 'terminal:1' }, { type: 'launcher', id: 'launcher:1' },
        { type: 'terminal', id: 'terminal:2' }] })
    instance.actions.activateTab('launcher:1')
    instance.actions.openFileManager()
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
    expect(instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['terminal', 'file-manager', 'terminal'])
    instance.actions.openLauncher()
    instance.actions.openFileManager()
    expect(instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['terminal', 'file-manager', 'terminal'])
    instance.actions.openLauncher()
    instance.actions.openExternalTab({ definitionId: 'plugin:notes', kind: 'notes', name: 'Notes', address: '/notes' })
    expect(instance.getSnapshot().tabs.map(tab => tab.type)).toEqual(['terminal', 'file-manager', 'terminal', 'external'])
    instance.actions.openLauncher()
    instance.actions.setView('files')
    expect(instance.getSnapshot().tabs.some(tab => tab.type === 'launcher')).toBe(false)
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
  })

  it('关闭启动标签仅修改本地状态，选择邻项或返回空菜单；返回菜单不创建启动项', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.openLauncher()
    instance.actions.openLauncher()
    instance.actions.activateTab('launcher:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: 'launcher:1' })
    instance.actions.closeTab('launcher:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: 'launcher:2' })
    instance.actions.setView('menu')
    expect(instance.getSnapshot().tabs.map(tab => tab.id)).toEqual(['launcher:2'])
    instance.actions.closeTab('launcher:2')
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: null, tabs: [] })
  })

  it('第三方标签按 kind 去重，保留初始 definitionId 并使每次导航递增 revision', () => {
    const instance = createWorkbenchStore().create()
    const first = { definitionId: 'plugin:issues', kind: 'issue', name: '问题', address: '/issues/1', params: { id: 1 } }
    instance.actions.openExternalTab(first)
    const id = instance.getSnapshot().activeId!
    expect(id).toBe('external:["issue"]')
    expect(instance.getSnapshot()).toMatchObject({
      view: 'external', tabs: [{ type: 'external', ...first, id, revision: 0 }],
    })
    instance.actions.openExternalTab({ ...first, definitionId: 'plugin:replacement' })
    expect(instance.getSnapshot().tabs).toHaveLength(1)
    expect(instance.getSnapshot().tabs[0]).toMatchObject({ definitionId: 'plugin:issues', revision: 1 })
    instance.actions.updateExternalTab(id, { address: first.address, params: first.params })
    expect(instance.getSnapshot().tabs[0]).toMatchObject({ name: '问题', revision: 2 })
    instance.actions.updateExternalTab(id, { name: '更新名称', address: '/issues/2', params: [2, null] })
    expect(instance.getSnapshot().tabs[0]).toMatchObject({ name: '更新名称', address: '/issues/2', params: [2, null], revision: 3 })
    instance.actions.updateExternalTab('missing', { address: '/missing' })
    expect(instance.getSnapshot().tabs).toHaveLength(1)
  })

  it('多个同类标签独立导航，ID 与内置标签不冲突，关闭时选择邻近项', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.openFileManager()
    const input = { definitionId: 'plugin:tasks', kind: 'terminal:1', name: '任务', address: '/tasks', multiple: true }
    instance.actions.openExternalTab(input)
    const firstId = instance.getSnapshot().activeId!
    instance.actions.openTerminal()
    instance.actions.openExternalTab(input)
    const secondId = instance.getSnapshot().activeId!
    expect([firstId, secondId]).toEqual(['external:["terminal:1",1]', 'external:["terminal:1",2]'])
    expect(instance.getSnapshot().tabs.map(tab => tab.id)).toEqual(['file-manager', firstId, 'terminal:1', secondId])
    instance.actions.updateExternalTab(firstId, { address: '/tasks/1' })
    expect(instance.getSnapshot().tabs.find(tab => tab.id === firstId)).toMatchObject({ revision: 1, address: '/tasks/1' })
    expect(instance.getSnapshot().tabs.find(tab => tab.id === secondId)).toMatchObject({ revision: 0, address: '/tasks' })
    instance.actions.closeExternalTab(secondId)
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
    instance.actions.closeExternalTab('terminal:1')
    expect(instance.getSnapshot().tabs.map(tab => tab.id)).toEqual(['file-manager', firstId, 'terminal:1'])
    instance.actions.activateTab(firstId)
    instance.actions.closeExternalTab(firstId)
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:1' })
    instance.actions.closeTab('terminal:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: 'file-manager' })
    instance.actions.closeExternalTab('file-manager')
    expect(instance.getSnapshot().tabs).toEqual([{ type: 'file-manager', id: 'file-manager' }])
    instance.actions.closeTab('file-manager')
    instance.actions.openExternalTab({ ...input, multiple: false })
    instance.actions.closeExternalTab(instance.getSnapshot().activeId!)
    expect(instance.getSnapshot()).toMatchObject({ view: 'menu', activeId: null, tabs: [] })
  })

  it('按标签类型切换内容，关闭活动标签时选择相邻项，关闭最后一项回到菜单', () => {
    const instance = createWorkbenchStore().create()
    const fileId = tabIdForSegments(['notes.txt'])
    instance.actions.openFile({ name: 'notes.txt', segments: ['notes.txt'] })
    instance.actions.openTerminal()
    instance.actions.openExternalTab({ definitionId: 'agent-browser', kind: 'ego-browser:watch',
      name: 'Agent 浏览器', address: 'sidebar://ego-browser%3Awatch' })
    instance.actions.openTerminal()
    expect(instance.getSnapshot().tabs.map(tab => [tab.type, tab.id])).toEqual([
      ['file', fileId], ['terminal', 'terminal:1'], ['external', 'external:["ego-browser:watch"]'], ['terminal', 'terminal:2'],
    ])
    expect(instance.getSnapshot()).toMatchObject({ view: 'terminal', activeId: 'terminal:2' })

    instance.actions.activateTab(fileId)
    expect(instance.getSnapshot()).toMatchObject({ view: 'files', activeId: fileId })
    instance.actions.activateTab('external:["ego-browser:watch"]')
    expect(instance.getSnapshot()).toMatchObject({ view: 'external', activeId: 'external:["ego-browser:watch"]' })
    instance.actions.closeTab('terminal:1')
    expect(instance.getSnapshot()).toMatchObject({ view: 'external', activeId: 'external:["ego-browser:watch"]' })
    instance.actions.closeExternalTab('external:["ego-browser:watch"]')
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

})

describe('根级保留工作台状态', () => {
  const firstId = 'first-session' as SessionId
  const secondId = 'second-session' as SessionId

  it('同 kind 的后续提供方导航不会夺取初始标签归属', () => {
    const instance = createRetainedWorkbenchStore().create()
    instance.actions.openExternalTab(firstId, {
      definitionId: 'builtin:review', kind: 'review', name: '审查', address: '/first',
    })
    instance.actions.openExternalTab(firstId, {
      definitionId: 'extension:review', kind: 'review', name: '扩展审查', address: '/second',
    })
    instance.actions.closeExternalByDefinition('extension:review')
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'external', activeId: 'external:["review"]',
      tabs: [{ definitionId: 'builtin:review', name: '扩展审查', address: '/second', revision: 1 }],
    })
    instance.actions.closeExternalByDefinition('builtin:review')
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({ view: 'menu', activeId: null, tabs: [] })
  })

  it('定义卸载关闭各 Session 的全部同源标签，并保留内置及其他定义的标签', () => {
    const instance = createRetainedWorkbenchStore().create()
    const input = { definitionId: 'plugin:tasks', kind: 'tasks', name: '任务', address: '/tasks', multiple: true }
    instance.actions.openExternalTab(firstId, input)
    instance.actions.openTerminal(firstId)
    instance.actions.openExternalTab(firstId, input)
    instance.actions.openExternalTab(firstId, { definitionId: 'plugin:other', kind: 'other', name: '其他', address: '/other' })
    instance.actions.openExternalTab(secondId, input)
    instance.actions.activateTab(firstId, 'external:["tasks",2]')
    instance.actions.closeExternalByDefinition('plugin:tasks')
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'external', activeId: 'external:["other"]',
      tabs: [{ type: 'terminal', id: 'terminal:1' }, { type: 'external', definitionId: 'plugin:other' }],
    })
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({ view: 'menu', activeId: null, tabs: [] })
    const unchanged = instance.getSnapshot()
    instance.actions.closeExternalByDefinition('plugin:missing')
    expect(instance.getSnapshot()).toBe(unchanged)
    instance.actions.closeExternalByDefinition('plugin:other')
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'terminal', activeId: 'terminal:1', tabs: [{ type: 'terminal', id: 'terminal:1' }],
    })
  })

  it('第三方标签按 Session 隔离且随会话释放，并使用同一套切换和关闭行为', () => {
    const instance = createRetainedWorkbenchStore().create()
    const input = { definitionId: 'plugin:git', kind: 'git', name: 'Git', address: '/changes' }
    instance.actions.openExternalTab(firstId, input)
    instance.actions.openExternalTab(secondId, input)
    const tabId = 'external:["git"]'
    instance.actions.updateExternalTab(firstId, tabId, { address: '/history', params: { branch: 'main' } })
    instance.actions.openFile(secondId, { name: 'note', segments: ['note'] })
    instance.actions.activateTab(secondId, tabId)
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'external', activeId: tabId, tabs: [{ address: '/history', revision: 1 }],
    })
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({
      view: 'external', activeId: tabId, tabs: [{ address: '/changes', revision: 0 }, { type: 'file' }],
    })
    instance.actions.closeExternalTab(secondId, tabId)
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({ view: 'files', activeId: tabIdForSegments(['note']) })
    instance.actions.retainSessions([secondId])
    expect(instance.getSnapshot().sessions[firstId]).toBeUndefined()
    instance.actions.openExternalTab(firstId, input)
    expect(instance.getSnapshot().sessions[firstId]?.tabs[0]).toMatchObject({ revision: 0 })
  })

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
    instance.actions.openExternalTab(secondId, { definitionId: 'agent-browser', kind: 'ego-browser:watch',
      name: 'Agent 浏览器', address: 'sidebar://ego-browser%3Awatch' })
    expect(instance.getSnapshot().sessions[firstId]).toMatchObject({
      view: 'files', filesQuery: 'first', filesExpanded: ['root'],
      filesLevels: { '[]': { phase: 'ready', listing: { path: '/first' } } },
    })
    expect(instance.getSnapshot().sessions[secondId]).toMatchObject({
      view: 'external', activeId: 'external:["ego-browser:watch"]', filesQuery: '', filesExpanded: [], filesLevels: {},
      tabs: [{ type: 'terminal', id: 'terminal:1', number: 1 }, { type: 'external', kind: 'ego-browser:watch' }],
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
