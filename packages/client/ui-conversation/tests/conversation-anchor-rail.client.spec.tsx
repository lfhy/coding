// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationAnchorRailProps } from '../src/client/chat/ConversationAnchorRail.tsx'
import { ConversationAnchorRail } from '../src/client/chat/ConversationAnchorRail.tsx'
import css from '../src/client/chat/ConversationAnchorRail.module.css'

function style(name: string): string {
  const className = css[name]
  if (className === undefined) throw new Error(`Missing anchor rail style: ${name}`)
  return className
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const marks = [
  { key: 'first', title: 'First prompt', preview: 'Check the first answer' },
  { key: 'second', title: 'Second prompt', preview: 'Review the second answer' },
  { key: 'third', title: 'Third prompt', preview: 'Check the third answer' },
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

  it('does not show a desktop rail for one mark, but keeps the compact list available', () => {
    const { rerender } = rail({ marks: marks.slice(0, 1), activeKey: 'first' })
    expect(screen.queryByRole('navigation')).toBeNull()
    rerender(<ConversationAnchorRail marks={marks.slice(0, 1)} activeKey="first" trackHeight={400} compact onJump={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse conversation anchors' }))
    expect(screen.getByRole('button', { name: '1/1: First prompt' })).toBeTruthy()
  })

  it('shows a centered 10px-pitch rail with the current location and a viewport-clamped preview', () => {
    rail()
    const navigation = screen.getByRole('navigation', { name: 'Conversation anchors' })
    const first = screen.getByRole('button', { name: '1/3: First prompt' })
    const second = screen.getByRole('button', { name: '2/3: Second prompt' })
    const rows = navigation.querySelectorAll(`.${style('mark')}`)
    expect(rows).toHaveLength(3)
    expect([...rows].every(row => row.parentElement?.classList.contains(style('railScroll')))).toBe(true)
    expect(first.style.top).toBe('')
    expect(second.style.top).toBe('')
    expect(navigation.querySelector(`.${style('track')}`)?.getAttribute('style')).toContain('height: 400px')
    expect(navigation.querySelector('[aria-current="location"]')).toBe(second)
    expect(second.tabIndex).toBe(0)
    expect(first.tabIndex).toBe(-1)
    expect(screen.queryByRole('tooltip')).toBeNull()

    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 200, width: 36, height: 10, top: 200, right: window.innerWidth - 4,
      bottom: 210, left: 0, toJSON: () => ({}),
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(style('previewCard')) ? 320 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(style('previewCard')) ? 120 : 0
    })
    fireEvent.mouseEnter(first)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(navigation)
    expect(tooltip.parentElement).not.toBe(first.parentElement)
    expect(tooltip.style.left).toBe(`${window.innerWidth - 336}px`)
    expect(tooltip.style.top).toBe('145px')
    expect(tooltip.textContent).toContain('Check the first answer')
    expect(first.getAttribute('aria-describedby')).toBe('conversation-anchor-preview')
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

  it('magnifies the hovered or focused mark and its nearest neighbors without enlarging scroll-active alone', () => {
    rail()
    const first = screen.getByRole('button', { name: '1/3: First prompt' })
    const second = screen.getByRole('button', { name: '2/3: Second prompt' })
    const third = screen.getByRole('button', { name: '3/3: Third prompt' })
    expect(second.classList.contains(style('markActive'))).toBe(true)
    expect(second.classList.contains(style('markFocused'))).toBe(false)
    fireEvent.mouseEnter(first)
    expect(first.classList.contains(style('markFocused'))).toBe(true)
    expect(second.classList.contains(style('markActive'))).toBe(false)
    expect(second.querySelector('span')?.classList.contains(style('tickNear'))).toBe(true)
    expect(third.querySelector('span')?.classList.contains(style('tickMid'))).toBe(true)
    fireEvent.mouseLeave(first)
    expect(second.querySelector('span')?.classList.contains(style('tickNear'))).toBe(false)
    fireEvent.focus(third)
    expect(third.classList.contains(style('markFocused'))).toBe(true)
    third.focus()
    const viewport = third.parentElement as HTMLElement
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect)
    const rect = vi.spyOn(third, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 30 } as DOMRect)
    fireEvent.scroll(third.parentElement as HTMLElement)
    expect(third.classList.contains(style('markFocused'))).toBe(true)
    expect(screen.getByRole('tooltip').textContent).toContain('Third prompt')
    rect.mockReturnValue({ top: 120, bottom: 130 } as DOMRect)
    fireEvent.scroll(viewport)
    expect(third.classList.contains(style('markFocused'))).toBe(false)
    expect(second.classList.contains(style('markActive'))).toBe(true)
    expect(screen.queryByRole('tooltip')).toBeNull()
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

  it('scrolls only the narrow rail to the active dense mark and preserves navigation', () => {
    const denseMarks = Array.from({ length: 88 }, (_, index) => ({
      key: `prompt-${index}`, title: `Prompt ${index}`, preview: `Preview ${index}`,
    }))
    const { onJump, rerender, container } = rail({ marks: denseMarks, trackHeight: 700, activeKey: denseMarks[40]!.key })
    const button = screen.getByRole('button', { name: '41/88: Prompt 40' })
    const scroll = container.querySelector(`.${style('railScroll')}`) as HTMLDivElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 })
    rerender(<ConversationAnchorRail
      marks={denseMarks} activeKey={denseMarks[70]!.key} trackHeight={700}
      compact={false} onJump={onJump} t={t}
    />)
    expect(scroll.scrollTop).toBe(605)
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 120 })
    rerender(<ConversationAnchorRail
      marks={denseMarks} activeKey={denseMarks[70]!.key} trackHeight={400}
      compact={false} onJump={onJump} t={t}
    />)
    expect(scroll.scrollTop).toBe(645)
    expect(scroll.querySelectorAll('button')).toHaveLength(88)
    button.focus()
    fireEvent.click(button)
    expect(onJump).toHaveBeenCalledExactlyOnceWith('prompt-40')
  })
})
