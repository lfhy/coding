/** 真实 Cordis/slot 接线下的外部标签会话隔离与贡献者释放。 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createRetainedWorkbenchStore, WorkbenchExternalTab } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import type { SidebarRightTabDefinition } from '../src/client/sidebar-tab-registry.ts'
import type { SidebarRightTabOwnerProps, SidebarRightTabSlotInject } from '../src/client/sidebar-tab-contract.ts'
import type { WorkspaceWorkbenchInjected } from '../src/client/WorkspaceWorkbench.tsx'

const FIRST = 'first-session' as SessionId
const SECOND = 'second-session' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const disposeRoot = ctx.slots.register({
    name: 'root',
    children: {
      'workbench': { kind: 'single', scope: 'root' },
      'workbench.bottom': { kind: 'single', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.hero.actions': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const openWorkbench = vi.fn()
  ctx.provide('layout', {
    openWorkbench, closeWorkbench: vi.fn(), toggleWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(), toggleWorkbenchBottom: vi.fn(),
    closeWorkbenchBottom: vi.fn(), toggleHeroPanel: vi.fn(),
  } as never)
  let current: SessionId | undefined = FIRST
  ctx.provide('sessions', { list: { getSnapshot: () => ({
    current, byId: { [FIRST]: {}, [SECOND]: {} },
  }) } } as never)
  ctx.provide('workspaces', { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('workbench')[0]
  const store = (entry?.store as ReturnType<typeof createRetainedWorkbenchStore>).create()
  const face = (entry?.inject as unknown as (actions: typeof store.actions) => WorkspaceWorkbenchInjected)(store.actions)
  return { ctx, fiber, store, openWorkbench, entry, face, disposeRoot,
    setCurrent: (sessionId: SessionId | undefined) => { current = sessionId },
  }
}

const definition: SidebarRightTabDefinition = {
  id: 'ext.notes', kind: 'notes', patterns: ['*.md'], title: address => `Notes ${address}`,
  guide: [{ id: 'notes', order: 10, title: () => 'Notes' }],
}

function externalTabs(store: ReturnType<ReturnType<typeof createRetainedWorkbenchStore>['create']>, sessionId: SessionId) {
  return store.getSnapshot().sessions[sessionId]?.tabs.filter((tab): tab is WorkbenchExternalTab => tab.type === 'external') ?? []
}

describe('右侧工作台插件服务', () => {
  it('以 keyed 内容/标题 slot、稳定注册表源和同一位置的 useTabInfo 装配', async () => {
    const { ctx, fiber, entry, face } = await bench()
    const content = ctx.slots.snapshot('sidebar.right.pane.tab')
    const title = ctx.slots.snapshot('sidebar.right.pane.tab.title')
    expect(content).toMatchObject([{ name: 'sidebar.right.pane.tab', kind: 'keyed', scope: 'session' }])
    expect(title).toMatchObject([{ name: 'sidebar.right.pane.tab.title', kind: 'keyed', scope: 'session' }])
    const source = face.hooks.sidebarRightTabs
    const initial = source.getSnapshot()
    const notify = vi.fn()
    const unsubscribe = source.subscribe(notify)
    const stop = ctx.sidebarRightTabs.register(definition)
    expect(source.getSnapshot()).not.toBe(initial)
    expect(source.getSnapshot()).toBe(source.getSnapshot())
    expect(source.getSnapshot()).toEqual([definition])
    expect(notify).toHaveBeenCalledOnce()

    const owner: SidebarRightTabOwnerProps = {
      tab: { type: 'external', id: 'external', definitionId: definition.id, kind: definition.kind,
        name: 'Notes', address: 'sidebar://note', revision: 0 },
      shown: true, tabDomId: 'tab', panelDomId: 'panel', selectTab: vi.fn(), closeTab: vi.fn(),
    }
    const contentInject = entry?.children?.['sidebar.right.pane.tab']?.inject as SidebarRightTabSlotInject
    const titleInject = entry?.children?.['sidebar.right.pane.tab.title']?.inject as SidebarRightTabSlotInject
    // 槽声明保存的函数被 renderer 绑定为 useTabInfo，返回此次分派的 owner。
    expect(contentInject.hooks.tabInfo({}, owner)()).toBe(owner)
    expect(titleInject.hooks.tabInfo({}, owner)()).toBe(owner)
    stop()
    expect(source.getSnapshot()).toEqual([])
    expect(notify).toHaveBeenCalledTimes(2)
    unsubscribe()
    await fiber.dispose()
    expect(ctx.slots.snapshot('sidebar.right.pane.tab')).toEqual([])
    expect(ctx.slots.snapshot('sidebar.right.pane.tab.title')).toEqual([])
    expect(ctx.get('sidebarRightTabs')).toBeUndefined()
    expect(ctx.get('sidebarRight')).toBeUndefined()
  })

  it('同种类单实例按 Session 隔离，打开、切换、更新和关闭由 workbench store 处理', async () => {
    const { ctx, fiber, store, openWorkbench } = await bench()
    ctx.sidebarRightTabs.register(definition)
    ctx.sidebarRight.openResourceForSession(FIRST, 'dsh-resource://file/a.md')
    ctx.sidebarRight.openResourceForSession(SECOND, 'dsh-resource://file/b.md')
    ctx.sidebarRight.openResourceForSession(FIRST, 'dsh-resource://file/c.md', { kind: 'notes', params: { line: 4 } })
    expect(externalTabs(store, FIRST)).toMatchObject([{
      definitionId: definition.id, name: 'Notes dsh-resource://file/c.md', params: { line: 4 }, revision: 1,
    }])
    expect(externalTabs(store, SECOND)).toMatchObject([{ address: 'dsh-resource://file/b.md' }])
    const tabId = externalTabs(store, FIRST)[0]?.id ?? ''
    store.actions.setView(FIRST, 'menu')
    ctx.sidebarRight.focusTab(FIRST, tabId)
    expect(store.getSnapshot().sessions[FIRST]?.activeId).toBe(tabId)
    ctx.sidebarRight.updateTab(FIRST, tabId, { address: 'sidebar://editor', name: 'Editor' })
    expect(externalTabs(store, FIRST)[0]).toMatchObject({ name: 'Editor', address: 'sidebar://editor', revision: 2 })
    ctx.sidebarRight.closeTab(FIRST, tabId)
    expect(store.getSnapshot().sessions[FIRST]).toMatchObject({ view: 'menu', tabs: [] })
    expect(externalTabs(store, SECOND)).toHaveLength(1)
    ctx.sidebarRight.openTab('notes')
    expect(externalTabs(store, FIRST)[0]?.address).toBe('sidebar://notes')
    ctx.sidebarRight.openTabForSession(SECOND, 'notes', { params: { line: 8 } })
    expect(externalTabs(store, SECOND)[0]?.params).toEqual({ line: 8 })
    expect(openWorkbench).toHaveBeenCalledTimes(6)
    await fiber.dispose()
  })

  it('贡献者 fiber 卸载撤销定义并清理各 Session 实例', async () => {
    const { ctx, fiber, store } = await bench()
    const plugin = ctx.plugin({ inject: ['sidebarRightTabs'], apply(child: Context) {
      child.effect(() => child.sidebarRightTabs.register(definition), 'test: external tab')
    } })
    await plugin.await()
    ctx.sidebarRight.openResourceForSession(FIRST, 'dsh-resource://file/a.md')
    await plugin.dispose()
    expect(ctx.sidebarRightTabs.entries()).toEqual([])
    expect(externalTabs(store, FIRST)).toHaveLength(0)
    expect(() => { ctx.sidebarRight.openResourceForSession(FIRST, 'dsh-resource://file/b.md') })
      .toThrow('no registered tab type')
    await fiber.dispose()
  })

  it('extension 临时接管不会清除仍注册的 builtin 标签，撤销后只清 extension 实例', async () => {
    const { ctx, fiber, store } = await bench()
    const builtin: SidebarRightTabDefinition = {
      id: 'builtin.notes', kind: 'notes', priority: 'builtin',
      title: () => 'Built in', patterns: ['*.md'],
    }
    const stopBuiltin = ctx.sidebarRightTabs.register(builtin)
    ctx.sidebarRight.openTab('notes')
    const stopExtension = ctx.sidebarRightTabs.register({ ...definition, multiple: true })
    expect(externalTabs(store, FIRST)).toMatchObject([{ definitionId: 'builtin.notes' }])
    ctx.sidebarRight.openTab('notes')
    expect(externalTabs(store, FIRST)).toHaveLength(2)
    stopExtension()
    expect(externalTabs(store, FIRST)).toMatchObject([{ definitionId: 'builtin.notes' }])
    expect(ctx.sidebarRightTabs.get('notes')).toBe(builtin)
    stopBuiltin()
    expect(externalTabs(store, FIRST)).toHaveLength(0)
    await fiber.dispose()
  })

  it('shadowed builtin 真正注销时清除旧标签，但保留 extension 实例', async () => {
    const { ctx, fiber, store } = await bench()
    const stopBuiltin = ctx.sidebarRightTabs.register({
      id: 'builtin.notes', kind: 'notes', priority: 'builtin', title: () => 'Built in',
    })
    ctx.sidebarRight.openTab('notes')
    const stopExtension = ctx.sidebarRightTabs.register({ ...definition, multiple: true })
    ctx.sidebarRight.openTab('notes')
    expect(externalTabs(store, FIRST).map(tab => tab.definitionId)).toEqual(['builtin.notes', 'ext.notes'])
    stopBuiltin()
    expect(externalTabs(store, FIRST).map(tab => tab.definitionId)).toEqual(['ext.notes'])
    stopExtension()
    await fiber.dispose()
  })

  it('工作台 slot 卸载后拒绝使用旧 store actions', async () => {
    const { ctx, fiber, disposeRoot } = await bench()
    ctx.sidebarRightTabs.register(definition)
    disposeRoot()
    expect(() => { ctx.sidebarRight.openTab('notes') }).toThrow('workbench actions are not wired')
    await fiber.dispose()
  })

  it('openTab 读取实时选中 Session，没有选中会话时明确拒绝', async () => {
    const { ctx, fiber, store, setCurrent } = await bench()
    ctx.sidebarRightTabs.register(definition)
    setCurrent(SECOND)
    ctx.sidebarRight.openTab('notes')
    expect(externalTabs(store, SECOND)).toHaveLength(1)
    expect(externalTabs(store, FIRST)).toHaveLength(0)
    setCurrent(undefined)
    expect(() => { ctx.sidebarRight.openTab('notes') }).toThrow('no current session')
    await fiber.dispose()
  })
})
