// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

afterEach(cleanup)

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Back',
}

function mount({
  wide = true,
  onboardingActive = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'plugins', order: 30, label: 'Plugins' },
  ],
  steps = [
    { id: 'first-step', order: -100 },
    { id: 'credential', order: 0 },
  ],
  section,
}: { wide?: boolean; onboardingActive?: boolean; rows?: Row[]; steps?: Step[]; section?: () => ReactNode } = {}) {
  let current = rows
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return section?.() ?? <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : { phase: 'ready', current: 'active-session', byId: { 'active-session': { blank: false } } })) as never
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useSessions,
    useWorkspaces: unusedHook,
    wide,
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners }
}

function openPage() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  return screen.getByRole('main', { name: 'Settings Title' })
}

describe('SettingsRoot page', () => {
  it('keeps the trigger seat accessible and passes the rail state', () => {
    const { renderSlot } = mount({ wide: false })
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    openPage()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('portals a full-page main outside the sidebar, with no dialog, mask, or unreachable X', () => {
    const { view, renderSlot } = mount()
    const page = openPage()
    expect(page.parentElement).toBe(document.body)
    expect(view.container.contains(page)).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
    expect(screen.getByRole('button', { name: 'Back' }).querySelector('svg')).toBeTruthy()
  })

  it('returns by the top-left back button and restores focus and app interactivity', () => {
    const { view } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    const originalInert = view.container.inert
    trigger.focus()
    openPage()
    expect(view.container.inert).toBe(true)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(document.activeElement).toBe(back)
    fireEvent.click(back)
    expect(screen.queryByRole('main', { name: 'Settings Title' })).toBeNull()
    expect(view.container.inert).toBe(originalInert)
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves non-HTMLElement body children untouched while restoring inert siblings', () => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.append(icon)
    try {
      const { view } = mount()
      const initialInert = view.container.inert
      openPage()
      expect(view.container.inert).toBe(true)
      expect(icon.hasAttribute('inert')).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(view.container.inert).toBe(initialInert)
      expect(icon.hasAttribute('inert')).toBe(false)
    } finally {
      icon.remove()
    }
  })

  it('restores pre-existing inert state when unmounted', () => {
    const { view } = mount()
    view.container.inert = true
    openPage()
    view.unmount()
    expect(view.container.inert).toBe(true)
    view.container.inert = false
  })

  it('keeps a portaled nested modal reachable and lets it consume Escape first', () => {
    function Section() {
      const [open, setOpen] = useState(true)
      return <Modal open={open} title="Model editor" onClose={() => { setOpen(false) }} trapFocus>
        <button type="button">Edit model</button>
      </Modal>
    }
    const { view } = mount({ section: () => <Section /> })
    const page = openPage()
    const dialog = screen.getByRole('dialog', { name: 'Model editor' })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(dialog.parentElement?.inert).not.toBe(true)
    expect(page.contains(dialog)).toBe(false)
    expect(view.container.inert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Edit model' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('main', { name: 'Settings Title' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('main', { name: 'Settings Title' })).toBeNull()
  })

  it('closes via Escape but not another key or while a nested modal or menu is open', () => {
    mount()
    openPage()
    fireEvent.keyDown(document, { key: 'Enter' })
    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('aria-modal', 'true')
    document.body.append(nested)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('main', { name: 'Settings Title' })).toBeTruthy()
    nested.remove()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'listbox')
    document.body.append(menu)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('main', { name: 'Settings Title' })).toBeTruthy()
    menu.remove()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('main', { name: 'Settings Title' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
  })

  it('projects navigation, switches sections without remounting the page, and falls back on removal', () => {
    const { bump } = mount()
    const page = openPage()
    const nav = screen.getByRole('navigation')
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-general')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.getByRole('main')).toBe(page)
    expect(screen.getByRole('navigation')).toBe(nav)
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('provides distinct icons for known sections and a fallback icon for contributed sections', () => {
    mount({ rows: [
      { id: 'general', order: 0, label: 'General' },
      { id: 'models', order: 10, label: 'Models' },
      { id: 'vision-understanding', order: 15, label: 'Image recognition' },
      { id: 'agent-presets', order: 20, label: 'Agent presets' },
      { id: 'plugins', order: 30, label: 'Plugins' },
      { id: 'contributed', order: 40, label: 'Contributed' },
    ] })
    openPage()
    const glyphs = ['General', 'Models', 'Image recognition', 'Agent presets', 'Plugins', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)
    expect(new Set(glyphs.slice(0, 5)).size).toBe(5)
    expect(glyphs[5]).toBe(glyphs[0])
  })

  it('renders an empty section column and releases the ledger subscription on unmount', () => {
    const { view, renderSlot, listeners } = mount({ rows: [] })
    openPage()
    expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.section')).toHaveLength(0)
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('mounts one onboarding step at a time and opens its requested settings section', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'first-step' })
    act(() => { (first?.[1] as { complete: () => void }).complete() })
    const second = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding').at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    act(() => { (second?.[1] as { openSection: (id: string) => void }).openSection('models') })
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }))
    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })
})
