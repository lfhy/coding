// @vitest-environment jsdom
/** 使用真实 store 引擎覆盖布局初值、完整 action 集合和非持久化语义。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKBENCH_BOTTOM_DEFAULT,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_DEFAULT,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

const initialState = {
  sidebar: SIDEBAR_DEFAULT,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  workbenchOpen: false,
  workbenchFullscreen: false,
  workbenchWidth: WORKBENCH_DEFAULT,
  workbenchBottomOpen: false,
  workbenchBottomHeight: WORKBENCH_BOTTOM_DEFAULT,
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
    a.actions.openWorkbench()
    expect(b.store.getSnapshot()).toEqual(initialState)
  })

  it('clamps every draggable preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    actions.setDetails(1)
    actions.setWorkbench(1)
    actions.setWorkbenchBottom(1)
    expect(store.getSnapshot()).toMatchObject({
      sidebar: SIDEBAR_MIN,
      details: DETAILS_MIN,
      workbenchWidth: WORKBENCH_MIN,
      workbenchBottomHeight: WORKBENCH_BOTTOM_MIN,
    })
    actions.setSidebar(9999)
    actions.setDetails(9999)
    actions.setWorkbench(9999)
    actions.setWorkbenchBottom(9999)
    expect(store.getSnapshot()).toMatchObject({
      sidebar: SIDEBAR_MAX,
      details: DETAILS_MAX,
      workbenchWidth: WORKBENCH_MAX,
      workbenchBottomHeight: WORKBENCH_BOTTOM_MAX,
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

  it('opening workbench closes details and collapses a narrow manual sidebar expansion', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.setNarrow(true)
    actions.toggleSidebar()
    actions.openWorkbench()
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      narrowExpanded: false,
      workbenchOpen: true,
      workbenchFullscreen: false,
    })
  })

  it('workbench presentation toggles only while open and close preserves size and bottom preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleWorkbenchFullscreen()
    actions.toggleWorkbenchBottom()
    expect(store.getSnapshot()).toMatchObject({ workbenchFullscreen: false, workbenchBottomOpen: false })

    actions.openWorkbench()
    actions.setWorkbench(500)
    actions.setWorkbenchBottom(320)
    actions.toggleWorkbenchFullscreen()
    actions.toggleWorkbenchBottom()
    expect(store.getSnapshot()).toMatchObject({ workbenchFullscreen: true, workbenchBottomOpen: true })
    actions.closeWorkbench()
    expect(store.getSnapshot()).toMatchObject({
      workbenchOpen: false,
      workbenchFullscreen: false,
      workbenchWidth: 500,
      workbenchBottomOpen: true,
      workbenchBottomHeight: 320,
    })
  })

  it('toggleWorkbench covers open and close while retaining bottom preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.toggleWorkbench()
    expect(store.getSnapshot()).toMatchObject({ details: 0, workbenchOpen: true })
    actions.toggleWorkbenchFullscreen()
    actions.toggleWorkbench()
    expect(store.getSnapshot()).toMatchObject({ workbenchOpen: false, workbenchFullscreen: false })
  })

  it('opening details exits workbench and keeps the existing details open semantics', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.openWorkbench()
    actions.toggleWorkbenchFullscreen()
    actions.openDetails()
    expect(store.getSnapshot()).toMatchObject({
      details: DETAILS_DEFAULT,
      workbenchOpen: false,
      workbenchFullscreen: false,
    })
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('does not persist layout geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openWorkbench()
    first.actions.setWorkbench(500)
    first.actions.toggleWorkbenchBottom()
    first.actions.setWorkbenchBottom(320)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
    expect(createLayoutStore().create().store.getSnapshot()).toEqual(initialState)
  })
})
