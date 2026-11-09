// @vitest-environment jsdom
/** 使用真实 store 引擎覆盖布局初值、完整 action 集合和非持久化语义。 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from 'coding-session/types'
import { createLayoutStore } from 'coding-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT,
  SIDEBAR_DEFAULT,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
} from 'coding-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

const SESSION = 's-one' as SessionId
const NEXT_SESSION = 's-two' as SessionId

const initialState = {
  sidebar: SIDEBAR_DEFAULT,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  workbench: {},
  blankWorkbench: {},
  suppressedWorkbench: {},
  pendingNewConversation: false,
  activeBlankSession: null,
  page: null,
  conversationRequest: null,
  conversationRequestSeq: 0,
}

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('keeps a blank Hero override separate until the user explicitly toggles the right panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench('shared')
    actions.toggleWorkbenchFullscreen('shared')
    const previous = store.getSnapshot().workbench.shared
    expect(store.getSnapshot().blankWorkbench).toEqual({})
    actions.toggleHeroPanel('shared', 'files', SESSION)
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBe(true)
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBeUndefined()
    expect(previous).toMatchObject({ open: true, fullscreen: true })
    actions.toggleHeroPanel('shared', 'files', SESSION)
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBe(false)
    actions.beginNewConversation()
    expect(store.getSnapshot().blankWorkbench).toEqual({})
  })

  it('updates the shared workspace but not another active blank override for targeted opens', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setActiveBlankSession(NEXT_SESSION, 'shared')
    actions.openWorkbench('shared', SESSION)
    expect(store.getSnapshot().workbench.shared?.open).toBe(true)
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBeUndefined()
    actions.openWorkbench('shared', NEXT_SESSION)
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBe(true)
    actions.toggleWorkbenchFullscreen('shared')
    actions.openWorkbench('shared', SESSION)
    expect(store.getSnapshot().workbench.shared?.fullscreen).toBe(true)
    actions.openWorkbench('shared', NEXT_SESSION)
    expect(store.getSnapshot().workbench.shared?.fullscreen).toBe(false)
    actions.closeWorkbench('shared')
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBe(false)
    actions.openWorkbench('shared')
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBe(true)
  })

  it('isolates the next selected session without overriding an explicit early open', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench('shared', SESSION)
    actions.beginNewConversation()
    actions.selectConversation(NEXT_SESSION)
    expect(store.getSnapshot().suppressedWorkbench[NEXT_SESSION]).toBe(true)
    expect(store.getSnapshot().pendingNewConversation).toBe(false)
    actions.beginNewConversation()
    actions.openWorkbench('shared', NEXT_SESSION)
    actions.selectConversation(NEXT_SESSION)
    expect(store.getSnapshot().suppressedWorkbench[NEXT_SESSION]).toBe(false)
    expect(store.getSnapshot().suppressedWorkbench[SESSION]).toBe(false)
  })

  it('does not let an old session toggle change the current blank override', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setActiveBlankSession(NEXT_SESSION, 'shared')
    actions.toggleWorkbench('shared', SESSION)
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBeUndefined()
    actions.toggleWorkbench('shared', SESSION)
    expect(store.getSnapshot().blankWorkbench[NEXT_SESSION]).toBeUndefined()
  })

  it('preserves an independent terminal when starting a blank conversation and reopening its Hero', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench('shared')
    actions.toggleWorkbenchBottom('shared')
    const priorBottom = store.getSnapshot().workbench.shared?.bottomOpen
    actions.beginNewConversation()
    expect(store.getSnapshot().workbench.shared?.bottomOpen).toBe(priorBottom)
    actions.toggleHeroPanel('shared', 'files', SESSION)
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBe(true)
    actions.toggleHeroPanel('shared', 'bottom', SESSION)
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBe(false)
    actions.requestShowConversation(SESSION)
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBe(false)
    actions.retainBlankSessions([NEXT_SESSION])
    expect(store.getSnapshot().blankWorkbench[SESSION]).toBeUndefined()
  })
  it('keeps only the newest conversation request and does not acknowledge its successor', () => {
    const { store, actions } = createLayoutStore().create()
    actions.requestShowConversation(SESSION)
    const first = store.getSnapshot().conversationRequest
    actions.requestShowConversation(NEXT_SESSION)
    const second = store.getSnapshot().conversationRequest
    expect(second).toEqual({ sessionId: NEXT_SESSION, seq: 2 })
    actions.acknowledgeConversationRequest(first!.seq)
    expect(store.getSnapshot().conversationRequest).toBe(second)
    actions.acknowledgeConversationRequest(second!.seq)
    expect(store.getSnapshot().conversationRequest).toBeNull()
    actions.requestShowConversation(SESSION)
    expect(store.getSnapshot().conversationRequest?.seq).toBe(3)
    actions.clearConversationRequest()
    expect(store.getSnapshot().conversationRequest).toBeNull()
  })
  it('keeps an independent page transient and returns without changing panel preferences', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.openPage('image-gallery', SESSION)
    expect(store.getSnapshot()).toMatchObject({ page: { kind: 'image-gallery', sessionId: SESSION },
      workbench: { [SESSION]: { open: true } } })
    actions.closePage()
    expect(store.getSnapshot()).toMatchObject({ page: null, workbench: { [SESSION]: { open: true } } })
  })

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

  it('workbench presentation toggles only while open and close preserves the visible bottom and size preferences', () => {
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
      bottomStandalone: true,
      bottomHeight: 320,
    })
  })

  it('bottom toggle preserves the right workbench and opens only the bottom row when the right side is closed', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()

    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      workbench: { [SESSION]: { open: false, fullscreen: false, bottomOpen: true, bottomStandalone: true } },
    })
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: false, bottomStandalone: false })

    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: false, bottomOpen: true, bottomStandalone: true,
    })
    actions.openWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, bottomOpen: true, bottomStandalone: false })
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, bottomOpen: false })
  })

  it('hides the bottom panel idempotently without changing the right workbench or details', () => {
    const { store, actions } = createLayoutStore().create()
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toBeUndefined()

    actions.openWorkbench(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: true, bottomOpen: false, bottomStandalone: false,
    })
    actions.openDetails()
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().details).not.toBe(0)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: true, bottomOpen: false, bottomStandalone: false,
    })

    actions.closeWorkbench(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: false, bottomOpen: false, bottomStandalone: false,
    })
  })

  it('Hero buttons alternate exclusive panel visibility without changing the navigation', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'bottom')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: true, bottomStandalone: true })
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: true, bottomOpen: false, bottomStandalone: false,
    })
    actions.toggleHeroPanel(SESSION, 'bottom')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: true, bottomStandalone: true })
    actions.toggleHeroPanel(SESSION, 'bottom')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: false, bottomStandalone: false })
    actions.toggleHeroPanel(SESSION, 'files')
    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: false })
  })

  it('toggles the entire right workbench from Hero', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true })

    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false })
    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true })
  })

  it('closing the right workbench retains the bottom row when it was visible', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: true, bottomStandalone: true })
    actions.openWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: true, bottomOpen: true, bottomStandalone: false })
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: true, bottomStandalone: true })
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: false, bottomStandalone: false })
  })

  it('closing a right-only workbench leaves the bottom hidden', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: false, bottomStandalone: false })
  })

  it('closing Hero files leaves an already visible bottom panel visible', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    actions.toggleHeroPanel(SESSION, 'files')
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({ open: false, bottomOpen: true, bottomStandalone: true })
    actions.openDetails()
    actions.toggleHeroPanel(SESSION, 'bottom')
    expect(store.getSnapshot()).toMatchObject({
      details: 0, workbench: { [SESSION]: { open: false, bottomOpen: true, bottomStandalone: true } },
    })
  })

  it('the resident terminal control closes a Hero-only bottom panel after the first message', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'bottom')
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: false, bottomOpen: false, bottomStandalone: false,
    })
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

  it('restores a workbench obscured by details before toggling it closed', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION)
    actions.setWorkbench(SESSION, 500)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.openDetails()

    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      workbench: { [SESSION]: { open: true, fullscreen: true, width: 500 } },
    })
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      open: false, fullscreen: false, width: 500,
    })
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
