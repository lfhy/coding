// @vitest-environment jsdom
/**
 * 侧边栏品牌行常驻面板开关：无会话或空白会话不渲染、关闭态按下态恒为 false、
 * 点击委托给注入的两个开关动作。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  WorkbenchPanelToggles,
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
  toggleFiles: ReturnType<typeof vi.fn>
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
  const toggleFiles = vi.fn()
  const toggleBottom = vi.fn()
  const props = {
    wide: true,
    useSessions: bindSnapshotSelector(sessions),
    workbenchSource: (): ObservableSnapshot<WorkbenchLayoutSnapshot> => source,
    toggleFiles,
    toggleBottom,
    t,
  } as unknown as WorkbenchPanelTogglesProps
  return {
    props,
    toggleFiles,
    toggleBottom,
    source,
    publish: (next) => { source.set(next) },
  }
}

describe('WorkbenchPanelToggles visibility', () => {
  it('renders nothing without a current session', () => {
    const b = bench({ current: undefined })
    const { container } = render(<WorkbenchPanelToggles {...b.props} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing while the current session is still blank', () => {
    const b = bench({ blank: true })
    const { container } = render(<WorkbenchPanelToggles {...b.props} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('WorkbenchPanelToggles pressed state', () => {
  it('starts unpressed and delegates both toggles to the injected actions', () => {
    const b = bench()
    render(<WorkbenchPanelToggles {...b.props} />)
    const files = screen.getByRole('button', { name: zh['workbench.files.show'] })
    const bottom = screen.getByRole('button', { name: zh['workbench.bottom.show'] })
    expect(files.getAttribute('aria-pressed')).toBe('false')
    expect(bottom.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(files)
    fireEvent.click(bottom)
    expect(b.toggleFiles).toHaveBeenCalledOnce()
    expect(b.toggleBottom).toHaveBeenCalledOnce()
  })

  it('reflects the file sidebar only while the workbench is open', () => {
    const closed = bench({ workbench: { open: false, filesOpen: true } })
    render(<WorkbenchPanelToggles {...closed.props} />)
    // 关闭态下即使布局保留了 filesOpen，按下态也必须为 false，入口文案仍是「显示文件侧栏」。
    const closedFiles = screen.getByRole('button', { name: zh['workbench.files.show'] })
    expect(closedFiles.getAttribute('aria-pressed')).toBe('false')
    cleanup()

    const open = bench({ workbench: { open: true, filesOpen: true } })
    render(<WorkbenchPanelToggles {...open.props} />)
    const files = screen.getByRole('button', { name: zh['workbench.files.hide'] })
    expect(files.getAttribute('aria-pressed')).toBe('true')
    expect(screen
      .getByRole('button', { name: zh['workbench.bottom.show'] })
      .getAttribute('aria-pressed')).toBe('false')
  })

  it('reflects the terminal panel only while the workbench is open', () => {
    const open = bench({ workbench: { open: true, bottomOpen: true } })
    render(<WorkbenchPanelToggles {...open.props} />)
    expect(screen
      .getByRole('button', { name: zh['workbench.bottom.hide'] })
      .getAttribute('aria-pressed')).toBe('true')
  })

  it('takes the pressed state from the snapshot the injected source holds', () => {
    const b = bench({ workbench: { open: true, filesOpen: true } })
    render(<WorkbenchPanelToggles {...b.props} />)
    expect(screen
      .getByRole('button', { name: zh['workbench.files.hide'] })
      .getAttribute('aria-pressed')).toBe('true')

    // 组件只读取源当前持有的快照；源改回关闭文件侧栏后重新渲染即回到未按下。
    b.publish({ open: true, fullscreen: false, bottomOpen: false, filesOpen: false })
    cleanup()
    render(<WorkbenchPanelToggles {...b.props} />)
    expect(screen
      .getByRole('button', { name: zh['workbench.files.show'] })
      .getAttribute('aria-pressed')).toBe('false')
  })
})
