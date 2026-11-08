import { SLIDE_SIZES } from 'coding-ppt-model'
import { describe, expect, it } from 'vitest'
import { fitWidth } from '../src/client/Stage.tsx'

describe('PPT 画布缩放', () => {
  it.each(['16:9', '4:3'] as const)('%s 小容器中画布宽高均不超出可用空间', (size) => {
    const { width, height } = SLIDE_SIZES[size]
    const ratio = width / height
    for (const box of [
      { width: 90, height: 120 },
      { width: 200, height: 120 },
      { width: 240, height: 90 },
    ]) {
      const fittedWidth = fitWidth(box, ratio)
      expect(fittedWidth).toBeGreaterThan(0)
      expect(fittedWidth).toBeLessThanOrEqual(box.width)
      expect(fittedWidth / ratio).toBeLessThanOrEqual(box.height)
    }
    expect(fitWidth({ width: 0, height: 0 }, ratio)).toBe(0)
  })
})
