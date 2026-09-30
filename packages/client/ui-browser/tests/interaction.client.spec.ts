import { describe, expect, it } from 'vitest'
import { pointOnFrame } from '../src/client/interaction.ts'

describe('screenshot interaction geometry', () => {
  const rect = { left: 150, top: 40, right: 790, bottom: 400, width: 640, height: 360 } as DOMRect
  const viewport = { width: 1280, height: 720 }
  it('maps a centered half-size screenshot into native viewport pixels', () => {
    expect(pointOnFrame(310, 220, rect, viewport)).toEqual({ x: 320, y: 360 })
    expect(pointOnFrame(789.9, 399.9, rect, viewport)).toEqual({ x: 1279, y: 719 })
  })
  it('rejects margins, non-finite positions and unlaid-out images', () => {
    expect(pointOnFrame(149, 200, rect, viewport)).toBeNull()
    expect(pointOnFrame(790, 200, rect, viewport)).toBeNull()
    expect(pointOnFrame(200, 400, rect, viewport)).toBeNull()
    expect(pointOnFrame(Number.NaN, 50, rect, viewport)).toBeNull()
    expect(pointOnFrame(200, 50, { left: 150, top: 40, right: 790, bottom: 400,
      width: 0, height: 360 } as DOMRect, viewport)).toBeNull()
  })
})
