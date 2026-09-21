// @vitest-environment jsdom
/**
 * AppFrame 使用真实布局 store 和记录型 renderSlot。jsdom 没有布局引擎，
 * 测试通过 getBoundingClientRect 与 ResizeObserver stub 驱动宽高变化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import {
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_COLLAPSED,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

// SessionProvider 与 useSessions stub 共用的会话选择状态。
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const baselinesReady = { current: true }

// 生产环境由 renderer 注入；这里保留同一 render-prop 类型以校验 branded id。
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children(selectedSession.current)}</>


/** 捕获回调的 ResizeObserver stub，测试可显式触发尺寸变化。 */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920
let frameHeight = 1080

/** 测试专用 selector hook，直接订阅框架无关的 store 实例。 */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame() {
  window.innerWidth = frameWidth
  window.innerHeight = frameHeight
  const rawInstance = createLayoutStore().create()
  const instance = rawInstance
  const publishWorkbench = vi.fn()
  const retainWorkbenchViews = vi.fn()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'workbench') return <div data-testid="workbench-content" />
    if (key === 'workbench.bottom') return <div data-testid="bottom-content" />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const ids = current === undefined
      ? []
      : Array.from(new Set(['s-test' as SessionId, 's-next' as SessionId, current]))
    const sessionState = {
      ids,
      byId: current === undefined
        ? {}
        : Object.fromEntries(ids.map(sessionId => [sessionId, {
          id: sessionId,
          displayTitle: 'Test',
          running: false,
          blank: sessionId === current ? selectedSessionBlank.current : false,
          updatedAt: 1,
        }])),
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
  }
  const element = () => (
    <AppFrame
      useStore={hookOf(rawInstance)}
      actions={rawInstance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
      publishWorkbench={publishWorkbench}
      retainWorkbenchViews={retainWorkbenchViews}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return {
    instance,
    frame,
    slotCalls,
    publishWorkbench,
    rerenderFrame: () => { utils.rerender(element()) },
    ownerFor: (key: string) => slotCalls.filter(call => call.key === key).at(-1)?.props,
    ...utils,
  }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function rows(frame: HTMLElement): number {
  const match = /^minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateRows)
  if (match === null) throw new Error(`unexpected rows: ${frame.style.gridTemplateRows}`)
  return Number(match[1])
}

function handleFor(frame: HTMLElement, side: string): HTMLElement {
  const handle = frame.querySelector<HTMLElement>(`[data-side="${side}"]`)
  if (handle === null) throw new Error(`missing ${side} handle`)
  return handle
}

function drag(handle: Element, from: number, to: number, orientation: 'vertical' | 'horizontal' = 'vertical'): void {
  const coordinates = orientation === 'vertical' ? { clientX: from } : { clientY: from }
  const movedCoordinates = orientation === 'vertical' ? { clientX: to } : { clientY: to }
  const down = new PointerEvent('pointerdown', { pointerId: 1, ...coordinates, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, ...movedCoordinates, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, ...movedCoordinates, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  frameWidth = 1920
  frameHeight = 1080
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  baselinesReady.current = true
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  window.innerHeight = frameHeight
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: frameWidth, height: frameHeight, top: 0, left: 0,
      right: frameWidth, bottom: frameHeight, x: 0, y: 0, toJSON: () => ({}),
    }
  }
  // jsdom 不实现 pointer capture；按元素记录真实 pointer id。
  const captured = new WeakMap<Element, number>()
  Element.prototype.setPointerCapture = function (id: number) { captured.set(this, id) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function (id: number) { return captured.get(this) === id }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps every session surface mounted with the expected owner shares', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    expect(getByTestId('workbench-content')).toBeTruthy()
    expect(getByTestId('bottom-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).toContain('workbench')
    expect(keys).toContain('workbench.bottom')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'workbench')!.props).toMatchObject({
      shown: false,
      fullscreen: false,
      bottomOpen: false,
    })
    expect(slotCalls.find(c => c.key === 'workbench.bottom')!.props).toEqual({ shown: false })
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // 没有当前 Session 时，session-maybe 对话壳自行拥有新建会话视图。
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // 外壳不增加 loading gate；两个占用者从首帧起保持挂载。
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // 第二级让步把实际详情栏压到 330，偏好仍为 360。
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // 从实际宽度缩小 10px。
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — fixed workbench', () => {
  it('opens beside the conversation without collapsing navigation', () => {
    const { frame, instance, ownerFor, getByTestId, publishWorkbench } = mountFrame()
    act(() => {
      instance.actions.openDetails()
      instance.actions.openWorkbench('s-test' as SessionId)
    })

    expect(tracks(frame)).toEqual([280, 1020])
    expect(rows(frame)).toBe(0)
    expect(frame.hasAttribute('data-workbench-shown')).toBe(true)
    expect(getByTestId('details-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(false)
    expect(ownerFor('workbench')).toMatchObject({ shown: true, fullscreen: false, bottomOpen: false })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: true, fullscreen: false, bottomOpen: false,
    })
  })

  it('fits the default split at a 1110px viewport while keeping the sidebar', () => {
    frameWidth = 1110
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test' as SessionId) })
    expect(tracks(frame)).toEqual([280, 430])
  })

  it('responds to the external workbench controls through per-session layout state', () => {
    const { frame, instance, ownerFor, getByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test' as SessionId) })

    act(() => { instance.actions.toggleWorkbenchBottom('s-test' as SessionId) })
    expect(rows(frame)).toBe(260)
    expect(frame.hasAttribute('data-bottom-open')).toBe(true)
    expect(ownerFor('workbench.bottom')).toEqual({ shown: true })
    expect(getByTestId('bottom-content').parentElement?.hasAttribute('inert')).toBe(false)

    act(() => { instance.actions.toggleWorkbenchFullscreen('s-test' as SessionId) })
    expect(tracks(frame)).toEqual([280, 1640])
    expect(frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(getByTestId('center-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(frame.querySelector('[data-side="workbench"]')).toBeNull()

    act(() => { instance.actions.closeWorkbench('s-test' as SessionId) })
    expect(tracks(frame)).toEqual([280, 0])
    expect(rows(frame)).toBe(0)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(true)
  })

  it('narrow view collapses navigation and gives the main content to workbench', () => {
    frameWidth = 980
    const { frame, instance, ownerFor, getByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test' as SessionId) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 980 - SIDEBAR_COLLAPSED])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(getByTestId('center-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(ownerFor('workbench')).toMatchObject({ shown: true, fullscreen: true })
    expect(frame.querySelector('[data-side="sidebar"]')).toBeNull()
    expect(frame.querySelector('[data-side="workbench"]')).toBeNull()
  })

  it('drags workbench width and bottom height from their rendered bases', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test' as SessionId) })
    drag(handleFor(frame, 'workbench'), 1500, 1440)
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(1080)
    expect(tracks(frame)).toEqual([280, 1080])

    act(() => { instance.actions.toggleWorkbenchBottom('s-test' as SessionId) })
    drag(handleFor(frame, 'bottom'), 820, 760, 'horizontal')
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(320)
    expect(rows(frame)).toBe(320)
  })

  it('uses a concession-shrunk workbench width as the drag base', () => {
    frameWidth = 1110
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.setWorkbench('s-test' as SessionId, 500)
      instance.actions.openWorkbench('s-test' as SessionId)
    })
    expect(tracks(frame)).toEqual([280, 430])
    drag(handleFor(frame, 'workbench'), 610, 620)
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(420)
  })

  it('bottom yields to short heights and restores its preference after resize', () => {
    frameHeight = 300
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.openWorkbench('s-test' as SessionId)
      instance.actions.toggleWorkbenchBottom('s-test' as SessionId)
    })
    expect(rows(frame)).toBe(60)
    frameHeight = 1080
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(rows(frame)).toBe(260)
  })

  it('restores each session workbench independently after switching sessions', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test' as SessionId) })
    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 1020])
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // 宽屏关闭后偏好为 0。
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // 窄屏临时展开不改写偏好。
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('exposes keyboard-operable separators for vertical and horizontal resizing', () => {
    const { frame, instance } = mountFrame()
    const sidebar = handleFor(frame, 'sidebar')
    expect(sidebar.getAttribute('role')).toBe('separator')
    expect(sidebar.getAttribute('aria-orientation')).toBe('vertical')
    expect(sidebar.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_MIN))
    expect(sidebar.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_MAX))

    act(() => { sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(296)
    act(() => { sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    act(() => { sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    act(() => { sidebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(SIDEBAR_MAX)

    act(() => {
      instance.actions.openWorkbench('s-test' as SessionId)
      instance.actions.toggleWorkbenchBottom('s-test' as SessionId)
    })
    const workbench = handleFor(frame, 'workbench')
    act(() => { workbench.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(1004)
    act(() => { workbench.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(WORKBENCH_MIN)
    act(() => { workbench.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(WORKBENCH_MAX)

    const bottom = handleFor(frame, 'bottom')
    expect(bottom.getAttribute('aria-orientation')).toBe('horizontal')
    act(() => { bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(276)
    act(() => { bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(260)
    act(() => { bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(WORKBENCH_BOTTOM_MIN)
    act(() => { bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(WORKBENCH_BOTTOM_MAX)

    act(() => { instance.actions.openDetails() })
    const details = handleFor(frame, 'details')
    act(() => { details.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(instance.getSnapshot().details).toBe(376)
    act(() => { details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(instance.getSnapshot().details).toBe(DETAILS_MIN)
    act(() => { details.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(instance.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('ignores secondary and concurrent pointer starts', () => {
    const { frame, instance } = mountFrame()
    const handle = handleFor(frame, 'sidebar')
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 2, clientX: 280, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(280)

    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 280, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, button: 0, clientX: 300, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(280)
    expect(frame.hasAttribute('data-dragging')).toBe(false)
  })

  it('lost pointer capture and window blur cancel pending drag frames', () => {
    const { frame, instance } = mountFrame()
    const handle = handleFor(frame, 'sidebar')
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 350, bubbles: true }))
      handle.releasePointerCapture(1)
      handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(280)

    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 280, bubbles: true }))
    })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 360, bubbles: true }))
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(20)
    })
    expect(instance.getSnapshot().sidebar).toBe(280)
    expect(frame.hasAttribute('data-dragging')).toBe(false)
  })

  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // 没有 pointerdown 的 move 与 up 必须被忽略。
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // 同一帧内的第二次移动复用待处理 rAF，flush 使用最新坐标。
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // 不推进计时器，让 pointerup 在 rAF 仍待处理时到达。
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // 轨道继续使用最后一次非零视口尺寸。
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('zero-height and unchanged resize reports preserve the current geometry', () => {
    const { frame } = mountFrame()
    frameHeight = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(rows(frame)).toBe(0)
    frameHeight = 1080
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF 已排队但尚未 flush。
    unmount()
    // 卸载后的 flush 应为空操作，因为待处理帧已经取消。
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })

  it('releases an active pointer and pending drag frame during unmount', () => {
    const { frame, unmount } = mountFrame()
    const handle = handleFor(frame, 'sidebar')
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true }))
    })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      unmount()
      vi.advanceTimersByTime(20)
    })
    expect(frame.isConnected).toBe(false)
  })
})
