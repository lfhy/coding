/** IDE store：按工作区隔离的标签、草稿、目录缓存与编辑器分组语义。 */
import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceId } from 'coding-client-runtime/client'
import { createIdeStore } from '../src/client/ide-store.ts'

const A = 'workspace-a' as WorkspaceId
const B = 'workspace-b' as WorkspaceId
const SESSION_A = 'session-a' as SessionId
const SESSION_B = 'session-b' as SessionId

function setup() {
  return createIdeStore().create()
}

describe('IDE 工作区 store', () => {
  it('目录缓存保留加载中的旧快照，并切换展开状态', () => {
    const store = setup()
    const entries = [{ name: 'a.ts', type: 'file' as const, segments: ['a.ts'] }]
    store.actions.enter(A)
    store.actions.setDirectory(A, '', 'ready', entries, true)
    store.actions.setDirectory(A, '', 'loading')
    expect(store.getSnapshot().views[A]?.directories['']).toEqual({ status: 'loading', entries, truncated: true })
    store.actions.setDirectory(A, 'src', 'error')
    expect(store.getSnapshot().views[A]?.directories.src).toEqual({ status: 'error', entries: [], truncated: false })
    store.actions.toggleExpanded(A, 'src')
    store.actions.toggleExpanded(A, 'lib')
    store.actions.toggleExpanded(A, 'src')
    expect(store.getSnapshot().views[A]?.expanded).toEqual(['lib'])
  })

  it('打开与重载标签保留顺序，激活只接受已打开路径', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts'])
    expect(store.getSnapshot().views[A]?.panes[0]?.paths).toEqual(['a.ts', 'b.ts'])
    store.actions.activateTab(A, 'pane-0', 'missing')
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBe('b.ts')
    store.actions.reloadTab(A, 'c.ts', 'c.ts', ['c.ts'])
    expect(store.getSnapshot().views[A]?.documents['c.ts'])
      .toMatchObject({ path: 'c.ts', status: 'loading', content: '' })
  })

  it('读取、编辑、保存与失败动作只影响存在的活动草稿', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.updateTab(A, 'a.ts', 'ignored while loading')
    expect(store.getSnapshot().views[A]?.documents['a.ts']?.content).toBe('')
    store.actions.readyTab(A, 'a.ts', 'old', 'v1')
    store.actions.updateTab(A, 'a.ts', 'new')
    expect(store.getSnapshot().views[A]?.documents['a.ts']).toMatchObject({ content: 'new', savedContent: 'old', dirty: true })
    store.actions.failTab(A, 'a.ts', 'save', 'ready')
    store.actions.updateTab(A, 'a.ts', 'newer')
    expect(store.getSnapshot().views[A]?.documents['a.ts'])
      .toMatchObject({ content: 'newer', dirty: true, error: 'save' })
    store.actions.savedTab(A, 'a.ts', 'v2', 'new')
    expect(store.getSnapshot().views[A]?.documents['a.ts'])
      .toMatchObject({ version: 'v2', savedContent: 'new', dirty: true })
    store.actions.savedTab(A, 'a.ts', 'v3', 'newer')
    expect(store.getSnapshot().views[A]?.documents['a.ts']).toMatchObject({ version: 'v3', dirty: false, status: 'ready' })
    store.actions.failTab(A, 'a.ts', 'load')
    expect(store.getSnapshot().views[A]?.documents['a.ts']).toMatchObject({ status: 'error', error: 'load' })
    store.actions.updateTab(A, 'a.ts', 'newer')
    expect(store.getSnapshot().views[A]?.documents['a.ts']?.dirty).toBe(false)

    store.actions.readyTab(A, 'missing', 'x', 'v1')
    store.actions.updateTab(A, 'missing', 'x')
    store.actions.savedTab(A, 'missing', 'v2', 'x')
    store.actions.failTab(A, 'missing', 'load')
    expect(store.getSnapshot().views[A]?.panes[0]?.paths).toEqual(['a.ts'])
  })

  it('关闭标签选中相邻项，关闭最后一个掉回空分组', () => {
    const store = setup()
    store.actions.enter(A)
    for (const path of ['a.ts', 'b.ts', 'c.ts']) store.actions.openTab(A, path, path, [path])
    store.actions.closeTab(A, 'b.ts')
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBe('c.ts')
    expect(store.getSnapshot().views[A]?.documents['b.ts']).toBeUndefined()
    store.actions.closeTab(A, 'a.ts')
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBe('c.ts')
    store.actions.closeTab(A, 'c.ts')
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBeNull()
    store.actions.closeTab(A, 'missing')
    expect(store.getSnapshot().views[A]?.panes[0]?.paths).toEqual([])
  })

  it('切换工作区各自保留标签、目录与会话，回到欢迎页不影响记录', () => {
    const store = setup()
    store.actions.bindSession(A, SESSION_A)
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.readyTab(A, 'a.ts', 'aaa', 'v1')
    store.actions.setDirectory(A, '', 'ready', [{ name: 'a.ts', type: 'file', segments: ['a.ts'] }])

    store.actions.enter(B)
    store.actions.bindSession(B, SESSION_B)
    store.actions.openTab(B, 'b.md', 'b.md', ['b.md'])
    expect(store.getSnapshot().views[A]?.panes[0]?.paths).toEqual(['a.ts'])
    expect(store.getSnapshot().views[B]?.panes[0]?.paths).toEqual(['b.md'])

    store.actions.enter(null)
    expect(store.getSnapshot().workspaceId).toBeNull()
    store.actions.enter(A)
    expect(store.getSnapshot().views[A]?.documents['a.ts']?.content).toBe('aaa')
    expect(store.getSnapshot().sessions[A]).toBe(SESSION_A)
    expect(store.getSnapshot().sessions[B]).toBe(SESSION_B)
  })

  it('拖动分屏拆出新分组，移动与关闭分组都保持标签不丢', () => {
    const store = setup()
    store.actions.enter(A)
    for (const path of ['a.ts', 'b.ts', 'c.ts']) store.actions.openTab(A, path, path, [path])

    store.actions.splitTab(A, 'b.ts', 'pane-0', 'right')
    const split = store.getSnapshot().views[A]
    expect(split?.panes.map(pane => pane.paths)).toEqual([['a.ts', 'c.ts'], ['b.ts']])
    expect(split?.panes[0]?.activePath).toBe('c.ts')
    expect(split?.activePaneId).toBe(split?.panes[1]?.id)

    store.actions.splitTab(A, 'c.ts', 'pane-0', 'left')
    expect(store.getSnapshot().views[A]?.panes.map(pane => pane.paths)).toEqual([['c.ts'], ['a.ts'], ['b.ts']])

    const second = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.moveTab(A, 'c.ts', second)
    const merged = store.getSnapshot().views[A]
    expect(merged?.panes.map(pane => pane.paths)).toEqual([['a.ts', 'c.ts'], ['b.ts']])
    expect(merged?.panes[0]?.activePath).toBe('c.ts')
  })

  it('拖动已关闭的文件不让空分组残留，关闭分组会保留来源分组的相邻选中', () => {
    const store = setup()
    store.actions.enter(A)
    for (const path of ['a.ts', 'b.ts']) store.actions.openTab(A, path, path, [path])
    // 只摘掉分组里唯一标签的路径时，空分组会被清理。
    store.actions.moveTab(A, 'missing.ts', 'pane-0')
    store.actions.closePane(A, 'pane-0')
    store.actions.focusPane(A, 'missing')
    expect(store.getSnapshot().views[A]?.panes).toHaveLength(1)

    store.actions.splitTab(A, 'a.ts', 'pane-0', 'right', 'copy')
    const second = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.moveTab(A, 'b.ts', second)
    // 搬走来源分组当前活动文件后，选中仍落在该分组里的标签上。
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBe('a.ts')
    store.actions.moveTab(A, 'missing.ts', second)
    store.actions.splitTab(A, 'missing.ts', 'pane-0', 'right')
    expect(store.getSnapshot().views[A]?.panes.length).toBeLessThanOrEqual(3)
  })

  it('收起非当前分组时保留原焦点', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.splitTab(A, 'a.ts', 'pane-0', 'right', 'move')
    store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts'])
    const [first, second] = store.getSnapshot().views[A]?.panes ?? []
    store.actions.focusPane(A, first?.id as string)
    // 关闭另一个分组：剩下的第一个分组就是原焦点分组。
    store.actions.closePane(A, second?.id as string)
    expect(store.getSnapshot().views[A]?.activePaneId).toBe(first?.id)
    expect(store.getSnapshot().views[A]?.panes).toHaveLength(1)
  })

  it('收起的正是当前分组时把焦点交给剩下的第一个分组', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.splitTab(A, 'a.ts', 'pane-0', 'right', 'copy')
    const second = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.focusPane(A, second)
    // 关闭承载活动标签的分组，剩下的分组字段跟着切换。
    store.actions.closeTab(A, 'a.ts')
    expect(store.getSnapshot().views[A]?.panes).toHaveLength(1)
    expect(store.getSnapshot().views[A]?.activePaneId).toBe(store.getSnapshot().views[A]?.panes[0]?.id)
  })

  it('活动分组缺失时回落到第一个分组，空分组列表是编程错误', () => {
    const store = setup()
    store.actions.enter(A)
    // store 的引擎面是框架/测试 API：这里刻意写入非法状态验证防御分支。
    store.store.update((draft) => { draft.views[A]!.activePaneId = 'missing' })
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    expect(store.getSnapshot().views[A]?.activePaneId).toBe('pane-0')
    store.store.update((draft) => { draft.views[A]!.panes = [] })
    expect(() => { store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts']) })
      .toThrow('ide store: pane list must not be empty')
  })

  it('唯一标签拖拽不分屏，拆分按钮改为两侧同时显示', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'])
    store.actions.splitTab(A, 'a.ts', 'pane-0', 'right')
    expect(store.getSnapshot().views[A]?.panes).toHaveLength(1)

    store.actions.splitTab(A, 'a.ts', 'pane-0', 'right', 'copy')
    expect(store.getSnapshot().views[A]?.panes.map(pane => pane.paths)).toEqual([['a.ts'], ['a.ts']])

    store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts'])
    expect(store.getSnapshot().views[A]?.panes.map(pane => pane.paths)).toEqual([['a.ts'], ['a.ts', 'b.ts']])
    const right = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.closePane(A, right)
    // 同一个文件只在相邻分组里出现一次：合并时按路径去重。
    expect(store.getSnapshot().views[A]?.panes.map(pane => pane.paths)).toEqual([['a.ts', 'b.ts']])
    expect(store.getSnapshot().views[A]?.panes[0]?.activePath).toBe('b.ts')
    store.actions.closePane(A, 'pane-0')
    expect(store.getSnapshot().views[A]?.panes).toHaveLength(1)

    store.actions.focusPane(A, 'pane-0')
    store.actions.focusPane(A, 'missing')
    store.actions.moveTab(A, 'a.ts', 'missing')
    store.actions.closePane(A, 'missing')
    expect(store.getSnapshot().views[A]?.activePaneId).toBe('pane-0')
  })

  it('预览标签逐个替换，固定标签与草稿不会被替换', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.panes[0]).toMatchObject({ paths: ['a.ts'], previewPath: 'a.ts' })
    store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.documents['a.ts']).toBeUndefined()
    expect(store.getSnapshot().views[A]?.panes[0]).toMatchObject({ paths: ['b.ts'], previewPath: 'b.ts' })

    store.actions.openTab(A, 'fixed.ts', 'fixed.ts', ['fixed.ts'])
    store.actions.openTab(A, 'b.ts', 'b.ts', ['b.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.panes[0]).toMatchObject({
      paths: ['b.ts', 'fixed.ts'], activePath: 'b.ts', previewPath: 'b.ts',
    })
    store.actions.pinTab(A, 'pane-0', 'b.ts')
    store.actions.pinTab(A, 'missing', 'b.ts')
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBeNull()

    store.actions.openTab(A, 'next.ts', 'next.ts', ['next.ts'], 'preview')
    store.actions.readyTab(A, 'next.ts', 'old', 'v1')
    store.actions.updateTab(A, 'next.ts', 'draft')
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBeNull()
    store.actions.openTab(A, 'last.ts', 'last.ts', ['last.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.panes[0]?.paths).toEqual(['b.ts', 'fixed.ts', 'next.ts', 'last.ts'])
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBe('last.ts')
    store.actions.closeTab(A, 'last.ts')
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBeNull()
  })

  it('预览状态随拆分与移动保留，并在目标分组替换旧预览', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'fixed.ts', 'fixed.ts', ['fixed.ts'])
    store.actions.openTab(A, 'preview.ts', 'preview.ts', ['preview.ts'], 'preview')
    store.actions.splitTab(A, 'preview.ts', 'pane-0', 'right')
    const split = store.getSnapshot().views[A]
    expect(split?.panes.map(pane => pane.previewPath)).toEqual([null, 'preview.ts'])
    const right = split?.panes[1]?.id as string

    store.actions.focusPane(A, 'pane-0')
    store.actions.openTab(A, 'other.ts', 'other.ts', ['other.ts'], 'preview')
    store.actions.moveTab(A, 'preview.ts', 'pane-0')
    expect(store.getSnapshot().views[A]?.panes[0]).toMatchObject({
      paths: ['fixed.ts', 'preview.ts'], activePath: 'preview.ts', previewPath: 'preview.ts',
    })
    expect(store.getSnapshot().views[A]?.documents['other.ts']).toBeUndefined()
    expect(store.getSnapshot().views[A]?.panes.some(pane => pane.id === right)).toBe(false)

    store.actions.openTab(A, 'preview.ts', 'preview.ts', ['preview.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBe('preview.ts')
  })

  it('固定动作可把当前预览转为固定，复制预览被替换时保留共享正文', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'], 'preview')
    store.actions.openTab(A, 'a.ts', 'a.ts', ['a.ts'], 'pinned')
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBeNull()

    store.actions.openTab(A, 'preview.ts', 'preview.ts', ['preview.ts'], 'preview')
    store.actions.splitTab(A, 'preview.ts', 'pane-0', 'right', 'copy')
    store.actions.focusPane(A, 'pane-0')
    store.actions.openTab(A, 'next.ts', 'next.ts', ['next.ts'], 'preview')
    expect(store.getSnapshot().views[A]?.documents['preview.ts']).toBeDefined()
    expect(store.getSnapshot().views[A]?.panes.map(pane => pane.paths)).toEqual([
      ['a.ts', 'next.ts'], ['preview.ts'],
    ])
  })

  it('关闭分组时保留目标已有预览，否则接管来源预览', () => {
    const store = setup()
    store.actions.enter(A)
    store.actions.openTab(A, 'fixed.ts', 'fixed.ts', ['fixed.ts'])
    store.actions.openTab(A, 'preview.ts', 'preview.ts', ['preview.ts'], 'preview')
    store.actions.splitTab(A, 'preview.ts', 'pane-0', 'right', 'copy')
    store.actions.focusPane(A, 'pane-0')
    store.actions.openTab(A, 'left-preview.ts', 'left-preview.ts', ['left-preview.ts'], 'preview')
    const right = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.closePane(A, right)
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBe('left-preview.ts')

    store.actions.openTab(A, 'right-preview.ts', 'right-preview.ts', ['right-preview.ts'], 'preview')
    store.actions.splitTab(A, 'right-preview.ts', 'pane-0', 'right')
    const moved = store.getSnapshot().views[A]?.panes[1]?.id as string
    store.actions.focusPane(A, 'pane-0')
    store.actions.pinTab(A, 'pane-0', 'left-preview.ts')
    store.actions.closePane(A, moved)
    expect(store.getSnapshot().views[A]?.panes[0]?.previewPath).toBe('right-preview.ts')
  })
})
