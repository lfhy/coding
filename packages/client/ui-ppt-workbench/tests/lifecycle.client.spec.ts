import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, SlotRegistry, type SessionListState } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import type { SessionId } from 'coding-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyWorkbench, inject as workbenchInject } from '../../ui-open-in-app/src/client/index.ts'
import { createRetainedWorkbenchStore } from '../../ui-open-in-app/src/client/store.ts'
import type { WorkspaceWorkbenchInjected } from '../../ui-open-in-app/src/client/WorkspaceWorkbench.tsx'
import { apply, inject, TAB_ID } from '../src/client/index.ts'

const PPT = 'ppt-session' as SessionId
const OTHER = 'other-session' as SessionId
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.useRealTimers()
})

/** 与工作台所有者一起挂载真实 slot 和标签 store，复现会话摘要的启动顺序。 */
async function bench() {
  ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    workbench: { kind: 'single', scope: 'root' },
    'workbench.bottom': { kind: 'single', scope: 'root' },
    'conversation.hero.actions': { kind: 'list', scope: 'root' },
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const openWorkbench = vi.fn()
  ctx.provide('layout', {
    openWorkbench, closeWorkbench: vi.fn(), toggleWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(), toggleWorkbenchBottom: vi.fn(),
    closeWorkbenchBottom: vi.fn(), toggleHeroPanel: vi.fn(),
  } as never)
  const list = createSnapshotStore<SessionListState>({
    ids: [PPT, OTHER], current: PPT, phase: 'ready', currentAddress: undefined,
    subagentsByParent: {}, jobsBySession: {},
    byId: {
      [PPT]: { id: PPT, agentPreset: 'ppt', blank: true },
      [OTHER]: { id: OTHER, agentPreset: 'standard', blank: false },
    },
  } as SessionListState)
  ctx.provide('sessions', { list } as never)
  ctx.provide('workspaces', { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } } as never)
  ctx.provide('connection', { api: { workspace: { gitHistory: vi.fn() } } } as never)
  const owner = ctx.plugin({ inject: [...workbenchInject], apply: applyWorkbench })
  await owner.await()
  const entry = ctx.slots.entries('workbench')[0]
  const store = (entry?.store as ReturnType<typeof createRetainedWorkbenchStore>).create()
  ;(entry?.inject as unknown as (actions: typeof store.actions) => WorkspaceWorkbenchInjected)(store.actions)
  const panel = ctx.plugin({ inject: [...inject], apply })
  await panel.await()
  return { ctx, list, store, openWorkbench, panel }
}

function pptTabs(store: ReturnType<ReturnType<typeof createRetainedWorkbenchStore>['create']>, id: SessionId) {
  return store.getSnapshot().sessions[id]?.tabs.filter(tab => tab.type === 'external' && tab.kind === 'ppt') ?? []
}

describe('PPT 模式的会话级工作台接线', () => {
  it('空白会话不显示，首次对话被接纳后只打开该会话一次', async () => {
    const b = await bench()
    expect(b.ctx.sidebarRightTabs.get('ppt')?.id).toBe(TAB_ID)
    expect(b.ctx.sidebarRightTabs.get('ppt')?.guide).toBeUndefined()
    expect(b.ctx.sidebarRightTabs.guide().some(entry => entry.kind === 'ppt')).toBe(false)
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
    expect(b.openWorkbench).not.toHaveBeenCalled()

    b.list.update((draft) => { draft.byId[PPT]!.blank = false })
    expect(pptTabs(b.store, PPT)).toHaveLength(1)
    expect(pptTabs(b.store, OTHER)).toHaveLength(0)
    expect(b.openWorkbench).toHaveBeenCalledOnce()
    b.list.update((draft) => { draft.byId[PPT]!.running = true })
    expect(pptTabs(b.store, PPT)).toHaveLength(1)
    expect(b.openWorkbench).toHaveBeenCalledOnce()
    await b.panel.dispose()
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
  })

  it('加载后已有对话只为当前 PPT 会话开标签', async () => {
    const b = await bench()
    b.list.update((draft) => {
      draft.byId[PPT]!.blank = false
      draft.current = OTHER
    })
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
    b.list.update((draft) => { draft.current = PPT })
    expect(pptTabs(b.store, PPT)).toHaveLength(1)
    expect(pptTabs(b.store, OTHER)).toHaveLength(0)
  })

  it('其他模式不打开，切换会话不会复制 PPT 标签，关闭后不复活', async () => {
    const b = await bench()
    b.list.update((draft) => { draft.current = OTHER })
    expect(pptTabs(b.store, OTHER)).toHaveLength(0)
    b.list.update((draft) => { draft.byId[PPT]!.blank = false })
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
    b.list.update((draft) => { draft.current = PPT })
    const tab = pptTabs(b.store, PPT)[0]
    expect(tab).toBeDefined()
    b.store.actions.closeExternalTab(PPT, tab!.id)
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
    b.list.update((draft) => { draft.current = OTHER })
    b.list.update((draft) => { draft.current = PPT })
    expect(pptTabs(b.store, PPT)).toHaveLength(0)
    expect(pptTabs(b.store, OTHER)).toHaveLength(0)
  })
})
