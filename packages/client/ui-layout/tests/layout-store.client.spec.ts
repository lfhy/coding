// @vitest-environment jsdom
/** 使用真实 store 引擎覆盖布局初值、完整 action 集合和非持久化语义。 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from 'coding-session/types'
import { createLayoutStore } from 'coding-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT,
  PAGE_ASSISTANT_DEFAULT,
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
  sidebarExpandedWidth: SIDEBAR_DEFAULT,
  details: 0,
  narrow: false,
  narrowExpanded: false,
  workbench: {},
  rightWorkbench: {},
  page: null,
  pageAssistant: null,
  pageAssistantWidth: PAGE_ASSISTANT_DEFAULT,
  conversationRequest: null,
  conversationReturn: null,
  conversationRequestSeq: 0,
}

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('lets a blank open files without resetting the other session’s right panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.toggleHeroPanel('shared', 'files', NEXT_SESSION)
    expect(store.getSnapshot().rightWorkbench).toEqual({
      [SESSION]: { fullscreen: true }, [NEXT_SESSION]: { fullscreen: false },
    })
    actions.toggleHeroPanel('shared', 'files', NEXT_SESSION)
    expect(store.getSnapshot().rightWorkbench).toEqual({ [SESSION]: { fullscreen: true } })
  })

  it('a background open preserves frontmost details and existing fullscreen preferences', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.openDetails()
    actions.openWorkbench(SESSION, false)
    actions.openWorkbench(NEXT_SESSION, false)
    expect(store.getSnapshot()).toMatchObject({
      details: DETAILS_DEFAULT,
      rightWorkbench: { [SESSION]: { fullscreen: true }, [NEXT_SESSION]: { fullscreen: false } },
    })
  })

  it('resets blank right panels without changing the shared bottom or other sessions', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.openWorkbench(NEXT_SESSION, false)
    actions.toggleWorkbenchBottom('shared')
    actions.resetBlankWorkbench([NEXT_SESSION])
    expect(store.getSnapshot().workbench.shared?.bottomOpen).toBe(true)
    expect(store.getSnapshot().rightWorkbench).toEqual({ [SESSION]: { fullscreen: false } })
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
    actions.openWorkbench(SESSION, true)
    actions.openPage('image-gallery', SESSION)
    expect(store.getSnapshot()).toMatchObject({ page: { kind: 'image-gallery', sessionId: SESSION },
      rightWorkbench: { [SESSION]: { fullscreen: false } } })
    actions.closePage()
    expect(store.getSnapshot()).toMatchObject({ page: null, rightWorkbench: { [SESSION]: { fullscreen: false } } })
  })

  it('tracks the page AI assistant and resets it when the page closes or is replaced', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openPage('notes', SESSION)
    actions.setPageAssistant('auto')
    expect(store.getSnapshot()).toMatchObject({ page: { kind: 'notes', sessionId: SESSION }, pageAssistant: 'auto' })
    actions.setPageAssistant(false)
    expect(store.getSnapshot().pageAssistant).toBe(false)
    actions.openPage('files', NEXT_SESSION)
    expect(store.getSnapshot()).toMatchObject({ page: { kind: 'files', sessionId: NEXT_SESSION }, pageAssistant: null })
    actions.setPageAssistant(true)
    actions.closePage()
    expect(store.getSnapshot()).toMatchObject({ page: null, pageAssistant: null })
    actions.setPageAssistant(true)
    expect(store.getSnapshot().pageAssistant).toBeNull()
    actions.openPage('notes', SESSION)
    actions.setPageAssistant(true)
    actions.discardPage()
    expect(store.getSnapshot()).toMatchObject({ page: null, pageAssistant: null })
  })

  it('remembers the originating conversation across files and gallery, then returns it once', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openPage('files', SESSION)
    actions.openPage('image-gallery', NEXT_SESSION, SESSION)
    expect(store.getSnapshot().page).toEqual({ kind: 'image-gallery', sessionId: NEXT_SESSION, returnSessionId: SESSION })
    actions.closePage()
    const pending = store.getSnapshot().conversationReturn
    expect(pending).toMatchObject({ from: NEXT_SESSION, sessionId: SESSION })
    actions.acknowledgeConversationReturn(pending!.seq - 1)
    expect(store.getSnapshot().conversationReturn).toBe(pending)
    actions.acknowledgeConversationReturn(pending!.seq)
    expect(store.getSnapshot().conversationReturn).toBeNull()
    actions.closePage()
    expect(store.getSnapshot().conversationReturn).toBeNull()
  })

  it('drops pending restoration when a page is discarded or replaced', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openPage('image-gallery', NEXT_SESSION, SESSION)
    actions.togglePage('image-gallery', NEXT_SESSION)
    expect(store.getSnapshot().conversationReturn).toMatchObject({ from: NEXT_SESSION, sessionId: SESSION })
    actions.openPage('files', NEXT_SESSION)
    expect(store.getSnapshot().conversationReturn).toBeNull()
    actions.openPage('image-gallery', NEXT_SESSION, SESSION)
    actions.discardPage()
    expect(store.getSnapshot()).toMatchObject({ page: null, conversationReturn: null })
  })

  it('initializes closed details and workbench with reusable size preferences', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual(initialState)
  })

  it('creates independent instances', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    a.actions.openWorkbench(SESSION, true)
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

  it('宽屏折叠后恢复最后拖拽宽度，页面切换不清除偏好', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 0, sidebarExpandedWidth: 400 })
    actions.openPage('files', SESSION)
    actions.openPage('image-gallery', SESSION)
    actions.closePage()
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, sidebarExpandedWidth: 400 })
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
    actions.openWorkbench(SESSION, true)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      narrow: true,
      narrowExpanded: true,
      rightWorkbench: { [SESSION]: { fullscreen: false } },
    })
  })

  it('workbench presentation toggles only while open and close preserves the visible bottom and size preferences', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleWorkbenchFullscreen(SESSION)
    expect(store.getSnapshot().rightWorkbench).toEqual({})

    actions.openWorkbench(SESSION, true)
    actions.setWorkbench(SESSION, 500)
    actions.setWorkbenchBottom(SESSION, 320)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: true })
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    expect(store.getSnapshot().workbench[SESSION]).toMatchObject({
      width: 500,
      bottomOpen: true,
      bottomHeight: 320,
    })
  })

  it('bottom toggle preserves the right workbench and opens only the bottom row when the right side is closed', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()

    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      workbench: { [SESSION]: { bottomOpen: true } },
    })
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)

    actions.toggleWorkbenchBottom(SESSION)
    actions.openWorkbench(SESSION, true)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: false })
  })

  it('hides the bottom panel idempotently without changing the right workbench or details', () => {
    const { store, actions } = createLayoutStore().create()
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]).toBeUndefined()

    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
    actions.openDetails()
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().details).not.toBe(0)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: false })

    actions.closeWorkbench(SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
  })

  it('Hero buttons alternate exclusive panel visibility without changing the navigation', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'bottom', SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    actions.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: false })
    actions.toggleHeroPanel(SESSION, 'bottom', SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    actions.toggleHeroPanel(SESSION, 'bottom', SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
  })

  it('toggles the entire right workbench from Hero', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: false })

    actions.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    actions.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toEqual({ fullscreen: false })
  })

  it('closing the right workbench retains the bottom row when it was visible', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbenchBottom(SESSION)
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
  })

  it('closing a right-only workbench leaves the bottom hidden', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.closeWorkbench(SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    expect(store.getSnapshot().workbench[SESSION]).toBeUndefined()
  })

  it('closing Hero files leaves an already visible bottom panel visible', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.toggleWorkbenchBottom(SESSION)
    actions.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(true)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    actions.openDetails()
    actions.toggleHeroPanel(SESSION, 'bottom', SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0, workbench: { [SESSION]: { bottomOpen: true } },
    })
  })

  it('the resident terminal control closes a Hero-only bottom panel after the first message', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleHeroPanel(SESSION, 'bottom', SESSION)
    actions.toggleWorkbenchBottom(SESSION)
    expect(store.getSnapshot().workbench[SESSION]?.bottomOpen).toBe(false)
  })

  it('toggleWorkbench covers open and close while retaining bottom preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot()).toMatchObject({ details: 0, rightWorkbench: { [SESSION]: { fullscreen: false } } })
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
  })

  it('restores a workbench obscured by details before toggling it closed', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench(SESSION, true)
    actions.setWorkbench(SESSION, 500)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.openDetails()

    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot()).toMatchObject({
      details: 0,
      rightWorkbench: { [SESSION]: { fullscreen: true } },
    })
    actions.toggleWorkbench(SESSION)
    expect(store.getSnapshot().rightWorkbench[SESSION]).toBeUndefined()
    expect(store.getSnapshot().workbench[SESSION]?.width).toBe(500)
  })

  it('opening details preserves each session workbench state for later restoration', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.openWorkbench(SESSION, true)
    actions.openWorkbench(NEXT_SESSION, false)
    actions.toggleWorkbenchFullscreen(SESSION)
    actions.openDetails()
    expect(store.getSnapshot().rightWorkbench).toEqual({
      [SESSION]: { fullscreen: true }, [NEXT_SESSION]: { fullscreen: false },
    })
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('releases workbench state for sessions that left the live list', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setWorkbench('shared', 500)
    actions.setWorkbench('removed-workspace', 700)
    actions.openWorkbench(SESSION, true)
    actions.openWorkbench(NEXT_SESSION, false)
    actions.retainWorkbenchSessions(['shared'], [SESSION])
    expect(store.getSnapshot().workbench).not.toHaveProperty('removed-workspace')
    expect(store.getSnapshot().workbench.shared?.width).toBe(500)
    expect(store.getSnapshot().rightWorkbench).toEqual({ [SESSION]: { fullscreen: false } })
  })

  it('does not persist layout geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openWorkbench(SESSION, true)
    first.actions.setWorkbench(SESSION, 500)
    first.actions.toggleWorkbenchBottom(SESSION)
    first.actions.setWorkbenchBottom(SESSION, 320)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
    expect(createLayoutStore().create().store.getSnapshot()).toEqual(initialState)
  })
})
