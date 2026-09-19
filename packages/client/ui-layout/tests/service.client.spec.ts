/**
 * LayoutController 只转发跨插件动作；几何和值域由 store 测试覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

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
    service.openWorkbench()
    service.closeWorkbench()
    service.toggleWorkbench()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.openWorkbench).toHaveBeenCalledTimes(1)
    expect(panels.closeWorkbench).toHaveBeenCalledTimes(1)
    expect(panels.toggleWorkbench).toHaveBeenCalledTimes(1)
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
    expect(() => { service.openWorkbench() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeWorkbench() }).toThrow(/panel actions not wired/)
    expect(() => { service.toggleWorkbench() }).toThrow(/panel actions not wired/)
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
  })
})
