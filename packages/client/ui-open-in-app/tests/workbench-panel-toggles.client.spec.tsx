// @vitest-environment jsdom
/** 会话页头面板开关跟随当前 Session 的布局投影，欢迎页维持独立入口。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  HeroPanelToggle, WorkbenchPanelToggles,
  type WorkbenchPanelTogglesProps,
} from '../src/client/WorkbenchPanelToggles.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'panel-toggles-session' as SessionId
const t: WorkbenchPanelTogglesProps['t'] = makeTranslate(zh)

/** 稳定的会话列表快照；`current`/`blank` 是本组件唯一读取的字段。 */
function sessionsStore(current: SessionId | undefined, blank = false) {
  return createSnapshotStore<SessionListState>({
    ids: current === undefined ? [] : [current],
    byId: current === undefined ? {} : { [current]: { id: current, blank } },
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState)
}

interface Bench {
  props: WorkbenchPanelTogglesProps
  toggleWorkbench: ReturnType<typeof vi.fn>
  toggleBottom: ReturnType<typeof vi.fn>
  source: ReturnType<typeof createSnapshotStore<WorkbenchLayoutSnapshot>>
  publish: (next: WorkbenchLayoutSnapshot) => void
}

/**
 * 工作台状态源：getSnapshot 返回的值来自 store 本身（身份稳定，只在 set 后替换），
 * 因此满足组件内 useSyncExternalStore 的快照契约。
 */
function workbenchSource(initial: WorkbenchLayoutSnapshot): Bench['source'] {
  return createSnapshotStore<WorkbenchLayoutSnapshot>(initial)
}

function bench(over: {
  current?: SessionId | undefined
  blank?: boolean
  workbench?: Partial<WorkbenchLayoutSnapshot>
} = {}): Bench {
  const current = 'current' in over ? over.current : SESSION
  const sessions = sessionsStore(current, over.blank ?? false)
  const source = workbenchSource({
    open: false,
    fullscreen: false,
    bottomOpen: false,
    filesOpen: true,
    ...over.workbench,
  })
  const toggleWorkbench = vi.fn()
  const toggleBottom = vi.fn()
  const props = {
    useSessions: bindSnapshotSelector(sessions),
    workbenchSource: (): ObservableSnapshot<WorkbenchLayoutSnapshot> => source,
    useWorkbenchLayout: bindSnapshotSelector(source),
    toggleWorkbench,
    toggleBottom,
    t,
  } as unknown as WorkbenchPanelTogglesProps
  return {
    props,
    toggleWorkbench,
    toggleBottom,
    source,
    publish: (next) => { source.set(next) },
  }
}

describe('会话页头的面板开关', () => {
  it('renders controls bound to its Session even when it is blank', () => {
    const b = bench({ blank: true })
    render(<WorkbenchPanelToggles {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.bottom.show'] }))
    expect(b.toggleBottom).toHaveBeenCalledOnce()
  })
})

describe('WorkbenchPanelToggles pressed state', () => {
  it('starts unpressed and delegates both toggles to the injected actions', () => {
    const b = bench()
    render(<WorkbenchPanelToggles {...b.props} />)
    const right = screen.getByRole('button', { name: zh['workbench.right.open'] })
    const bottom = screen.getByRole('button', { name: zh['workbench.bottom.show'] })
    expect(right.getAttribute('title')).toBe(zh['workbench.right.open'])
    expect(right.getAttribute('aria-pressed')).toBe('false')
    expect(bottom.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(right)
    fireEvent.click(bottom)
    expect(b.toggleWorkbench).toHaveBeenCalledOnce()
    expect(b.toggleBottom).toHaveBeenCalledOnce()
  })

  it('reflects the right sidebar independently of the file tree', () => {
    const closed = bench({ workbench: { open: false, filesOpen: true } })
    render(<WorkbenchPanelToggles {...closed.props} />)
    const closedRight = screen.getByRole('button', { name: zh['workbench.right.open'] })
    expect(closedRight.getAttribute('aria-pressed')).toBe('false')
    cleanup()

    const open = bench({ workbench: { open: true, filesOpen: false } })
    render(<WorkbenchPanelToggles {...open.props} />)
    const right = screen.getByRole('button', { name: zh['workbench.right.close'] })
    expect(right.getAttribute('title')).toBe(zh['workbench.right.close'])
    expect(right.getAttribute('aria-pressed')).toBe('true')
    expect(screen
      .getByRole('button', { name: zh['workbench.bottom.show'] })
      .getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(right)
    expect(open.toggleWorkbench).toHaveBeenCalledOnce()
  })

  it('reflects the standalone terminal while the right sidebar is closed', () => {
    const b = bench({ workbench: { open: false, bottomOpen: true } })
    render(<WorkbenchPanelToggles {...b.props} />)
    expect(screen
      .getByRole('button', { name: zh['workbench.bottom.hide'] })
      .getAttribute('aria-pressed')).toBe('true')
  })

  it('takes the pressed state from the snapshot the injected source holds', () => {
    const b = bench({ workbench: { open: true, filesOpen: true } })
    render(<WorkbenchPanelToggles {...b.props} />)
    expect(screen
      .getByRole('button', { name: zh['workbench.right.close'] })
      .getAttribute('aria-pressed')).toBe('true')

    act(() => { b.publish({ open: false, fullscreen: false, bottomOpen: false, filesOpen: true }) })
    expect(screen
      .getByRole('button', { name: zh['workbench.right.open'] })
      .getAttribute('aria-pressed')).toBe('false')
  })
})

describe('欢迎页面板入口', () => {
  it.each(['bottom', 'files'] as const)('%s 无会话仍可点击；空白会话打开后状态跟随布局投影', async (panel) => {
    const b = bench({ current: undefined })
    const togglePanel = vi.fn(async () => {})
    const props = { ...b.props, panel, togglePanel } as unknown as
      React.ComponentProps<typeof HeroPanelToggle>
    const view = render(<HeroPanelToggle {...props} />)
    const openLabel = panel === 'bottom' ? '显示终端底栏' : '打开右侧边栏'
    const closeLabel = panel === 'bottom' ? '隐藏终端底栏' : '收起右侧边栏'
    const open = view.getByRole('button', { name: openLabel })
    expect((open as HTMLButtonElement).disabled).toBe(false)
    expect(open.getAttribute('title')).toBe(openLabel)
    expect(open.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(open)
    await waitFor(() => { expect(togglePanel).toHaveBeenCalledOnce() })

    cleanup()
    const active = bench({ blank: true })
    const activeProps = { ...active.props, panel, togglePanel } as unknown as
      React.ComponentProps<typeof HeroPanelToggle>
    render(<HeroPanelToggle {...activeProps} />)
    act(() => { active.publish({ open: true, fullscreen: false, bottomOpen: panel === 'bottom', filesOpen: false }) })
    expect(screen.getByRole('button', { name: closeLabel }).getAttribute('aria-pressed')).toBe('true')
  })

  it.each(['bottom', 'files'] as const)('%s 创建会话失败时保持入口可重试并给出错误', async (panel) => {
    const b = bench({ current: undefined })
    const togglePanel = vi.fn(async () => { throw new Error('offline') })
    const props = { ...b.props, panel, togglePanel } as unknown as
      React.ComponentProps<typeof HeroPanelToggle>
    const view = render(<HeroPanelToggle {...props} />)
    const label = panel === 'bottom' ? '显示终端底栏' : '打开右侧边栏'
    fireEvent.click(view.getByRole('button', { name: label }))
    expect((await view.findByRole('alert')).textContent).toContain('offline')
    await waitFor(() => { expect((view.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false) })
  })
})
