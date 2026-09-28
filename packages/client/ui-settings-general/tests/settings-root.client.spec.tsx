// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

afterEach(cleanup)

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

function mount({
  wide = true,
  onboardingActive = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
    { id: 'plugins', order: 30, label: 'Plugins' },
  ],
  steps = [
    { id: 'first-step', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: { wide?: boolean; onboardingActive?: boolean; rows?: Row[]; steps?: Step[] } = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
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

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('SettingsRoot trigger', () => {
  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })
})

describe('SettingsPanel chrome seats', () => {
  it('portals the entire panel to body so sidebar ancestors cannot clip the mobile dialog', () => {
    const { view } = mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(view.container.contains(dialog)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via a mask click', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via document-level Escape and unhooks the listener with the panel', () => {
    mount()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // 关闭后监听器随面板卸载；打开时非 Escape 按键不触发关闭。
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('leaves the settings panel open when a nested picker owns Escape', () => {
    mount()
    openPanel()
    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('aria-modal', 'true')
    document.body.append(nested)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
    nested.remove()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('button', { name: 'Agent presets' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'vision-understanding', order: 15, label: 'Image recognition' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'contributed', order: 40, label: 'Contributed' },
      ],
    })
    openPanel()
    // 图标本身不携带分区 id，以实际绘制的图形区分。
    const glyphs = ['General', 'Models', 'Image recognition', 'Agent presets', 'Plugins', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // 四个特定分区拥有独立图标，其余分区使用通用设置图标。
    expect(new Set(glyphs.slice(0, 5)).size).toBe(5)
    expect(glyphs[5]).toBe(glyphs[0])
  })

  it('keeps the ordinary section dialog and navigation mounted while switching content', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const nav = screen.getByRole('navigation')
    const general = screen.getByRole('button', { name: 'General' })
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    expect(screen.getByRole('button', { name: 'Plugins' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-plugins')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('navigation')).toBe(nav)
    expect(screen.getByRole('button', { name: 'General' })).toBe(general)
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the settings navigation and dialog semantics when entering and leaving Models', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog', { name: 'Settings Title' })
    const nav = screen.getByRole('navigation')
    const general = screen.getByRole('button', { name: 'General' })
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBe(dialog)
    expect(screen.getByRole('navigation')).toBe(nav)
    expect(screen.getByRole('button', { name: 'General' })).toBe(general)
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBe(close)
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    expect(screen.getByRole('navigation')).toBe(nav)
    expect(screen.getByRole('button', { name: 'General' })).toBe(general)
    expect(screen.getByTestId('section-general')).toBeTruthy()
    expect(screen.queryByTestId('section-models')).toBeNull()
  })

  it('opens image recognition as its own ordinary settings section', () => {
    mount({ rows: [
      { id: 'general', order: 0, label: 'General' },
      { id: 'models', order: 10, label: 'Models' },
      { id: 'vision-understanding', order: 15, label: 'Image recognition' },
    ] })
    openPanel()
    const dialog = screen.getByRole('dialog')
    const nav = screen.getByRole('navigation')
    fireEvent.click(screen.getByRole('button', { name: 'Image recognition' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('navigation')).toBe(nav)
    expect(screen.getByTestId('section-vision-understanding')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Image recognition' }).getAttribute('aria-current')).toBe('true')
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'first-step' })
    expect(first?.[2]).toEqual({ only: 'first-step' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByRole('dialog').className).not.toContain('modelsPanel')
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})
