import { describe, expect, it } from 'vitest'
import { imageSourceByteLimits } from '../src/client/skeleton/image-intake.ts'

const limits = {
  maxImageBytes: 3_500_000,
  maxMessageImageBytes: 100_000_000,
  maxImagesPerMessage: 20,
  maxImagePixels: 4_000_000,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

describe('image intake safety limits', () => {
  it('uses source byte budgets independently of final normalized output budgets', () => {
    expect(imageSourceByteLimits({
      ...limits, maxSourceImageBytes: 100_000_000, maxSourceMessageImageBytes: 120_000_000,
    })).toEqual({ file: 100_000_000, message: 120_000_000 })
  })

  it('uses each legacy output byte limit for providers without the matching source field', () => {
    expect(imageSourceByteLimits(limits)).toEqual({ file: 3_500_000, message: 100_000_000 })
    expect(imageSourceByteLimits({ ...limits, maxSourceImageBytes: 80_000_000 }))
      .toEqual({ file: 80_000_000, message: 100_000_000 })
  })
})
