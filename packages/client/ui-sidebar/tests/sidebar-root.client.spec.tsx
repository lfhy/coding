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
  const brandName = <span data-testid="custom-brand-name">Custom Brand</span>
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
        if (key === 'sidebar.brand.name') return brandName
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
  it('retains the sidebar toggle while omitting only duplicate workbench actions on the welcome page', () => {
    const b = mountShell({ welcomeActionsVisible: true })
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    expect(screen.queryByTestId('brand-action-seat')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(2)

    b.rerender({ collapsed: true, welcomeActionsVisible: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('brand-action-seat')).toBeNull()

    b.rerender({ welcomeActionsVisible: false })
    expect(screen.getByTestId('brand-action-seat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('routes New Session (capsule + wordmark) and the column toggle', () => {
    const b = mountShell()
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    // 品牌行动作洞渲染在品牌按钮与收起按钮之间，占用者拿到 wide。
    expect(b.brandActionOwner().wide).toBe(true)
    const actions = screen.getByTestId('brand-action-seat')
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(actions.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Expanded, both the wordmark and the capsule start a session.
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(2)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders generic brand fallbacks without build metadata when no package fills the slots', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    render(<SidebarRoot
      collapsed={false} width={300}
      welcomeActionsVisible={false}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.getByText('Coding')).toBeTruthy()
    expect(screen.queryByText('0123456')).toBeNull()
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // 品牌行动作与设置座位共用同一个 wide 标志。
    expect(b.brandActionOwner().wide).toBe(true)
    // The settings seat rides the same wide flag (ui-settings renders the row).
    expect(b.settingsOwner().wide).toBe(true)
    expect(b.footerActionOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
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
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
    expect(document.querySelector('img[src="/favicon.png"]')).toBeNull()
  })
})
