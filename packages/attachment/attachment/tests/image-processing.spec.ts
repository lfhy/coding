import { describe, expect, it } from 'vitest'
import { fitImage, ImageFitError, type ImageDimensions } from '../src/image-processing.ts'

describe('fitImage', () => {
  it('keeps compliant source bytes by identity without invoking an encoder', async () => {
    const data = Uint8Array.of(1, 2, 3)
    const output = await fitImage(data, { width: 2000, height: 1 }, {
      maxBytes: data.byteLength, maxPixels: 2000, maxDimension: 2000,
    }, { lossy: false, encode: async () => { throw new Error('encoder should not run') } })
    expect(output).toBe(data)
  })

  it('scales both axes without distortion for an oversized source below the byte cap', async () => {
    const targets: ImageDimensions[] = []
    const output = await fitImage(Uint8Array.of(1), { width: 2560, height: 1440 }, {
      maxBytes: 1024, maxPixels: 4_000_000, maxDimension: 2000,
    }, {
      lossy: false,
      async encode(target) { targets.push(target); return Uint8Array.of(7) },
    })
    expect(targets).toEqual([{ width: 2000, height: 1125, quality: 100 }])
    expect(output).toEqual(Uint8Array.of(7))
  })

  it('tries lossy quality before spatial reduction when only bytes overflow', async () => {
    const targets: Array<ImageDimensions & { quality: number }> = []
    await fitImage(new Uint8Array(20), { width: 200, height: 100 }, { maxBytes: 10 }, {
      lossy: true,
      async encode(target) {
        targets.push(target)
        return new Uint8Array(target.quality <= 55 ? 10 : 20)
      },
    })
    expect(targets).toEqual([
      { width: 200, height: 100, quality: 85 },
      { width: 200, height: 100, quality: 70 },
      { width: 200, height: 100, quality: 55 },
    ])
  })

  it('reaches an achievable one-pixel byte limit after bounded retries', async () => {
    const targets: ImageDimensions[] = []
    const output = await fitImage(new Uint8Array(1000), { width: 2000, height: 2000 }, {
      maxBytes: 270,
    }, {
      lossy: true,
      async encode(target) {
        targets.push(target)
        return new Uint8Array(target.width === 1 && target.height === 1 ? 269 : 300)
      },
    })
    expect(output.byteLength).toBe(269)
    expect(targets.at(-1)).toMatchObject({ width: 1, height: 1 })
    expect(targets.length).toBeLessThanOrEqual(40)
  })

  it('fails explicitly when even the smallest image cannot fit, or dimensions are invalid', async () => {
    const encoder = { lossy: false, encode: async () => new Uint8Array(20) }
    await expect(fitImage(new Uint8Array(20), { width: 3, height: 2 }, { maxBytes: 1 }, encoder))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await expect(fitImage(Uint8Array.of(1), { width: 0, height: 2 }, { maxBytes: 1 }, encoder))
      .rejects.toBeInstanceOf(ImageFitError)
  })
})
