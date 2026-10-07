import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { detectImage, normalizeImage, probeImage } from '../src/image.ts'

const SOURCE_LIMITS = { maxSourceBytes: 1024 * 1024, maxSourcePixels: 100_000, maxSourceFrames: 10 }

async function raster(format: 'png' | 'jpeg' | 'webp' | 'gif'): Promise<Uint8Array> {
  const image = sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
  return new Uint8Array(await image.toFormat(format).toBuffer())
}

async function animation(format: 'gif' | 'webp'): Promise<Uint8Array> {
  const pixels = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    pixels[i * 4] = i < 8 ? 255 : 0
    pixels[i * 4 + 1] = i < 8 ? 0 : 255
    pixels[i * 4 + 3] = 255
  }
  return new Uint8Array(await sharp(pixels, { raw: { width: 4, height: 4, pageHeight: 2, channels: 4 } })
    .toFormat(format, { loop: 0, delay: [100, 250] }).toBuffer())
}

describe('raster decoding', () => {
  it('decodes every supported format and its intrinsic dimensions', async () => {
    for (const [format, mediaType] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['gif', 'image/gif'],
    ] as const) {
      await expect(detectImage(await raster(format)))
        .resolves.toEqual({ mediaType, width: 3, height: 2 })
    }
  })

  it('rejects excess decoded pixels before decoding', async () => {
    await expect(detectImage(await raster('png'), { maxPixels: 5 }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
  })

  it('rejects a side above the per-side limit and accepts a side exactly at it', async () => {
    await expect(detectImage(await raster('png'), { maxDimension: 2 }))
      .rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    await expect(detectImage(await raster('png'), { maxDimension: 3 }))
      .resolves.toEqual({ mediaType: 'image/png', width: 3, height: 2 })
  })

  it('rejects malformed bytes and truncated payloads with readable headers', async () => {
    await expect(detectImage(Uint8Array.of(1, 2, 3)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    const unsupported = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).tiff().toBuffer()
    await expect(detectImage(unsupported)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    const complete = await raster('png')
    const truncated = complete.subarray(0, 62)
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({ width: 3, height: 2 })
    await expect(detectImage(truncated)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('probes malformed bytes and unsupported formats into the same stable error', async () => {
    await expect(probeImage(Uint8Array.of(1, 2, 3)))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    const unsupported = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).tiff().toBuffer()
    await expect(probeImage(unsupported)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })
})

describe('image normalization', () => {
  it('keeps an image at the exact limit byte-identical', async () => {
    const data = await raster('png')
    const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: data.byteLength, maxPixels: 6, maxDimension: 3 })
    expect(output.data).toBe(data)
    expect(output.metadata).toEqual({ mediaType: 'image/png', width: 3, height: 2 })
  })

  it('recompresses byte-only PNG and JPEG overflow within their original formats', async () => {
    const pixels = Buffer.alloc(96 * 96 * 4)
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 71 + (i >>> 3) * 19) & 255
    for (const [format, mediaType] of [['png', 'image/png'], ['jpeg', 'image/jpeg']] as const) {
      const data = await sharp(pixels, { raw: { width: 96, height: 96, channels: 4 } })
        .toFormat(format, format === 'png' ? { compressionLevel: 0 } : { quality: 100 })
        .toBuffer()
      const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: 1600, maxPixels: 96 * 96, maxDimension: 96 })
      expect(output.data.byteLength).toBeLessThanOrEqual(1600)
      expect(output.metadata.mediaType).toBe(mediaType)
      expect(output.metadata.width).toBeLessThanOrEqual(96)
      expect(output.metadata.height).toBeLessThanOrEqual(96)
    }
  })

  it('preserves alpha when a large PNG is resized', async () => {
    const data = await sharp({
      create: { width: 80, height: 60, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    }).png().toBuffer()
    const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: 1024, maxPixels: 1600, maxDimension: 40 })
    const metadata = await sharp(output.data).metadata()
    const pixel = await sharp(output.data).raw().toBuffer()
    expect(metadata.hasAlpha).toBe(true)
    expect(pixel[3]).toBeGreaterThan(0)
    expect(pixel[3]).toBeLessThan(255)
    expect(output.metadata).toEqual({ mediaType: 'image/png', width: 40, height: 30 })
  })

  it('applies JPEG orientation before resize rather than dropping its orientation metadata', async () => {
    const data = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: 1024, maxPixels: 800, maxDimension: 30 })
    expect(output.metadata).toEqual({ mediaType: 'image/jpeg', width: 15, height: 30 })
    expect((await sharp(output.data).metadata()).orientation).toBeUndefined()
  })

  it('keeps shrinking a byte-limited 2000px JPEG until its achievable budget fits', async () => {
    const data = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: '#ff0000' },
    }).jpeg().toBuffer()
    const output = await normalizeImage(data, {
      ...SOURCE_LIMITS,
      maxSourcePixels: 5_000_000,
      maxBytes: 270,
    })
    expect(output.data.byteLength).toBeLessThanOrEqual(270)
    expect(output.metadata.mediaType).toBe('image/jpeg')
    expect(output.metadata.width).toBeLessThanOrEqual(10)
    expect(output.metadata.height).toBeLessThanOrEqual(10)
  })

  it('preserves animated GIF and WebP frames, delays, and loop on resize', async () => {
    for (const format of ['gif', 'webp'] as const) {
      const data = await animation(format)
      const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: 2048, maxPixels: 4, maxDimension: 2 })
      const metadata = await sharp(output.data, { animated: true }).metadata()
      expect(output.metadata).toEqual({ mediaType: `image/${format}`, width: 2, height: 1 })
      expect(metadata.pages).toBe(2)
      expect(metadata.delay).toEqual([100, 250])
      expect(metadata.loop).toBe(0)
    }
  })

  it('retains duplicate GIF frames instead of merging their durations', async () => {
    const pixels = Buffer.alloc(4 * 4 * 4, 255)
    const data = await sharp(pixels, { raw: { width: 4, height: 4, pageHeight: 2, channels: 4 } })
      .gif({ loop: 0, delay: [100, 250], keepDuplicateFrames: true }).toBuffer()
    expect((await sharp(data, { animated: true }).metadata()).pages).toBe(2)
    const output = await normalizeImage(data, { ...SOURCE_LIMITS, maxBytes: 2048, maxPixels: 4, maxDimension: 2 })
    const metadata = await sharp(output.data, { animated: true }).metadata()
    expect(metadata.pages).toBe(2)
    expect(metadata.delay).toEqual([100, 250])
  })

  it('rejects a truncated animation instead of accepting its readable header', async () => {
    const data = await animation('gif')
    await expect(normalizeImage(data.subarray(0, data.byteLength - 5), {
      ...SOURCE_LIMITS, maxBytes: 1024, maxPixels: 4, maxDimension: 2,
    })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('accepts previously supported JPEG and WebP padding but rejects truncated encodings', async () => {
    for (const format of ['jpeg', 'webp'] as const) {
      const source = await raster(format)
      const padded = Uint8Array.from(Buffer.concat([Buffer.from(source), Buffer.alloc(4)]))
      const unchanged = await normalizeImage(padded, { ...SOURCE_LIMITS, maxBytes: padded.byteLength })
      expect(unchanged.data).toBe(padded)
      const reduced = await normalizeImage(padded, { ...SOURCE_LIMITS, maxBytes: 1024, maxDimension: 2 })
      expect(reduced.metadata.mediaType).toBe(`image/${format}`)
      await expect(normalizeImage(source.subarray(0, source.byteLength - (format === 'jpeg' ? 2 : 1)), {
        ...SOURCE_LIMITS, maxBytes: 1024,
      })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    }
  })

  it('checks the raw byte cap before attempting to parse invalid encoded bytes', async () => {
    const data = Uint8Array.of(1, 2, 3, 4, 5)
    const limits = { ...SOURCE_LIMITS, maxSourceBytes: 4 }
    await expect(normalizeImage(data, { ...limits, maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await expect(detectImage(data, { source: limits }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
  })

  it('enforces decoded-pixel and frame guards before enlarging input into memory', async () => {
    const data = await raster('png')
    await expect(normalizeImage(data, {
      ...SOURCE_LIMITS, maxSourcePixels: 5, maxBytes: 1024,
    })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    const animated = await animation('gif')
    await expect(normalizeImage(animated, {
      ...SOURCE_LIMITS, maxSourceFrames: 1, maxBytes: 1024,
    })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
  })
})
