// @vitest-environment jsdom
/**
 * AppFrame 使用真实布局 store 和记录型 renderSlot。jsdom 没有布局引擎，
 * 测试通过 getBoundingClientRect 与 ResizeObserver stub 驱动宽高变化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Menu } from 'coding-client-ui-primitives'
import { AppFrame } from 'coding-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from 'coding-client-ui-layout/src/client/AppFrame.tsx'
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
} from 'coding-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from 'coding-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from 'coding-client-runtime/client'

// SessionProvider 与 useSessions stub 共用的会话选择状态。
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const baselinesReady = { current: true }
const layoutLabels: Record<string, string> = {
  'floating.open': '继续对话',
  'floating.open.label': '打开悬浮对话',
  'floating.dialog.label': '悬浮对话',
  'floating.minimize.label': '收起悬浮对话',
}

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

/** 用真实 Menu 覆盖 document Escape 监听器与浮窗 React 冒泡之间的时序。 */
function NestedMenu({ portal }: { portal: boolean }) {
  const [open, setOpen] = useState(false)
  return <Menu
    open={open}
    portal={portal}
    keyboardNavigation={portal}
    anchor={<button type="button" aria-label="内部菜单" {...(portal ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open } : {})}
      onClick={() => { setOpen(current => !current) }}>打开菜单</button>}
    items={[{ id: 'choice', label: '菜单选项' }]}
    onSelect={() => { setOpen(false) }}
    onClose={() => { setOpen(false) }}
  />
}

/** 概览弹层通过 aria-controls 关联根外 region，并在 document 阶段消费 Escape。 */
function ControlledRegion() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const region = document.createElement('section')
    region.id = 'test-controlled-region'
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', '内部协作弹层')
    document.body.append(region)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      region.remove()
    }
  }, [open])
  return <button type="button" aria-expanded={open} aria-controls="test-controlled-region"
    onClick={() => { setOpen(value => !value) }}>协作详情</button>
}

function mountFrame(options: {
  workspaceKeyOf?: (id: SessionId) => string
  menuMode?: 'inline-anchor' | 'portal-item'
  controlledRegion?: boolean
} = {}) {
  window.innerWidth = frameWidth
  window.innerHeight = frameHeight
  const rawInstance = createLayoutStore().create()
  const instance = rawInstance
  const publishWorkbench = vi.fn()
  const publishPage = vi.fn()
  const retainWorkbenchViews = vi.fn()
  const consumeEscape = { current: false }
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return (
      <div data-testid="center-content">
        <textarea aria-label="测试会话草稿" onKeyDown={(event) => {
          if (event.key === 'Escape' && consumeEscape.current) event.preventDefault()
        }} />
        {options.menuMode !== undefined && <NestedMenu portal={options.menuMode === 'portal-item'} />}
        {options.controlledRegion && <ControlledRegion />}
      </div>
    )
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'workbench') return <div data-testid="workbench-content" />
    if (key === 'workbench.bottom') return <div data-testid="bottom-content" />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    if (key === 'shell.page') return <main data-testid="gallery-page" />
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
  const workspaceKeyOf = (id: SessionId): string => id
  const element = () => (
    <AppFrame
      useStore={hookOf(rawInstance)}
      actions={rawInstance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
      publishWorkbench={publishWorkbench}
      publishPage={publishPage}
      retainWorkbenchViews={retainWorkbenchViews}
      workspaceKeyOf={options.workspaceKeyOf ?? workspaceKeyOf}
      t={key => layoutLabels[key] ?? key}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return {
    instance,
    frame,
    slotCalls,
    publishWorkbench,
    publishPage,
    consumeEscape,
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

function floatingLauncher(frame: HTMLElement): HTMLButtonElement | null {
  return frame.querySelector<HTMLButtonElement>('button[aria-label="打开悬浮对话"]')
}

function launcherVisible(frame: HTMLElement): boolean {
  const launcher = floatingLauncher(frame)
  return launcher !== null && launcher.getAttribute('aria-hidden') !== 'true' && !launcher.hasAttribute('inert')
}

function conversationColumn(content: HTMLElement): HTMLElement | null {
  return content.closest<HTMLElement>('#dsh-layout-floating-conversation')
}

function floatingDialog(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>('[role="dialog"][aria-label="悬浮对话"]')
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
  it('places an independent session page beside the sidebar and restores the mounted conversation', () => {
    const b = mountFrame()
    const center = conversationColumn(b.getByTestId('center-content'))
    act(() => { b.instance.actions.openPage('image-gallery', 's-test' as SessionId) })
    expect(b.getByTestId('gallery-page')).toBeTruthy()
    expect(b.getByTestId('sidebar-content')).toBeTruthy()
    expect(center?.hasAttribute('inert')).toBe(true)
    expect(b.frame.getAttribute('data-page-open')).toBe('true')
    const owner = b.ownerFor('shell.page') as { closePage(): void }
    act(() => { owner.closePage() })
    expect(b.queryByTestId('gallery-page')).toBeNull()
    expect(center?.hasAttribute('inert')).toBe(false)
    expect(b.getByTestId('center-content')).toBeTruthy()
  })

  it('closes a page when navigation selects another session', () => {
    const b = mountFrame()
    act(() => { b.instance.actions.openPage('image-gallery', 's-test' as SessionId) })
    selectedSession.current = 's-next' as SessionId
    b.rerenderFrame()
    expect(b.queryByTestId('gallery-page')).toBeNull()
    expect(b.instance.store.getSnapshot().page).toBeNull()
  })

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
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({ sidebarCollapsed: false })
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'workbench')!.props).toMatchObject({
      shown: false,
      fullscreen: false,
      bottomOpen: false,
    })
    expect(slotCalls.find(c => c.key === 'workbench.bottom')!.props).toEqual({ sessionId: 's-test', shown: false })
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // 没有当前 Session 时，session-maybe 对话壳自行拥有新建会话视图。
    selectedSession.current = undefined
    const { slotCalls, getByTestId, ownerFor } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: true })
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // 外壳不增加 loading gate；两个占用者从首帧起保持挂载。
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('closes details on a Session change, including a blank Session', () => {
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
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

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
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({
      collapsed: false, width: 280, welcomeActionsVisible: false,
    })
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
    expect(lastSidebarCall.props).toEqual({
      collapsed: true, width: SIDEBAR_COLLAPSED, welcomeActionsVisible: false,
    })
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
      instance.actions.openWorkbench('s-test')
    })

    expect(tracks(frame)).toEqual([280, 1020])
    expect(rows(frame)).toBe(0)
    expect(frame.hasAttribute('data-workbench-shown')).toBe(true)
    expect(getByTestId('details-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(false)
    expect(ownerFor('workbench')).toEqual({ shown: true, fullscreen: false, bottomOpen: false })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: true, fullscreen: false, bottomOpen: false,
    })
  })

  it('closes the right workbench when the header toggle is clicked again', () => {
    const { frame, instance } = mountFrame({ workspaceKeyOf: () => 'shared-workspace' })
    act(() => { instance.actions.openWorkbench('shared-workspace') })
    expect(frame.hasAttribute('data-workbench-shown')).toBe(true)
    act(() => { instance.actions.toggleWorkbench('shared-workspace') })
    expect(frame.hasAttribute('data-workbench-shown')).toBe(false)
  })
  it('uses one workbench projection for sessions in the same workspace', () => {
    const { frame, instance, rerenderFrame, publishWorkbench } = mountFrame({
      workspaceKeyOf: () => 'shared-workspace',
    })
    act(() => { instance.actions.openWorkbench('shared-workspace') })
    expect(publishWorkbench).toHaveBeenLastCalledWith('shared-workspace', expect.objectContaining({ open: true }))

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 1020])
    expect(publishWorkbench).toHaveBeenLastCalledWith('shared-workspace', expect.objectContaining({ open: true }))
  })

  it('fits the default split at a 1110px viewport while keeping the sidebar', () => {
    frameWidth = 1110
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test') })
    expect(tracks(frame)).toEqual([280, 430])
  })

  it('responds to the external workbench controls through per-workspace layout state', () => {
    const { frame, instance, ownerFor, getByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test') })

    act(() => { instance.actions.toggleWorkbenchBottom('s-test') })
    expect(rows(frame)).toBe(260)
    expect(frame.hasAttribute('data-bottom-open')).toBe(true)
    expect(ownerFor('workbench.bottom')).toEqual({ sessionId: 's-test', shown: true })
    expect(getByTestId('bottom-content').parentElement?.hasAttribute('inert')).toBe(false)

    act(() => { instance.actions.toggleWorkbenchFullscreen('s-test') })
    expect(tracks(frame)).toEqual([280, 1640])
    expect(frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(conversationColumn(getByTestId('center-content'))?.hasAttribute('inert')).toBe(true)
    expect(frame.querySelector('[data-side="workbench"]')).toBeNull()

    act(() => { instance.actions.closeWorkbench('s-test') })
    expect(tracks(frame)).toEqual([280, 0])
    expect(rows(frame)).toBe(260)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(conversationColumn(getByTestId('center-content'))?.hasAttribute('inert')).toBe(false)
  })

  it('keeps a blank Session bottom panel and sidebar state when its first message arrives', () => {
    selectedSessionBlank.current = true
    const { frame, instance, rerenderFrame, ownerFor, publishWorkbench } = mountFrame()
    act(() => {
      instance.actions.toggleSidebar()
      instance.actions.toggleWorkbenchBottom('s-test')
    })
    expect(frame.hasAttribute('data-bottom-open')).toBe(true)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: true })
    expect(ownerFor('conversation')).toEqual({ sidebarCollapsed: true })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', expect.objectContaining({ bottomOpen: true }))

    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(frame.hasAttribute('data-bottom-open')).toBe(true)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: false })
    expect(ownerFor('conversation')).toEqual({ sidebarCollapsed: true })
  })

  it('opens the right workbench from the Hero files entry and publishes its visibility', () => {
    const { frame, instance, ownerFor, publishWorkbench } = mountFrame()

    act(() => { instance.actions.toggleHeroPanel('s-test', 'files') })
    expect(tracks(frame)).toEqual([280, 1020])
    expect(instance.getSnapshot().details).toBe(0)
    expect(ownerFor('workbench')).toEqual({ shown: true, fullscreen: false, bottomOpen: false })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: true, fullscreen: false, bottomOpen: false,
    })

    act(() => { instance.actions.toggleHeroPanel('s-test', 'files') })
    expect(ownerFor('workbench')).toEqual({ shown: false, fullscreen: false, bottomOpen: false })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: false, fullscreen: false, bottomOpen: false,
    })
  })

  it('terminal toggle opens only the bottom row from the closed state', () => {
    const { frame, instance, publishWorkbench, getByTestId } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    act(() => { instance.actions.toggleWorkbenchBottom('s-test') })
    expect(tracks(frame)).toEqual([280, 0])
    expect(rows(frame)).toBe(260)
    expect(conversationColumn(getByTestId('center-content'))?.hasAttribute('inert')).toBe(false)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: false, fullscreen: false, bottomOpen: true,
    })
    act(() => { instance.actions.toggleWorkbenchBottom('s-test') })
    expect(tracks(frame)).toEqual([280, 0])
    expect(rows(frame)).toBe(0)
  })

  it('Hero terminal occupies only the bottom row and keeps conversation available on narrow screens', () => {
    frameWidth = 768
    selectedSessionBlank.current = true
    const { frame, instance, getByTestId, ownerFor } = mountFrame()
    act(() => { instance.actions.toggleHeroPanel('s-test', 'bottom') })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(rows(frame)).toBe(260)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(conversationColumn(getByTestId('center-content'))?.hasAttribute('inert')).toBe(false)
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: true })
    expect(ownerFor('workbench.bottom')).toEqual({ sessionId: 's-test', shown: true })
    act(() => { instance.actions.toggleHeroPanel('s-test', 'files') })
    expect(rows(frame)).toBe(0)
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 768 - SIDEBAR_COLLAPSED])
    expect(ownerFor('workbench.bottom')).toEqual({ sessionId: 's-test', shown: false })
  })

  it('closing a combined workbench leaves the bottom row visible', () => {
    const { frame, instance, ownerFor, publishWorkbench } = mountFrame()
    act(() => {
      instance.actions.openWorkbench('s-test')
      instance.actions.toggleWorkbenchBottom('s-test')
    })
    expect(rows(frame)).toBe(260)
    act(() => { instance.actions.closeWorkbench('s-test') })
    expect(tracks(frame)).toEqual([280, 0])
    expect(rows(frame)).toBe(260)
    expect(ownerFor('workbench.bottom')).toEqual({ sessionId: 's-test', shown: true })
    expect(publishWorkbench).toHaveBeenLastCalledWith('s-test', {
      open: false, fullscreen: false, bottomOpen: true,
    })
  })

  it('narrow view collapses navigation and gives the main content to workbench', () => {
    frameWidth = 980
    const { frame, instance, ownerFor, getByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test') })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 980 - SIDEBAR_COLLAPSED])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(conversationColumn(getByTestId('center-content'))?.hasAttribute('inert')).toBe(true)
    expect(ownerFor('workbench')).toMatchObject({ shown: true, fullscreen: true })
    expect(frame.querySelector('[data-side="sidebar"]')).toBeNull()
    expect(frame.querySelector('[data-side="workbench"]')).toBeNull()
  })

  it('drags workbench width and bottom height from their rendered bases', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openWorkbench('s-test') })
    drag(handleFor(frame, 'workbench'), 1500, 1440)
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(1080)
    expect(tracks(frame)).toEqual([280, 1080])

    act(() => { instance.actions.toggleWorkbenchBottom('s-test') })
    drag(handleFor(frame, 'bottom'), 820, 760, 'horizontal')
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.bottomHeight).toBe(320)
    expect(rows(frame)).toBe(320)
  })

  it('uses a concession-shrunk workbench width as the drag base', () => {
    frameWidth = 1110
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.setWorkbench('s-test', 500)
      instance.actions.openWorkbench('s-test')
    })
    expect(tracks(frame)).toEqual([280, 430])
    drag(handleFor(frame, 'workbench'), 610, 620)
    expect(instance.getSnapshot().workbench['s-test' as SessionId]?.width).toBe(420)
  })

  it('bottom yields to short heights and restores its preference after resize', () => {
    frameHeight = 300
    const { frame, instance } = mountFrame()
    act(() => {
      instance.actions.openWorkbench('s-test')
      instance.actions.toggleWorkbenchBottom('s-test')
    })
    expect(rows(frame)).toBe(60)
    frameHeight = 1080
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(rows(frame)).toBe(260)
  })

  it('restores each session workbench independently after switching sessions', () => {
    const { frame, instance, rerenderFrame } = mountFrame({ workspaceKeyOf: id => id })
    act(() => { instance.actions.openWorkbench('s-test') })
    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 1020])
  })
})

describe('AppFrame — maximized workbench conversation', () => {
  it('shows a collapsed launcher only when the workbench actually takes over the conversation', () => {
    const b = mountFrame()
    expect(launcherVisible(b.frame)).toBe(false)
    act(() => { b.instance.actions.openWorkbench('s-test') })
    expect(launcherVisible(b.frame)).toBe(false)
    act(() => { b.instance.actions.toggleWorkbenchFullscreen('s-test') })
    const launcher = floatingLauncher(b.frame)
    expect(launcherVisible(b.frame)).toBe(true)
    expect(launcher?.getAttribute('aria-expanded')).toBe('false')
    expect(launcher?.getAttribute('aria-controls')).toBe('dsh-layout-floating-conversation')
    expect(floatingDialog(b.frame)).toBeNull()
    expect(b.getByTestId('center-content').closest('[inert]')).not.toBeNull()

    selectedSession.current = undefined
    act(() => { b.rerenderFrame() })
    expect(launcherVisible(b.frame)).toBe(false)
  })

  it('opens one retained conversation DOM with its draft, without changing the grid or rendering the slot twice', () => {
    const b = mountFrame()
    const center = b.getByTestId('center-content')
    const textarea = b.getByRole('textbox', { name: '测试会话草稿' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '未发送的草稿' } })
    act(() => {
      b.instance.actions.openWorkbench('s-test')
      b.instance.actions.toggleWorkbenchFullscreen('s-test')
    })
    const grid = b.frame.style.gridTemplateColumns
    const gridRows = b.frame.style.gridTemplateRows
    fireEvent.click(floatingLauncher(b.frame)!)

    const dialog = floatingDialog(b.frame)
    expect(dialog).not.toBeNull()
    expect(dialog?.hasAttribute('aria-modal')).toBe(false)
    expect(launcherVisible(b.frame)).toBe(false)
    expect(dialog?.contains(center)).toBe(true)
    expect(center.closest('[inert]')).toBeNull()
    expect(b.frame.querySelectorAll('[data-testid="center-content"]')).toHaveLength(1)
    expect(b.frame.querySelectorAll('textarea[aria-label="测试会话草稿"]')).toHaveLength(1)
    expect(b.getByTestId('center-content')).toBe(center)
    expect(b.getByRole('textbox', { name: '测试会话草稿' })).toBe(textarea)
    expect(textarea.value).toBe('未发送的草稿')
    expect(b.frame.style.gridTemplateColumns).toBe(grid)
    expect(b.frame.style.gridTemplateRows).toBe(gridRows)

    const launcher = floatingLauncher(b.frame)!
    fireEvent.click(b.getByRole('button', { name: '收起悬浮对话' }))
    expect(floatingDialog(b.frame)).toBeNull()
    expect(document.activeElement).toBe(launcher)
    expect(b.getByTestId('center-content')).toBe(center)
    expect(textarea.value).toBe('未发送的草稿')
    expect(center.closest('[inert]')).not.toBeNull()
    expect(floatingLauncher(b.frame)?.getAttribute('aria-expanded')).toBe('false')

    act(() => { b.instance.actions.toggleWorkbenchFullscreen('s-test') })
    expect(launcherVisible(b.frame)).toBe(false)
    expect(b.getByTestId('center-content')).toBe(center)
    expect(textarea.value).toBe('未发送的草稿')
    expect(center.closest('[inert]')).toBeNull()

    act(() => { b.instance.actions.toggleWorkbenchFullscreen('s-test') })
    fireEvent.click(floatingLauncher(b.frame)!)
    expect(floatingDialog(b.frame)).not.toBeNull()
    act(() => { b.instance.actions.toggleWorkbenchFullscreen('s-test') })
    expect(floatingDialog(b.frame)).toBeNull()
    act(() => { b.instance.actions.toggleWorkbenchFullscreen('s-test') })
    expect(launcherVisible(b.frame)).toBe(true)
    expect(floatingLauncher(b.frame)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses the same capsule on narrow screens and leaves the terminal bottom row untouched', () => {
    frameWidth = 768
    const b = mountFrame()
    act(() => {
      b.instance.actions.openWorkbench('s-test')
      b.instance.actions.toggleWorkbenchBottom('s-test')
    })
    expect(b.frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(launcherVisible(b.frame)).toBe(true)
    const before = [b.frame.style.gridTemplateColumns, b.frame.style.gridTemplateRows]
    expect(rows(b.frame)).toBe(260)
    expect(b.frame.style.getPropertyValue('--layout-sidebar-width')).toBe(`${SIDEBAR_COLLAPSED}px`)
    expect(b.frame.style.getPropertyValue('--layout-bottom-height')).toBe('260px')
    fireEvent.click(floatingLauncher(b.frame)!)
    expect(floatingDialog(b.frame)).not.toBeNull()
    expect([b.frame.style.gridTemplateColumns, b.frame.style.gridTemplateRows]).toEqual(before)
    expect(b.frame.style.getPropertyValue('--layout-bottom-height')).toBe('260px')
    expect(b.ownerFor('workbench.bottom')).toEqual({ sessionId: 's-test', shown: true })
    expect(b.getByTestId('bottom-content').parentElement?.hasAttribute('inert')).toBe(false)
  })

  it('resets the window when the selected session, page, or workbench context changes', () => {
    const b = mountFrame({ workspaceKeyOf: () => 'shared-workspace' })
    act(() => {
      b.instance.actions.openWorkbench('shared-workspace')
      b.instance.actions.toggleWorkbenchFullscreen('shared-workspace')
    })
    fireEvent.click(floatingLauncher(b.frame)!)
    expect(floatingDialog(b.frame)).not.toBeNull()

    selectedSession.current = 's-next' as SessionId
    act(() => { b.rerenderFrame() })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(floatingLauncher(b.frame)?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(floatingLauncher(b.frame)!)
    expect(floatingDialog(b.frame)).not.toBeNull()

    act(() => { b.instance.actions.openPage('image-gallery', 's-next' as SessionId) })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(launcherVisible(b.frame)).toBe(false)
    act(() => { b.instance.actions.closePage() })
    expect(floatingLauncher(b.frame)?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(floatingLauncher(b.frame)!)
    act(() => { b.instance.actions.closeWorkbench('shared-workspace') })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(launcherVisible(b.frame)).toBe(false)
  })

  it('lets an expanded trigger dismiss its controlled portal region before minimizing', () => {
    const b = mountFrame({ controlledRegion: true })
    act(() => {
      b.instance.actions.openWorkbench('s-test')
      b.instance.actions.toggleWorkbenchFullscreen('s-test')
    })
    const launcher = floatingLauncher(b.frame)!
    fireEvent.click(launcher)
    const dialog = floatingDialog(b.frame)
    const trigger = b.getByRole('button', { name: '协作详情' })
    fireEvent.click(trigger)
    trigger.focus()
    const region = b.getByRole('region', { name: '内部协作弹层' })
    expect(dialog?.contains(region)).toBe(false)

    fireEvent.keyDown(trigger, { key: 'Escape', cancelable: true })
    expect(b.queryByRole('region', { name: '内部协作弹层' })).toBeNull()
    expect(floatingDialog(b.frame)).toBe(dialog)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.keyDown(trigger, { key: 'Escape', cancelable: true })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(document.activeElement).toBe(launcher)
  })

  it('honors a nested Escape dismissal before minimizing; an unclaimed Escape returns focus to the launcher', async () => {
    const b = mountFrame()
    act(() => {
      b.instance.actions.openWorkbench('s-test')
      b.instance.actions.toggleWorkbenchFullscreen('s-test')
    })
    const launcher = floatingLauncher(b.frame)!
    fireEvent.click(launcher)
    expect(document.activeElement).toBe(b.getByRole('button', { name: '收起悬浮对话' }))
    const textarea = b.getByRole('textbox', { name: '测试会话草稿' })
    b.consumeEscape.current = true
    fireEvent.keyDown(textarea, { key: 'Escape', cancelable: true })
    expect(floatingDialog(b.frame)).not.toBeNull()

    b.consumeEscape.current = false
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Escape', cancelable: true }) })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(document.activeElement).toBe(launcher)
  })

  it.each([
    { mode: 'inline-anchor' as const, focus: 'anchor' },
    { mode: 'portal-item' as const, focus: 'menuitem' },
  ])('closes a real $mode Menu on Escape from its $focus before minimizing the conversation', async ({ mode }) => {
    const b = mountFrame({ menuMode: mode })
    act(() => {
      b.instance.actions.openWorkbench('s-test')
      b.instance.actions.toggleWorkbenchFullscreen('s-test')
    })
    const launcher = floatingLauncher(b.frame)!
    fireEvent.click(launcher)
    const dialog = floatingDialog(b.frame)
    const anchor = b.getByRole('button', { name: '内部菜单' })
    fireEvent.click(anchor)
    expect(b.getByRole('menu')).toBeTruthy()
    const firstTarget = mode === 'portal-item' ? b.getByRole('menuitem', { name: '菜单选项' }) : anchor
    if (mode === 'inline-anchor') anchor.focus()
    expect(document.activeElement).toBe(firstTarget)
    fireEvent.keyDown(firstTarget, { key: 'Escape', cancelable: true })
    expect(b.queryByRole('menu')).toBeNull()
    expect(floatingDialog(b.frame)).toBe(dialog)

    anchor.focus()
    await act(async () => { fireEvent.keyDown(anchor, { key: 'Escape', cancelable: true }) })
    expect(floatingDialog(b.frame)).toBeNull()
    expect(document.activeElement).toBe(launcher)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('restores rail panel controls when a blank Session workbench covers the welcome page', () => {
    frameWidth = 768
    selectedSessionBlank.current = true
    const { frame, instance, ownerFor } = mountFrame()
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: true })

    act(() => { instance.actions.openWorkbench('s-test') })
    expect(frame.hasAttribute('data-workbench-fullscreen')).toBe(true)
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: false })

    act(() => { instance.actions.closeWorkbench('s-test') })
    expect(ownerFor('sidebar')).toMatchObject({ welcomeActionsVisible: true })
  })

  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({
      collapsed: true, width: SIDEBAR_COLLAPSED, welcomeActionsVisible: false,
    })
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
      instance.actions.openWorkbench('s-test')
      instance.actions.toggleWorkbenchBottom('s-test')
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
