/**
 * LayoutController 只转发跨插件动作；几何和值域由 store 测试覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from 'coding-client-ui-layout/src/client/service.ts'
import { createLayoutStore } from 'coding-client-ui-layout/src/client/stores.ts'
import type { PanelActions } from 'coding-client-ui-layout/src/client/service.ts'
import type { SessionId } from 'coding-session/types'

const SESSION = 'layout-session' as SessionId

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    setWorkbench: vi.fn(),
    setWorkbenchBottom: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openWorkbench: vi.fn(),
    closeWorkbench: vi.fn(),
    toggleWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(),
    toggleWorkbenchBottom: vi.fn(),
    closeWorkbenchBottom: vi.fn(),
    toggleHeroPanel: vi.fn(),
    beginNewConversation: vi.fn(),
    selectConversation: vi.fn(),
    setActiveBlankSession: vi.fn(),
    clearBlankWorkbench: vi.fn(),
    retainBlankSessions: vi.fn(),
    retainWorkbenchSessions: vi.fn(),
    openPage: vi.fn(),
    closePage: vi.fn(),
    discardPage: vi.fn(),
    togglePage: vi.fn(),
    setPageAssistant: vi.fn(),
    setPageAssistantWidth: vi.fn(),
    requestShowConversation: vi.fn(),
    acknowledgeConversationRequest: vi.fn(),
    acknowledgeConversationReturn: vi.fn(),
    clearConversationRequest: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards every public panel action to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()
    service.openWorkbench(SESSION)
    service.openWorkbench(SESSION, SESSION)
    service.closeWorkbench(SESSION, SESSION)
    service.toggleWorkbench(SESSION, SESSION)
    service.toggleWorkbenchFullscreen(SESSION)
    service.toggleWorkbenchBottom(SESSION)
    service.closeWorkbenchBottom(SESSION)
    service.toggleHeroPanel(SESSION, 'bottom')
    service.toggleHeroPanel(SESSION, 'files', SESSION)
    expect(service.conversationIntent).toBe(0)
    service.beginNewConversation()
    expect(service.conversationIntent).toBe(1)
    service.openPage('image-gallery', SESSION, 'origin-session' as SessionId)
    service.closePage()
    service.setPageAssistant(true)
    service.togglePage('image-gallery', SESSION, 'origin-session' as SessionId)
    service.showConversation(SESSION)

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.openWorkbench).toHaveBeenCalledWith(SESSION, undefined)
    expect(panels.openWorkbench).toHaveBeenCalledWith(SESSION, SESSION)
    expect(panels.closeWorkbench).toHaveBeenCalledWith(SESSION, SESSION)
    expect(panels.toggleWorkbench).toHaveBeenCalledWith(SESSION, SESSION)
    expect(panels.toggleWorkbenchFullscreen).toHaveBeenCalledWith(SESSION)
    expect(panels.toggleWorkbenchBottom).toHaveBeenCalledWith(SESSION)
    expect(panels.closeWorkbenchBottom).toHaveBeenCalledWith(SESSION)
    expect(panels.toggleHeroPanel).toHaveBeenCalledWith(SESSION, 'bottom', undefined)
    expect(panels.toggleHeroPanel).toHaveBeenCalledWith(SESSION, 'files', SESSION)
    expect(panels.beginNewConversation).toHaveBeenCalledOnce()
    expect(panels.openPage).toHaveBeenCalledWith('image-gallery', SESSION, 'origin-session')
    expect(panels.closePage).toHaveBeenCalledOnce()
    expect(panels.setPageAssistant).toHaveBeenCalledWith(true)
    expect(panels.togglePage).toHaveBeenCalledWith('image-gallery', SESSION, 'origin-session')
    expect(panels.requestShowConversation).toHaveBeenCalledWith(SESSION)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
    expect(panels.setWorkbench).not.toHaveBeenCalled()
    expect(panels.setWorkbenchBottom).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.openWorkbench(SESSION) }).toThrow(/panel actions not wired/)
    expect(() => { service.closeWorkbench(SESSION) }).toThrow(/panel actions not wired/)
    expect(() => { service.toggleWorkbench(SESSION) }).toThrow(/panel actions not wired/)
    expect(() => { service.closeWorkbenchBottom(SESSION) }).toThrow(/panel actions not wired/)
    expect(() => { service.toggleHeroPanel(SESSION, 'files') }).toThrow(/panel actions not wired/)
    expect(() => { service.beginNewConversation() }).toThrow(/panel actions not wired/)
    expect(() => { service.openPage('image-gallery', SESSION) }).toThrow(/panel actions not wired/)
    expect(() => { service.closePage() }).toThrow(/panel actions not wired/)
    expect(() => { service.showConversation(SESSION) }).toThrow(/panel actions not wired/)
  })

  it('登记并触发页面助手的新对话入口，进行中忽略重复点击', async () => {
    const service = new LayoutController()
    expect(service.pageConversation.getSnapshot()).toBe(false)
    // 未登记入口时点击不改变任何状态。
    service.startPageConversation()

    let finish: (() => void) | undefined
    const starter = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const detach = service.attachPageConversation(starter)
    expect(service.pageConversation.getSnapshot()).toBe(true)

    service.startPageConversation()
    service.startPageConversation()
    expect(starter).toHaveBeenCalledTimes(1)

    finish?.()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    service.startPageConversation()
    expect(starter).toHaveBeenCalledTimes(2)
    finish?.()
    detach()
    expect(service.pageConversation.getSnapshot()).toBe(false)
  })

  it('页面新对话失败时保留现有页面，旧登记方的注销不影响新入口', async () => {
    const service = new LayoutController()
    const failing = vi.fn(async () => { throw new Error('boom') })
    const detach = service.attachPageConversation(failing)
    service.startPageConversation()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(service.pageConversation.getSnapshot()).toBe(true)

    const next = vi.fn(async () => {})
    const detachNext = service.attachPageConversation(next)
    detach()
    expect(service.pageConversation.getSnapshot()).toBe(true)
    detachNext()
    expect(service.pageConversation.getSnapshot()).toBe(false)
  })

  it('publishes stable per-workspace workbench snapshots for header controls', () => {
    const service = new LayoutController()
    const source = service.workbench(SESSION)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    expect(source.getSnapshot()).toEqual({ open: false, fullscreen: false, bottomOpen: false })
    service.publishWorkbench(SESSION, { open: true, fullscreen: false, bottomOpen: true })
    expect(source.getSnapshot()).toEqual({ open: true, fullscreen: false, bottomOpen: true })
    expect(listener).toHaveBeenCalledOnce()
    service.publishWorkbench(SESSION, { open: true, fullscreen: true, bottomOpen: true })
    expect(source.getSnapshot().fullscreen).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    service.publishWorkbench(SESSION, { open: true, fullscreen: true, bottomOpen: true })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('updates the published page when only its return conversation changes', () => {
    const service = new LayoutController()
    const listener = vi.fn()
    const unsubscribe = service.page.subscribe(listener)
    service.publishPage({ kind: 'image-gallery', sessionId: SESSION })
    service.publishPage({ kind: 'image-gallery', sessionId: SESSION, returnSessionId: 'origin-session' as SessionId })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(service.page.getSnapshot()?.returnSessionId).toBe('origin-session')
    service.publishPage({ kind: 'image-gallery', sessionId: SESSION, returnSessionId: 'origin-session' as SessionId })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(stale.clearConversationRequest).toHaveBeenCalledOnce()
    service.detachPanels()
    expect(fresh.clearConversationRequest).toHaveBeenCalledOnce()
    expect(() => { service.showConversation(SESSION) }).toThrow(/panel actions not wired/)
  })

  it('clears outstanding requests on dispose and does not replay them on re-register', () => {
    const service = new LayoutController()
    const oldRoot = createLayoutStore().create()
    service.attachPanels(oldRoot.actions)
    service.showConversation(SESSION)
    expect(oldRoot.store.getSnapshot().conversationRequest?.sessionId).toBe(SESSION)
    service.detachPanels()
    expect(oldRoot.store.getSnapshot().conversationRequest).toBeNull()
    const newRoot = createLayoutStore().create()
    service.attachPanels(newRoot.actions)
    expect(newRoot.store.getSnapshot().conversationRequest).toBeNull()
  })
})
