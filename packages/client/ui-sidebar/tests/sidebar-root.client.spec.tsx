// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type {
  SidebarBrandActionOwnerProps, SidebarFooterActionOwnerProps, SidebarRootComponentProps,
  SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
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
  let brandActionOwner: SidebarBrandActionOwnerProps | undefined
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let current = { collapsed, width, welcomeActionsVisible }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      welcomeActionsVisible={current.welcomeActionsVisible}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar} t={t}
      renderSlot={((
        key: string,
        owner: SidebarBrandActionOwnerProps | SidebarFooterActionOwnerProps
          | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.brand.action') {
          brandActionOwner = owner
          return <div data-testid="brand-action-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
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
    brandActionOwner: () => {
      if (brandActionOwner === undefined) throw new Error('brand action owner not rendered')
      return brandActionOwner
    },
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
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
  it('omits only duplicate workbench actions on the welcome page and keeps the rail toggle', () => {
    vi.useFakeTimers()
    const b = mountShell({ welcomeActionsVisible: true })
    expect(screen.queryByTestId('brand-action-seat')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'New chat' })).toHaveLength(1)

    // 展开态不渲染任何收起按钮；落定到 rail 后才出现展开入口。
    b.rerender({ collapsed: true, welcomeActionsVisible: true })
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
    vi.advanceTimersByTime(200)
    b.rerender({})
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('brand-action-seat')).toBeNull()

    b.rerender({ welcomeActionsVisible: false })
    expect(screen.getByTestId('brand-action-seat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('routes the New chat entry and hands the collapse action to the browsing region', () => {
    const b = mountShell()
    // 新对话行内的动作洞渲染在新对话入口之后，占用者拿到 wide。
    expect(b.brandActionOwner().wide).toBe(true)
    const actions = screen.getByTestId('brand-action-seat')
    const starter = screen.getByRole('button', { name: 'New chat' })
    expect(actions.compareDocumentPosition(starter) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    fireEvent.click(starter)
    expect(b.startSession).toHaveBeenCalledOnce()
    // 宽侧栏不再自带收起按钮，收起动作交给浏览区域的标题行。
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
    b.regionOwner().collapseSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('seats Settings directly under the New chat row and leaves footer actions at the foot', () => {
    const b = mountShell()
    const starter = screen.getByRole('button', { name: 'New chat' })
    const seat = screen.getByTestId('settings-seat')
    const region = screen.getByTestId('region')
    const footer = screen.getByTestId('footer-action-seat')
    // 设置座位紧跟新对话行；浏览区域与仅有的页脚动作都排在它之后。
    expect(starter.compareDocumentPosition(seat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(seat.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(region.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(b.settingsOwner().wide).toBe(true)
  })

  it('renders no brand wordmark in the New chat row', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    render(<SidebarRoot
      collapsed={false} width={300}
      welcomeActionsVisible={false}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
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
    // 品牌行动作与设置座位共用同一个 wide 标志。
    expect(b.brandActionOwner().wide).toBe(true)
    // 设置座位跟随同一个 wide 标志（ui-settings 渲染对应行）。
    expect(b.settingsOwner().wide).toBe(true)
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
    expect(b.brandActionOwner().wide).toBe(false)
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
