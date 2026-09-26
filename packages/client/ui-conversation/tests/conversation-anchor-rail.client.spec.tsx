// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationAnchorRailProps } from '../src/client/chat/ConversationAnchorRail.tsx'
import { ConversationAnchorRail } from '../src/client/chat/ConversationAnchorRail.tsx'

afterEach(cleanup)

const marks = [
  { key: 'first', title: 'First prompt', preview: 'Check the first answer', position: 24 },
  { key: 'second', title: 'Second prompt', preview: 'Review the second answer', position: 190 },
  { key: 'third', title: 'Third prompt', preview: 'Check the third answer', position: 310 },
] as const

const t = ((key: string, values?: Record<string, string | number>) => {
  if (key === 'chat.anchors.position') return `${values?.current}/${values?.total}: ${values?.title}`
  return {
    'chat.anchors.label': 'Conversation anchors',
    'chat.anchors.compact': 'Browse conversation anchors',
    'chat.anchors.close': 'Close anchors',
  }[key] ?? key
}) as ConversationAnchorRailProps['t']

function rail(overrides: Partial<ConversationAnchorRailProps> = {}) {
  const onJump = vi.fn()
  const view = render(<ConversationAnchorRail
    marks={marks}
    activeKey="second"
    trackHeight={400}
    compact={false}
    onJump={onJump}
    t={t}
    {...overrides}
  />)
  return { ...view, onJump }
}

describe('ConversationAnchorRail', () => {
  it('does not occupy or announce an empty rail', () => {
    const { container } = rail({ marks: [] })
    expect(container.innerHTML).toBe('')
  })

  it('shows measured marks with the current location and a hover/focus preview', () => {
    rail()
    const navigation = screen.getByRole('navigation', { name: 'Conversation anchors' })
    const first = screen.getByRole('button', { name: '1/3: First prompt' })
    const second = screen.getByRole('button', { name: '2/3: Second prompt' })
    expect(first.style.top).toBe('24px')
    expect(first.style.height).toBe('18px')
    expect(second.style.top).toBe('190px')
    expect(navigation.querySelector('[aria-current="location"]')).toBe(second)
    expect(second.tabIndex).toBe(0)
    expect(first.tabIndex).toBe(-1)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(first)
    expect(screen.getByRole('tooltip').textContent).toContain('Check the first answer')
    fireEvent.mouseLeave(first)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(first)
    expect(screen.getByRole('tooltip').textContent).toContain('First prompt')
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('jumps on click and traverses the marks with arrow and boundary keys', () => {
    const { onJump } = rail()
    const first = screen.getByRole('button', { name: '1/3: First prompt' })
    const second = screen.getByRole('button', { name: '2/3: Second prompt' })
    const third = screen.getByRole('button', { name: '3/3: Third prompt' })
    second.focus()
    fireEvent.keyDown(second, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(third)
    fireEvent.click(third)
    expect(onJump).toHaveBeenCalledExactlyOnceWith('third')
  })

  it('opens a compact touch list, jumps, and dismisses it with Escape or close', () => {
    const { onJump } = rail({ compact: true })
    expect(screen.queryByRole('navigation')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Browse conversation anchors' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Review the second answer')).toBeTruthy()
    expect(screen.getByRole('button', { name: '2/3: Second prompt' }).getAttribute('aria-current')).toBe('location')
    const second = screen.getByRole('button', { name: '2/3: Second prompt' })
    second.focus()
    fireEvent.keyDown(second, { key: 'Escape' })
    expect(screen.queryByText('Review the second answer')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    const close = screen.getByRole('button', { name: 'Close anchors' })
    close.focus()
    fireEvent.click(close)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    const first = screen.getByRole('button', { name: '1/3: First prompt' })
    first.focus()
    fireEvent.click(first)
    expect(onJump).toHaveBeenCalledExactlyOnceWith('first')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('shrinks dense mark hitboxes to their allocated spacing without losing navigation', () => {
    const denseMarks = Array.from({ length: 88 }, (_, index) => ({
      key: `prompt-${index}`, title: `Prompt ${index}`, preview: `Preview ${index}`,
      position: 8 + index * ((700 - 16) / 87),
    }))
    const { onJump } = rail({ marks: denseMarks, trackHeight: 700, activeKey: denseMarks[40]!.key })
    const button = screen.getByRole('button', { name: '41/88: Prompt 40' })
    expect(Number.parseInt(button.style.height, 10)).toBeLessThanOrEqual(9)
    button.focus()
    fireEvent.click(button)
    expect(onJump).toHaveBeenCalledExactlyOnceWith('prompt-40')
  })
})
