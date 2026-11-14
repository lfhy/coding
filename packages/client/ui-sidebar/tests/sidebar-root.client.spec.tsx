// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type {
  SidebarTopEntryOwnerProps, SidebarFooterActionOwnerProps, SidebarRootComponentProps,
  SidebarSectionOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

// English-dictionary translate stub: the shell renders the same copy the
// assertions below query by accessible name.
const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never

function mountShell({ collapsed = false, width = 300, welcomeActionsVisible = false }:
{ collapsed?: boolean; width?: number; welcomeActionsVisible?: boolean } = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  let topEntryOwner: SidebarTopEntryOwnerProps | undefined
  let regionOwner: SidebarSectionOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let current = { collapsed, width, welcomeActionsVisible }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      welcomeActionsVisible={current.welcomeActionsVisible}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar} t={t}
      showConversation={vi.fn()} usePage={selector => selector(null)}
      renderSlot={((
        key: string,
        owner: SidebarTopEntryOwnerProps | SidebarFooterActionOwnerProps
          | SidebarSectionOwnerProps,
      ) => {
        if (key === 'sidebar.top.entry') {
          topEntryOwner = owner
          return <div data-testid="top-entry-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    topEntryOwner: () => {
      if (topEntryOwner === undefined) throw new Error('top entry owner not rendered')
      return topEntryOwner
    },
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('keeps the optional entry on welcome and orders it before the rail toggle', () => {
    vi.useFakeTimers()
    const b = mountShell({ welcomeActionsVisible: true })
    expect(screen.getByTestId('top-entry-seat')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New chat' })).toHaveLength(1)

    // 展开态不渲染任何收起按钮；落定到 rail 后才出现展开入口。
    b.rerender({ collapsed: true, welcomeActionsVisible: true })
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
    vi.advanceTimersByTime(200)
    b.rerender({})
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    const entry = screen.getByTestId('top-entry-seat')
    const starter = screen.getByRole('button', { name: 'New chat' })
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    expect(starter.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(entry.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle.compareDocumentPosition(screen.getByTestId('region')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    b.rerender({ welcomeActionsVisible: false })
    expect(screen.getByTestId('top-entry-seat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('routes the New chat entry and hands the collapse action to the browsing region', () => {
    const b = mountShell()
    // 可选入口在新对话之后、浏览区域之前，占用者拿到 wide。
    expect(b.topEntryOwner().wide).toBe(true)
    const actions = screen.getByTestId('top-entry-seat')
    const starter = screen.getByRole('button', { name: 'New chat' })
    expect(actions.compareDocumentPosition(starter) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(actions.compareDocumentPosition(screen.getByTestId('region')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(starter)
    expect(b.startSession).toHaveBeenCalledOnce()
    // 宽侧栏不再自带收起按钮，收起动作交给浏览区域的标题行。
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
    b.regionOwner().collapseSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders no brand wordmark in the New chat row', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    render(<SidebarRoot
      collapsed={false} width={300}
      welcomeActionsVisible={false}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      showConversation={vi.fn()} usePage={selector => selector(null)}
      renderSlot={((
        _key: string,
        _owner: unknown,
        options?: { fallback?: ReactNode },
      ) => options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.queryByText('Coding')).toBeNull()
    expect(screen.queryByText('0123456')).toBeNull()
  })

  it('hands the region its wide flag and clamps both toggle requests to their own state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // 可选入口与浏览区域共用同一个 wide 标志。
    expect(b.topEntryOwner().wide).toBe(true)
    expect(b.footerActionOwner().wide).toBe(true)
    // 已展开：展开请求是空操作，收起请求生效。
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
    b.regionOwner().collapseSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window, then settles into the rail.
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    expect(b.topEntryOwner().wide).toBe(false)
    expect(b.footerActionOwner().wide).toBe(false)
    expect(screen.getByTestId('region')).toBeTruthy()
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    // 已收起：收起请求不再反转成展开。
    b.regionOwner().collapseSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
    expect(document.querySelector('img[src="/favicon.png"]')).toBeNull()
  })
})
