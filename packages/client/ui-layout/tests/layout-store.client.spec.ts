// @vitest-environment jsdom
/** 使用真实 store 引擎覆盖布局初值、完整 action 集合和非持久化语义。 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT,
  SIDEBAR_DEFAULT,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

const SESSION = 's-one' as SessionId
const NEXT_SESSION = 's-two' as SessionId

const initialState = {
  sidebar: SIDEBAR_DEFAULT,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  workbench: {},
}

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes closed details and workbench with reusable size preferences', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual(initialState)
  })

  it('creates independent instances', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    a.actions.openWorkbench(SESSION)
    expect(b.store.getSnapshot()).toEqual(initialState)
  })

  it('clamps every draggable preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    actions.setDetails(1)
    actions.setWorkbench(SESSION, 1)
    actions.setWorkbenchBottom(SESSION, 1)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      width: WORKBENCH_MIN,
      bottomHeight: WORKBENCH_BOTTOM_MIN,
    })
    actions.setSidebar(9999)
    actions.setDetails(9999)
    actions.setWorkbench(SESSION, 9999)
    actions.setWorkbenchBottom(SESSION, 9999)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      width: WORKBENCH_MAX,
      bottomHeight: WORKBENCH_BOTTOM_MAX,
    })
  })

  it('wide sidebar toggle closes and restores the contract default', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow sidebar toggle changes only the temporary expansion override', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, narrow: true, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, narrowExpanded: false })
  })

  it('drops the narrow override only when crossing the breakpoint state', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
  })

  it('opening workbench closes details and leaves the sidebar preference untouched', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.setNarrow(true)
    actions.toggleSidebar()
    actions.openWorkbench(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      narrow: true,
      narrowExpanded: true,
      workbench: { [SESSION]: { open: true, fullscreen: false } },
    })
  })

  it('workbench presentation toggles only while open and close preserves size and panel preferences', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleWorkbenchFullscreen(SESSION)
    expect(store.getSnapshot().workbench).toEqual({})

    actions.openWorkbench(SESSION)
    actions.setWorkbench(SESSION, 500)
    actions.setWorkbenchBottom(SESSION, 320)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ fullscreen: true, bottomOpen: true })
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: false,
      fullscreen: false,
      width: 500,
      bottomOpen: true,
      bottomHeight: 320,
      filesOpen: true,
    })
  })

  it('panel toggles open a closed workbench and otherwise flip that panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()

    // 关闭态下两个面板切换都先打开工作台、关闭详情栏，并让目标面板可见。
    actions.toggleWorkbenchFiles(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      workbench: { [SESSION]: { open: true, fullscreen: false, bottomOpen: false, filesOpen: true } },
    })
    actions.toggleWorkbenchFiles(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, filesOpen: false })

    actions.closeWorkbench(SESSION)
    actions.openDetails()
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      workbench: { [SESSION]: { open: true, fullscreen: false, bottomOpen: true, filesOpen: false } },
    })
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, bottomOpen: false })
  })

  it('toggleWorkbench covers open and close while retaining bottom preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot()).toMatchObject({ details: 0, workbench: { [SESSION]: { open: true } } })
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, fullscreen: false })
  })

  it('opening details preserves each session workbench state for later restoration', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.openWorkbench(SESSION)
    actions.openWorkbench(NEXT_SESSION)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.openDetails()
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, fullscreen: true })
    expect(store.getSnapshot().workbench[NEXT_SESSION]).toMatchObject({ open: true })
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('releases workbench state for sessions that left the live list', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.openWorkbench(NEXT_SESSION)
    actions.retainWorkbenchSessions([SESSION])
    expect(store.getSnapshot().workbench).not.toHaveProperty(NEXT_SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true })
  })

  it('does not persist layout geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openWorkbench(SESSION)
    first.actions.setWorkbench(SESSION, 500)
    first.actions.toggleWorkbenchBottom(SESSION)
    first.actions.setWorkbenchBottom(SESSION, 320)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
    expect(createLayoutStore().create().store.getSnapshot()).toEqual(initialState)
  })
})
