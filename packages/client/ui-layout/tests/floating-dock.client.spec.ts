import { describe, expect, it } from 'vitest'
import {
  clampFloatingPoint, floatingDockLeft, snapFloatingDock,
} from 'coding-client-ui-layout/src/client/floating-dock.ts'
import type { FloatingDock } from 'coding-client-ui-layout/src/client/floating-dock.ts'

const bounds = { left: 292, right: 1908, top: 12, bottom: 1068 }
const size = { width: 640, height: 700 }

describe('floating conversation geometry', () => {
  it('keeps every edge of a dragged window inside the usable area', () => {
    expect(clampFloatingPoint({ left: -100, top: -100 }, size, bounds))
      .toEqual({ left: 292, top: 12 })
    expect(clampFloatingPoint({ left: 3000, top: 3000 }, size, bounds))
      .toEqual({ left: 1268, top: 368 })
    expect(clampFloatingPoint({ left: 800, top: 100 }, size, bounds))
      .toEqual({ left: 800, top: 100 })
  })

  it('finds three distinct horizontal anchors and chooses the nearest release position', () => {
    expect((['left', 'center', 'right'] as const satisfies readonly FloatingDock[])
      .map(dock => floatingDockLeft(dock, size, bounds)))
      .toEqual([292, 780, 1268])
    expect(snapFloatingDock(300, size, bounds, 'center')).toBe('left')
    expect(snapFloatingDock(780, size, bounds, 'left')).toBe('center')
    expect(snapFloatingDock(1200, size, bounds, 'center')).toBe('right')
  })

  it('preserves the previous dock at exact midpoints rather than changing position unexpectedly', () => {
    expect(snapFloatingDock(536, size, bounds, 'left')).toBe('left')
    expect(snapFloatingDock(536, size, bounds, 'center')).toBe('center')
    expect(snapFloatingDock(1024, size, bounds, 'center')).toBe('center')
    expect(snapFloatingDock(1024, size, bounds, 'right')).toBe('right')
  })

  it('keeps the active dock when the available space is narrower than the floating window', () => {
    const narrow = { left: 68, right: 500, top: 12, bottom: 400 }
    expect(clampFloatingPoint({ left: 200, top: 200 }, size, narrow))
      .toEqual({ left: 68, top: 12 })
    expect(floatingDockLeft('left', size, narrow)).toBe(68)
    expect(floatingDockLeft('center', size, narrow)).toBe(68)
    expect(floatingDockLeft('right', size, narrow)).toBe(68)
    expect(snapFloatingDock(68, size, narrow, 'right')).toBe('right')
  })
})
