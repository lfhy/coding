import { describe, expect, it } from 'vitest'
import { fitBrowserViewport } from '../src/client/viewport.ts'

describe('browser pane viewport geometry', () => {
  it('uses the actual desktop and narrow pane sizes without window-width scaling', () => {
    expect(fitBrowserViewport(940, 620)).toEqual({ width: 940, height: 620 })
    expect(fitBrowserViewport(375, 680)).toEqual({ width: 375, height: 680 })
  })
  it('keeps oversized panes proportional within dimension and area limits', () => {
    const value = fitBrowserViewport(2400, 1400)!
    expect(value.width).toBeLessThanOrEqual(1920)
    expect(value.height).toBeLessThanOrEqual(1400)
    expect(value.width * value.height).toBeLessThanOrEqual(1_800_000)
    expect(Math.abs(value.width / value.height - 2400 / 1400)).toBeLessThan(.01)
  })
  it('clamps minimum bounds and skips hidden or invalid boxes', () => {
    expect(fitBrowserViewport(180, 210)).toEqual({ width: 200, height: 240 })
    expect(fitBrowserViewport(0, 600)).toBeNull()
    expect(fitBrowserViewport(Number.NaN, 600)).toBeNull()
    expect(fitBrowserViewport(Infinity, 600)).toBeNull()
  })
})
